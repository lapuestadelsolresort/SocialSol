'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { executeGraph, startGraph } = require('../lib/workflow-engine');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const {
  applyClassification,
  confirmDefinition,
  observeDefinition,
  proposeDefinition,
} = require('../workflows/email-reply');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-reply-workflow-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await db.query(sql`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, name TEXT, email TEXT, status TEXT,
      email_status TEXT, do_not_contact INTEGER DEFAULT 0,
      do_not_contact_reason TEXT, reply_status TEXT, lead_quality TEXT,
      updated_at TEXT
    )`);
    await db.query(sql`CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY, slug TEXT, name TEXT
    )`);
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY, contact_id INTEGER, campaign_id INTEGER,
      subject TEXT, sent_at TEXT, status TEXT, reply_detected_at TEXT,
      slack_channel_id TEXT, slack_message_ts TEXT, workflow_run_id TEXT
    )`);
    await db.query(sql`CREATE TABLE suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
      email TEXT UNIQUE NOT NULL, reason TEXT NOT NULL, source TEXT,
      notes TEXT, added_by TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    await db.query(sql`INSERT INTO contacts (
      id, name, email, status, do_not_contact, do_not_contact_reason,
      reply_status, lead_quality
    ) VALUES (
      7, 'Gretel', 'gretel@example.com', 'dead', 1, 'negative_reply',
      'negative', 'not_interested'
    )`);
    await db.query(sql`INSERT INTO suppressions (email, reason, source, notes)
      VALUES ('gretel@example.com', 'negative_reply', 'reply_classify',
        'Legacy full-body classifier saw quoted unsubscribe footer')`);
    await db.query(sql`INSERT INTO outreach_campaigns (id, slug, name)
      VALUES (3, 'planner_partner_program_v1', 'Planner partners')`);
    await db.query(sql`INSERT INTO outreach_sends (
      id, contact_id, campaign_id, subject, sent_at, status,
      slack_channel_id, slack_message_ts
    ) VALUES (
      10339, 7, 3, 'A planner partnership', '2026-08-12T18:20:00.055Z',
      'opened', 'CPAULINA', '1786549495.693669'
    )`);
    await db.query(sql`INSERT INTO email_threads (
      contact_id, outreach_send_id, direction, subject, body_text, raw_body_text,
      from_address, to_address, received_at, provider, provider_message_id,
      provider_thread_id, rfc_message_id, in_reply_to, references_header,
      processing_status, slack_channel_id, slack_thread_ts
    ) VALUES (
      7, 10339, 'inbound', 'Re: A planner partnership',
      'We’re excited about it. This is exactly what we want.',
      'We’re excited about it. This is exactly what we want.\n\nOn Wed, Sarah wrote:\n> Unsubscribe',
      'gretel@example.com', 'sarah@example.com', '2026-08-13T03:59:00.000Z',
      'gmail', 'gmail-in-1', 'gmail-thread-1', '<reply-1@example.com>',
      '<original@example.com>', '<original@example.com>', 'pending',
      'CPAULINA', '1786549495.693669'
    )`);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('observed replies repair legacy quoted-footer false negatives and notify the original thread', async () => {
  await withDb(async db => {
    const [event] = await db.query(sql`SELECT * FROM email_threads WHERE provider_message_id='gmail-in-1'`);
    const run = await startGraph(db, observeDefinition, {
      idempotencyKey: 'email:gmail:gmail-in-1:observe',
      triggerType: 'system', triggerRef: `email-thread:${event.id}`,
      input: { emailThreadId: event.id },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.classification.quality, 'hot');
    const [contact] = await db.query(sql`SELECT * FROM contacts WHERE id=7`);
    assert.equal(contact.status, 'replied');
    assert.equal(contact.reply_status, 'positive');
    assert.equal(contact.lead_quality, 'hot');
    assert.equal(contact.do_not_contact, 0);
    assert.equal(contact.do_not_contact_reason, null);
    const [{ count: suppressionCount }] = await db.query(sql`SELECT COUNT(*) AS count FROM suppressions`);
    assert.equal(suppressionCount, 0);
    const [outbox] = await db.query(sql`SELECT * FROM workflow_outbox WHERE run_id=${run.id}`);
    const payload = JSON.parse(outbox.payload_json);
    assert.equal(payload.channelId, 'CPAULINA');
    assert.equal(payload.threadTs, '1786549495.693669');
    assert.match(payload.message, /Classification: \*hot\*/);
    assert.match(payload.message, /false-negative suppression was removed/);
  });
});

test('re-observation repairs this classifier\'s exact collapsed-quote false negative', async () => {
  await withDb(async db => {
    const [event] = await db.query(sql`SELECT * FROM email_threads WHERE provider_message_id='gmail-in-1'`);
    const collapsed = "Like wise if you need a planner&nbsp; Robin&nbsp; On May 20, 2026, at 4:45 PM, Sarah &lt;sarah@example.com&gt; wrote: Hi there. Reply 'unsubscribe' to unsubscribe@example.com.";
    await db.query(sql`UPDATE email_threads SET body_text=${collapsed}, raw_body_text=${collapsed},
      sentiment='not_interested', sentiment_notes='unsubscribe',
      classification_source='email_conversation_classifier', processing_status='pending'
      WHERE id=${event.id}`);
    await db.query(sql`UPDATE suppressions SET source='email_conversation_classifier',
      notes=${`Email event #${event.id} classified not_interested`}
      WHERE email='gretel@example.com'`);

    const run = await startGraph(db, observeDefinition, {
      idempotencyKey: 'email:gmail:gmail-in-1:observe:v2',
      triggerType: 'system', triggerRef: `email-thread:${event.id}:repair`,
      input: { emailThreadId: event.id },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.classification.quality, 'ambiguous');
    const [contact] = await db.query(sql`SELECT * FROM contacts WHERE id=7`);
    assert.equal(contact.status, 'replied');
    assert.equal(contact.reply_status, 'ambiguous');
    assert.equal(contact.lead_quality, 'ambiguous');
    assert.equal(contact.do_not_contact, 0);
    assert.equal(contact.do_not_contact_reason, null);
    const [{ count: suppressionCount }] = await db.query(sql`SELECT COUNT(*) AS count FROM suppressions`);
    assert.equal(suppressionCount, 0);
    const [outbox] = await db.query(sql`SELECT * FROM workflow_outbox WHERE run_id=${run.id}`);
    const payload = JSON.parse(outbox.payload_json);
    assert.equal(payload.threadTs, '1786549495.693669');
    assert.match(payload.message, /classification corrected/i);
    assert.match(payload.message, /Previous classification: \*not_interested\*/);
    assert.match(payload.message, /Classification: \*ambiguous\*/);
    assert.match(payload.message, /false-negative suppression was removed/);
  });
});

test('Slack email replies require same-user, same-thread confirmation and Gmail Sent readback', async () => {
  await withDb(async db => {
    const proposalRun = await startGraph(db, proposeDefinition, {
      idempotencyKey: 'slack:CPAULINA:200.1:email.reply.propose',
      triggerType: 'slack_email_reply_command', triggerRef: '200.1',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: {
        threadTs: '1786549495.693669',
        message: 'Wonderful—we would love to share the planner packet and available dates.',
      },
    });
    assert.equal(proposalRun.status, 'completed', proposalRun.error_message);
    assert.equal(proposalRun.output.status, 'awaiting_explicit_confirmation');
    assert.match(proposalRun.output.bodyText, /planner packet/);

    const wrongThread = await startGraph(db, confirmDefinition, {
      idempotencyKey: 'slack:CPAULINA:200.2:email.reply.confirm',
      triggerType: 'slack_email_confirm_command', triggerRef: '200.2',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: {
        proposalId: proposalRun.output.proposalId,
        acceptanceHash: proposalRun.output.confirmationCommand.split(' ').at(-1),
        threadTs: 'wrong-thread',
      },
    });
    assert.equal(wrongThread.status, 'failed');
    assert.match(wrongThread.error_message, /wrong Slack thread/);
    const [stillPending] = await db.query(sql`SELECT status FROM email_reply_proposals
      WHERE id=${proposalRun.output.proposalId}`);
    assert.equal(stillPending.status, 'pending');

    let sends = 0;
    const services = {
      sendEmail: async input => {
        sends += 1;
        assert.equal(input.to, 'gretel@example.com');
        assert.equal(input.threadId, 'gmail-thread-1');
        assert.equal(input.inReplyTo, '<reply-1@example.com>');
        return { id: 'gmail-out-1', threadId: 'gmail-thread-1', labelIds: ['SENT'] };
      },
      readEmail: async id => ({
        id, threadId: 'gmail-thread-1', labelIds: ['SENT'],
        messageId: '<out-1@example.com>', from: { address: 'sarah@example.com' },
        to: 'Gretel <gretel@example.com>', subject: 'Re: A planner partnership',
        text: 'Wonderful—we would love to share the planner packet and available dates.',
        internalDate: '2026-08-13T04:30:00.000Z',
        inReplyTo: '<reply-1@example.com>', references: '<original@example.com> <reply-1@example.com>',
      }),
    };
    const confirmRequest = {
      idempotencyKey: 'slack:CPAULINA:200.3:email.reply.confirm',
      triggerType: 'slack_email_confirm_command', triggerRef: '200.3',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: {
        proposalId: proposalRun.output.proposalId,
        acceptanceHash: proposalRun.output.confirmationCommand.split(' ').at(-1),
        threadTs: '1786549495.693669',
      },
    };
    const confirmed = await startGraph(db, confirmDefinition, confirmRequest, services);
    const replay = await startGraph(db, confirmDefinition, confirmRequest, services);
    assert.equal(confirmed.status, 'completed', confirmed.error_message);
    assert.equal(confirmed.output.status, 'verified_by_readback');
    assert.equal(replay.id, confirmed.id);
    assert.equal(sends, 1);
    const [projection] = await db.query(sql`SELECT * FROM email_threads
      WHERE provider_message_id='gmail-out-1'`);
    assert.equal(projection.direction, 'outbound');
    assert.equal(projection.actor_user_id, 'U-SARAH');
    assert.equal(projection.slack_thread_ts, '1786549495.693669');
    const [proposal] = await db.query(sql`SELECT status, provider_message_id
      FROM email_reply_proposals WHERE id=${proposalRun.output.proposalId}`);
    assert.equal(proposal.status, 'completed');
    assert.equal(proposal.provider_message_id, 'gmail-out-1');
  });
});

test('ambiguous follow-ups do not downgrade an already-hot contact', async () => {
  await withDb(async db => {
    await db.query(sql`UPDATE contacts SET status='replied', reply_status='positive',
      lead_quality='hot', do_not_contact=0, do_not_contact_reason=NULL WHERE id=7`);
    const [event] = await db.query(sql`SELECT * FROM email_threads WHERE provider_message_id='gmail-in-1'`);
    await applyClassification(db, event, {
      quality: 'ambiguous', reason: 'no_deterministic_signal', confidence: 0.5,
    });
    const [contact] = await db.query(sql`SELECT reply_status, lead_quality FROM contacts WHERE id=7`);
    assert.equal(contact.reply_status, 'positive');
    assert.equal(contact.lead_quality, 'hot');
  });
});

test('a delayed Gmail Sent readback retries without sending the email twice', async () => {
  await withDb(async db => {
    const proposed = await startGraph(db, proposeDefinition, {
      idempotencyKey: 'email-readback-proposal', triggerType: 'slack_email_reply_command',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: { threadTs: '1786549495.693669', message: 'One message only.' },
    });
    let sends = 0;
    let reads = 0;
    const services = {
      sendEmail: async () => {
        sends += 1;
        return { id: 'gmail-delayed', threadId: 'gmail-thread-1' };
      },
      readEmail: async () => {
        reads += 1;
        if (reads === 1) throw new Error('eventual consistency');
        return {
          id: 'gmail-delayed', threadId: 'gmail-thread-1', labelIds: ['SENT'],
          messageId: '<gmail-delayed@example.com>', from: { address: 'sarah@example.com' },
          to: 'gretel@example.com', subject: 'Re: A planner partnership', text: 'One message only.',
          internalDate: '2026-08-13T04:30:00.000Z', inReplyTo: '<reply-1@example.com>',
          references: '<original@example.com> <reply-1@example.com>',
        };
      },
    };
    const first = await startGraph(db, confirmDefinition, {
      idempotencyKey: 'email-readback-confirm', triggerType: 'slack_email_confirm_command',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: {
        proposalId: proposed.output.proposalId,
        acceptanceHash: proposed.output.confirmationCommand.split(' ').at(-1),
        threadTs: '1786549495.693669',
      },
    }, services);
    assert.equal(first.status, 'retry');
    assert.equal(first.effects[0].status, 'accepted_by_provider');
    assert.equal(sends, 1);
    await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
      WHERE run_id=${first.id} AND step_key='verify_readback'`);
    const completed = await executeGraph(db, confirmDefinition, first.id, services);
    assert.equal(completed.status, 'completed', completed.error_message);
    assert.equal(sends, 1);
    assert.equal(reads, 2);
  });
});
