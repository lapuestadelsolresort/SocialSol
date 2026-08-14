'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { postToChannel } = require('./slack-post');
const { parseJson } = require('./workflow-store');

function backoffSeconds(attempts) {
  return Math.min(3600, 15 * (2 ** Math.max(0, attempts - 1)));
}

async function claimNext(db, { workerId, leaseSeconds = 60 } = {}) {
  const owner = workerId || `worker-${crypto.randomUUID()}`;
  const leaseToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const leaseExpires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return db.tx(async tx => {
    const [candidate] = await tx.query(sql`SELECT * FROM workflow_outbox
      WHERE ((status IN ('pending','retry') AND available_at <= ${now})
        OR (status='leased' AND lease_expires_at < ${now}))
      ORDER BY created_at, id LIMIT 1`);
    if (!candidate) return null;
    await tx.query(sql`UPDATE workflow_outbox SET
        status='leased', lease_owner=${owner}, lease_expires_at=${leaseExpires},
        lease_token=${leaseToken}, lease_version=lease_version+1,
        attempts=attempts+1, updated_at=${now}
      WHERE id=${candidate.id} AND ((status IN ('pending','retry') AND available_at <= ${now})
        OR (status='leased' AND lease_expires_at < ${now}))`);
    const [claimed] = await tx.query(sql`SELECT * FROM workflow_outbox
      WHERE id=${candidate.id} AND lease_owner=${owner} AND lease_token=${leaseToken}`);
    return claimed || null;
  });
}

async function completeOutbox(db, row) {
  const now = new Date().toISOString();
  await db.tx(async tx => {
    const [current] = await tx.query(sql`SELECT status, lease_token FROM workflow_outbox WHERE id=${row.id}`);
    if (!current || current.status !== 'leased' || current.lease_token !== row.lease_token) {
      const error = new Error('outbox lease was lost before completion');
      error.code = 'outbox_lease_lost';
      throw error;
    }
    await tx.query(sql`UPDATE workflow_outbox SET
      status='completed', completed_at=${now}, updated_at=${now},
      lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, last_error=NULL
      WHERE id=${row.id} AND status='leased' AND lease_token=${row.lease_token}`);
  });
}

async function failOutbox(db, row, error) {
  const now = new Date().toISOString();
  const dead = row.attempts >= row.max_attempts;
  const availableAt = new Date(Date.now() + backoffSeconds(row.attempts) * 1000).toISOString();
  await db.tx(async tx => {
    const [current] = await tx.query(sql`SELECT status, lease_token FROM workflow_outbox WHERE id=${row.id}`);
    if (!current || current.status !== 'leased' || current.lease_token !== row.lease_token) {
      const lost = new Error('outbox lease was lost before failure could be recorded');
      lost.code = 'outbox_lease_lost';
      throw lost;
    }
    await tx.query(sql`UPDATE workflow_outbox SET
      status=${dead ? 'dead' : 'retry'}, available_at=${availableAt},
      updated_at=${now}, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
      last_error=${String(error?.message || error || 'outbox error').slice(0, 1000)}
      WHERE id=${row.id} AND status='leased' AND lease_token=${row.lease_token}`);
  });
}

async function deliverSlackNotification(db, row, payload, services = {}) {
  const post = services.postToChannel || postToChannel;
  let threadTs = payload.threadTs || null;
  let conversationRows = [];
  if (!threadTs && payload.emailConversation?.provider && payload.emailConversation?.providerThreadId) {
    conversationRows = await db.query(sql`SELECT id, slack_thread_ts, slack_message_ts
      FROM email_threads
      WHERE provider=${String(payload.emailConversation.provider)}
        AND provider_thread_id=${String(payload.emailConversation.providerThreadId)}
        AND slack_channel_id=${String(payload.channelId)}
      ORDER BY id`);
    const root = conversationRows.find(event => event.slack_thread_ts || event.slack_message_ts);
    threadTs = root?.slack_thread_ts || root?.slack_message_ts || null;
    if (!threadTs && conversationRows[0]
        && Number(conversationRows[0].id) !== Number(payload.emailThreadId)) {
      const error = new Error('email conversation Slack root is not ready');
      error.code = 'email_slack_root_pending';
      throw error;
    }
  }
  const result = await post(payload.channelId, payload.message, {
    threadTs,
    account: payload.account || process.env.OPENCLAW_SLACK_ACCOUNT || '',
    presentation: payload.presentation || null,
    slackBlocks: payload.slackBlocks || null,
  });
  if (!result.ok) throw new Error(result.error || 'Slack notification failed');
  if (payload.metaMessageId && result.ts) {
    await db.query(sql`UPDATE meta_messages SET slack_thread_ts=${result.ts}
      WHERE id=${Number(payload.metaMessageId)}`);
  }
  if (payload.emailThreadId && result.ts) {
    await db.query(sql`UPDATE email_threads SET slack_message_ts=${result.ts},
      updated_at=datetime('now') WHERE id=${Number(payload.emailThreadId)}`);
  }
  if (payload.emailConversation?.provider && payload.emailConversation?.providerThreadId && result.ts) {
    const rootTs = threadTs || result.ts;
    await db.query(sql`UPDATE email_threads SET slack_channel_id=${String(payload.channelId)},
      slack_thread_ts=${rootTs}, updated_at=datetime('now')
      WHERE provider=${String(payload.emailConversation.provider)}
        AND provider_thread_id=${String(payload.emailConversation.providerThreadId)}`);
  }
  return result;
}

async function processOutboxRow(db, row, services = {}) {
  const payload = parseJson(row.payload_json, {});
  if (row.topic === 'slack.notification') {
    await deliverSlackNotification(db, row, payload, services);
  } else {
    const error = new Error(`unsupported outbox topic: ${row.topic}`);
    error.code = 'unsupported_outbox_topic';
    throw error;
  }
  await completeOutbox(db, row);
}

async function drainOutbox(db, { limit = 100, workerId, services = {} } = {}) {
  const summary = { claimed: 0, completed: 0, failed: 0 };
  for (let index = 0; index < limit; index += 1) {
    const row = await claimNext(db, { workerId });
    if (!row) break;
    summary.claimed += 1;
    try {
      await processOutboxRow(db, row, services);
      summary.completed += 1;
    } catch (error) {
      try {
        await failOutbox(db, row, error);
        summary.failed += 1;
      } catch (leaseError) {
        if (leaseError.code !== 'outbox_lease_lost') throw leaseError;
        // Another worker reclaimed the expired lease while this delivery was
        // in flight. The stale worker must not overwrite the new owner's state.
      }
    }
  }
  return summary;
}

module.exports = {
  backoffSeconds,
  claimNext,
  completeOutbox,
  deliverSlackNotification,
  drainOutbox,
  failOutbox,
  processOutboxRow,
};
