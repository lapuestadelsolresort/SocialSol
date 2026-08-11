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
  const now = new Date().toISOString();
  const leaseExpires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return db.tx(async tx => {
    const [candidate] = await tx.query(sql`SELECT * FROM workflow_outbox
      WHERE status IN ('pending','retry') AND available_at <= ${now}
        AND (lease_expires_at IS NULL OR lease_expires_at < ${now})
      ORDER BY created_at, id LIMIT 1`);
    if (!candidate) return null;
    await tx.query(sql`UPDATE workflow_outbox SET
        status='leased', lease_owner=${owner}, lease_expires_at=${leaseExpires},
        attempts=attempts+1, updated_at=${now}
      WHERE id=${candidate.id} AND status IN ('pending','retry')`);
    const [claimed] = await tx.query(sql`SELECT * FROM workflow_outbox WHERE id=${candidate.id} AND lease_owner=${owner}`);
    return claimed || null;
  });
}

async function completeOutbox(db, row) {
  const now = new Date().toISOString();
  await db.query(sql`UPDATE workflow_outbox SET
    status='completed', completed_at=${now}, updated_at=${now},
    lease_owner=NULL, lease_expires_at=NULL, last_error=NULL
    WHERE id=${row.id}`);
}

async function failOutbox(db, row, error) {
  const now = new Date().toISOString();
  const dead = row.attempts >= row.max_attempts;
  const availableAt = new Date(Date.now() + backoffSeconds(row.attempts) * 1000).toISOString();
  await db.query(sql`UPDATE workflow_outbox SET
    status=${dead ? 'dead' : 'retry'}, available_at=${availableAt},
    updated_at=${now}, lease_owner=NULL, lease_expires_at=NULL,
    last_error=${String(error?.message || error || 'outbox error').slice(0, 1000)}
    WHERE id=${row.id}`);
}

async function deliverSlackNotification(db, row, payload, services = {}) {
  const post = services.postToChannel || postToChannel;
  const result = await post(payload.channelId, payload.message, {
    threadTs: payload.threadTs || null,
    account: payload.account || process.env.OPENCLAW_SLACK_ACCOUNT || '',
  });
  if (!result.ok) throw new Error(result.error || 'Slack notification failed');
  if (payload.metaMessageId && result.ts) {
    await db.query(sql`UPDATE meta_messages SET slack_thread_ts=${result.ts}
      WHERE id=${Number(payload.metaMessageId)}`);
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
      await failOutbox(db, row, error);
      summary.failed += 1;
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
