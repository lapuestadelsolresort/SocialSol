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
  emailBodyFromSlack,
  observeDefinition,
  proposeDefinition,
} = require('../workflows/email-reply');
const { auditClassifications } = require('../scripts/reconcile-email-classifications');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-reply-workflow-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await db.query(sql`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, name TEXT, email TEXT, status TEXT,
      email_status TEXT, do_not_contact INTEGER DEFAULT 0,
      do_not_contact_reason TEXT, reply_status TEXT, lead_quality TEXT,
      updated_at TEXT, dedup_key TEXT UNIQUE, source TEXT, context_source TEXT,
      relationship_type TEXT, contact_provenance TEXT, preferred_channel TEXT,
      addressable INTEGER, notes TEXT
    )`);
    await db.query(sql`CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
      name TEXT, email TEXT, source TEXT, status TEXT, inquiry_message TEXT, notes TEXT
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
    await db.query(sql`INSERT INTO workflow_outbox (
      id, topic, idempotency_key, payload_json, status, completed_at
    ) VALUES (
      'old-email-notification', 'slack.notification',
      ${`email-thread:${event.id}:slack`}, '{}', 'completed', datetime('now')
    )`);

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
    assert.equal(outbox.idempotency_key,
      `email-thread:${event.id}:classification:ambiguous:no_deterministic_signal:v4:slack`);
    const payload = JSON.parse(outbox.payload_json);
    assert.equal(payload.threadTs, '1786549495.693669');
    assert.match(payload.message, /classification corrected/i);
    assert.match(payload.message, /Previous classification: \*not_interested\*/);
    assert.match(payload.message, /Classification: \*ambiguous\*/);
    assert.match(payload.message, /false-negative suppression was removed/);
  });
});

test('historical audit requeues a correct negative status whose quoted-footer reason is stale', async () => {
  await withDb(async db => {
    const [event] = await db.query(sql`SELECT * FROM email_threads WHERE provider_message_id='gmail-in-1'`);
    const collapsed = "Thank you but we are in the process of retiring. Jo Ann. On May 22, 2026, Sarah wrote: Reply 'unsubscribe' to unsubscribe@example.com.";
    await db.query(sql`UPDATE email_threads SET body_text='Thank you but we are in the process of retiring. Jo Ann.',
      raw_body_text=${collapsed}, sentiment='not_interested', sentiment_notes='unsubscribe',
      classification_source='email_conversation_classifier', processing_status='processed'
      WHERE id=${event.id}`);

    const changes = await auditClassifications(db);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].classificationChanged, false);
    assert.equal(changes[0].reasonChanged, true);
    assert.equal(changes[0].requiresRequeue, true);
    assert.equal(changes[0].reason, 'retiring');
  });
});

test('re-observation corrects a stale reason in the original Slack thread', async () => {
  await withDb(async db => {
    const [event] = await db.query(sql`SELECT * FROM email_threads WHERE provider_message_id='gmail-in-1'`);
    const collapsed = "Thank you but we are in the process of retiring. Jo Ann. On May 22, 2026, Sarah wrote: Reply 'unsubscribe' to unsubscribe@example.com.";
    await db.query(sql`UPDATE email_threads SET body_text='Thank you but we are in the process of retiring. Jo Ann.',
      raw_body_text=${collapsed}, sentiment='not_interested', sentiment_notes='unsubscribe',
      classification_source='email_conversation_classifier', processing_status='pending'
      WHERE id=${event.id}`);

    const run = await startGraph(db, observeDefinition, {
      idempotencyKey: 'email:gmail:gmail-in-1:observe:v3',
      triggerType: 'system', triggerRef: `email-thread:${event.id}:reason-repair`,
      input: { emailThreadId: event.id },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.classification.quality, 'not_interested');
    assert.equal(run.output.classification.reason, 'retiring');
    const [updated] = await db.query(sql`SELECT sentiment, sentiment_notes FROM email_threads WHERE id=${event.id}`);
    assert.equal(updated.sentiment, 'not_interested');
    assert.equal(updated.sentiment_notes, 'retiring');
    const [contact] = await db.query(sql`SELECT * FROM contacts WHERE id=7`);
    assert.equal(contact.status, 'dead');
    assert.equal(contact.do_not_contact, 1);
    const [outbox] = await db.query(sql`SELECT * FROM workflow_outbox WHERE run_id=${run.id}`);
    assert.equal(outbox.idempotency_key,
      `email-thread:${event.id}:classification:not_interested:retiring:v4:slack`);
    const payload = JSON.parse(outbox.payload_json);
    assert.equal(payload.threadTs, '1786549495.693669');
    assert.match(payload.message, /Previous classification: \*not_interested\* \(unsubscribe\)/);
    assert.match(payload.message, /Classification: \*not_interested\* \(retiring\)/);
  });
});

test('Slack email replies require same-user, same-channel confirmation and Gmail Sent readback', async () => {
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
    assert.equal(proposalRun.output.doesNotExpire, true);
    assert.equal(proposalRun.output.expiresAt, undefined);
    assert.match(proposalRun.output.bodyText, /planner packet/);
    const [pendingProposal] = await db.query(sql`SELECT expires_at FROM email_reply_proposals
      WHERE id=${proposalRun.output.proposalId}`);
    assert.equal(pendingProposal.expires_at, null);

    const wrongChannel = await startGraph(db, confirmDefinition, {
      idempotencyKey: 'slack:CPAULINA:200.2:email.reply.confirm',
      triggerType: 'slack_email_confirm_command', triggerRef: '200.2',
      channelId: 'WRONG-CHANNEL', actorUserId: 'U-SARAH',
      input: {
        proposalId: proposalRun.output.proposalId,
        acceptanceHash: proposalRun.output.confirmationCommand.split(' ').at(-1),
      },
    });
    assert.equal(wrongChannel.status, 'failed');
    assert.match(wrongChannel.error_message, /wrong Slack channel/);
    const [stillPending] = await db.query(sql`SELECT status FROM email_reply_proposals
      WHERE id=${proposalRun.output.proposalId}`);
    assert.equal(stillPending.status, 'pending');
    await db.query(sql`UPDATE email_reply_proposals SET expires_at='1970-01-01T00:00:00.000Z'
      WHERE id=${proposalRun.output.proposalId}`);

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

test('Slack link markup becomes readable plain-text email content', () => {
  assert.equal(emailBodyFromSlack([
    'Watch <https://youtu.be/LmQ4tUf1K9U|youtu.be/…>',
    'Email <mailto:sarah@example.com|Sarah>',
    'Call <tel:+18313458082|+1 831-345-8082>',
  ].join('\n')), [
    'Watch https://youtu.be/LmQ4tUf1K9U',
    'Email Sarah',
    'Call +1 831-345-8082',
  ].join('\n'));
});

test('confirmation normalizes Slack markup saved by a legacy proposal', async () => {
  await withDb(async db => {
    const proposed = await startGraph(db, proposeDefinition, {
      idempotencyKey: 'slack:CPAULINA:legacy-markup:email.reply.propose',
      triggerType: 'slack_email_reply_command', triggerRef: 'legacy-markup-propose',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: { threadTs: '1786549495.693669', message: 'Legacy placeholder' },
    });
    const legacyBody = [
      'Watch <https://www.youtube.com/watch?v=LmQ4tUf1K9U|youtube.com/watch?v=…>',
      'Call <tel:+18313458082|+1 831-345-8082>',
    ].join('\n');
    const deliveryBody = [
      'Watch https://www.youtube.com/watch?v=LmQ4tUf1K9U',
      'Call +1 831-345-8082',
    ].join('\n');
    await db.query(sql`UPDATE email_reply_proposals SET body_text=${legacyBody}
      WHERE id=${proposed.output.proposalId}`);

    const confirmed = await startGraph(db, confirmDefinition, {
      idempotencyKey: 'slack:CPAULINA:legacy-markup:email.reply.confirm',
      triggerType: 'slack_email_confirm_command', triggerRef: 'legacy-markup-confirm',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: {
        proposalId: proposed.output.proposalId,
        acceptanceHash: proposed.output.confirmationCommand.split(' ').at(-1),
        threadTs: '1786549495.693669',
      },
    }, {
      sendEmail: async input => {
        assert.equal(input.body, deliveryBody);
        return { id: 'gmail-out-legacy-markup', threadId: 'gmail-thread-1', labelIds: ['SENT'] };
      },
      readEmail: async id => ({
        id, threadId: 'gmail-thread-1', labelIds: ['SENT'],
        messageId: '<out-legacy-markup@example.com>', from: { address: 'sarah@example.com' },
        to: 'Gretel <gretel@example.com>', subject: 'Re: A planner partnership',
        text: deliveryBody, internalDate: '2026-08-13T04:30:00.000Z',
        inReplyTo: '<reply-1@example.com>', references: '<original@example.com> <reply-1@example.com>',
      }),
    });
    assert.equal(confirmed.status, 'completed', confirmed.error_message);
    const [proposal] = await db.query(sql`SELECT body_text FROM email_reply_proposals
      WHERE id=${proposed.output.proposalId}`);
    assert.equal(proposal.body_text, deliveryBody);
    const [projection] = await db.query(sql`SELECT body_text FROM email_threads
      WHERE provider_message_id='gmail-out-legacy-markup'`);
    assert.equal(projection.body_text, deliveryBody);
  });
});

test('reply proposals use the original outreach subject instead of inbound mojibake', async () => {
  await withDb(async db => {
    await db.query(sql`UPDATE outreach_sends SET
      subject='La Puesta del Sol — 10% referral commission, Riviera Nayarit'
      WHERE id=10339`);
    await db.query(sql`UPDATE email_threads SET
      subject='Re: La Puesta del Sol Ã¢Â€Â” 10% referral commission, Riviera Nayarit'
      WHERE provider_message_id='gmail-in-1'`);
    const run = await startGraph(db, proposeDefinition, {
      idempotencyKey: 'slack:CPAULINA:subject-repair:email.reply.propose',
      triggerType: 'slack_email_reply_command', triggerRef: 'subject-repair',
      channelId: 'CPAULINA', actorUserId: 'U-SARAH',
      input: { threadTs: '1786549495.693669', message: 'How about 5?' },
    });
    assert.equal(run.status, 'completed', run.error_message);
    const [proposal] = await db.query(sql`SELECT subject FROM email_reply_proposals
      WHERE id=${run.output.proposalId}`);
    assert.equal(proposal.subject,
      'Re: La Puesta del Sol — 10% referral commission, Riviera Nayarit');
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

test('new direct Gmail mail creates one CRM inquiry and a dedicated Slack conversation root', async () => {
  await withDb(async db => {
    const [event] = await db.query(sql`INSERT INTO email_threads (
      direction, subject, body_text, raw_body_text, from_address, sender_name,
      to_address, received_at, provider, provider_message_id, provider_thread_id,
      processing_status, slack_channel_id
    ) VALUES (
      'inbound', 'Wedding availability', 'Do you host 40-person weddings?',
      'Do you host 40-person weddings?', 'guest@example.net', 'Taylor Guest',
      'sarah@example.com', '2026-08-13T18:00:00Z', 'gmail', 'gmail-direct-1',
      'gmail-direct-thread', 'pending', 'CEMAIL'
    ) RETURNING *`);
    const run = await startGraph(db, observeDefinition, {
      idempotencyKey: 'email:gmail:gmail-direct-1:observe:v4',
      triggerType: 'system', triggerRef: `email-thread:${event.id}`,
      input: { emailThreadId: event.id },
    });
    assert.equal(run.status, 'completed', run.error_message);
    const [projected] = await db.query(sql`SELECT contact_id, crm_lead_id FROM email_threads WHERE id=${event.id}`);
    assert.ok(projected.contact_id);
    assert.ok(projected.crm_lead_id);
    const [outbox] = await db.query(sql`SELECT payload_json FROM workflow_outbox WHERE run_id=${run.id}`);
    const payload = JSON.parse(outbox.payload_json);
    assert.equal(payload.channelId, 'CEMAIL');
    assert.equal(payload.threadTs, null);
    assert.deepEqual(payload.emailConversation, { provider: 'gmail', providerThreadId: 'gmail-direct-thread' });
    assert.match(payload.message, /CRM lead/);
    assert.match(payload.message, /!email reply/);
  });
});

test('Gmail Spam remains visible without creating a CRM inquiry', async () => {
  await withDb(async db => {
    const [event] = await db.query(sql`INSERT INTO email_threads (
      direction, subject, body_text, raw_body_text, from_address, sender_name,
      to_address, received_at, provider, provider_message_id, provider_thread_id,
      provider_metadata_json, processing_status, slack_channel_id
    ) VALUES (
      'inbound', 'Urgent offer', 'Click this questionable link',
      'Click this questionable link', 'promoter@example.net', 'Promoter',
      'sarah@example.com', '2026-08-13T18:01:00Z', 'gmail', 'gmail-spam-1',
      'gmail-spam-thread', '{"labelIds":["SPAM"]}', 'pending', 'CEMAIL'
    ) RETURNING *`);
    const run = await startGraph(db, observeDefinition, {
      idempotencyKey: 'email:gmail:gmail-spam-1:observe:v4',
      triggerType: 'system', triggerRef: `email-thread:${event.id}`,
      input: { emailThreadId: event.id },
    });
    assert.equal(run.status, 'completed', run.error_message);
    const [projected] = await db.query(sql`SELECT contact_id, crm_lead_id FROM email_threads WHERE id=${event.id}`);
    assert.equal(projected.contact_id, null);
    assert.equal(projected.crm_lead_id, null);
    const [outbox] = await db.query(sql`SELECT payload_json FROM workflow_outbox WHERE run_id=${run.id}`);
    const payload = JSON.parse(outbox.payload_json);
    assert.match(payload.message, /Visibility only/);
    assert.match(payload.message, /!email reply/);
  });
});

test('OwnerRez replies use the same proposal protocol with provider readback and one send', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO email_threads (
      direction, subject, body_text, raw_body_text, from_address, sender_name,
      to_address, received_at, provider, provider_message_id, provider_thread_id,
      provider_metadata_json, processing_status, slack_channel_id, slack_thread_ts,
      slack_message_ts
    ) VALUES (
      'inbound', 'Vrbo guest conversation', 'Is the villa available in October?',
      'Is the villa available in October?', 'ownerrez:guest:42', 'Morgan Guest',
      'ownerrez:host', '2026-08-13T18:05:00Z', 'ownerrez', '112025557', '884422',
      '{"channel":"vrbo"}', 'processed', 'CEMAIL', '300.1', '300.1'
    )`);
    const proposed = await startGraph(db, proposeDefinition, {
      idempotencyKey: 'slack:CEMAIL:300.2:email.reply.propose',
      triggerType: 'slack_email_reply_command', triggerRef: '300.2',
      channelId: 'CEMAIL', actorUserId: 'U-SARAH',
      input: { threadTs: '300.1', message: 'Yes—please share your preferred October dates.' },
    });
    assert.equal(proposed.status, 'completed', proposed.error_message);
    assert.equal(proposed.output.provider, 'ownerrez');
    let sends = 0;
    const confirmed = await startGraph(db, confirmDefinition, {
      idempotencyKey: 'slack:CEMAIL:300.3:email.reply.confirm',
      triggerType: 'slack_email_confirm_command', triggerRef: '300.3',
      channelId: 'CEMAIL', actorUserId: 'U-SARAH',
      input: {
        proposalId: proposed.output.proposalId,
        acceptanceHash: proposed.output.confirmationCommand.split(' ').at(-1),
        threadTs: '300.1',
      },
    }, {
      sendOwnerRezMessage: async input => {
        sends += 1;
        assert.equal(input.threadId, '884422');
        return { id: '112025999', threadId: '884422', body: input.body,
          internalDate: '2026-08-13T18:06:00Z', fromRole: 'owner', isDraft: false, removedAt: null };
      },
      readOwnerRezMessage: async (messageId, threadId) => ({
        id: messageId, threadId, body: 'Yes—please share your preferred October dates.',
        internalDate: '2026-08-13T18:06:00Z', fromRole: 'owner', isDraft: false, removedAt: null,
      }),
    });
    assert.equal(confirmed.status, 'completed', confirmed.error_message);
    assert.equal(confirmed.output.provider, 'ownerrez');
    assert.equal(sends, 1);
    assert.equal(confirmed.effects[0].provider, 'ownerrez');
    assert.equal(confirmed.effects[0].status, 'verified_by_readback');
    const [projection] = await db.query(sql`SELECT * FROM email_threads
      WHERE provider='ownerrez' AND provider_message_id='112025999'`);
    assert.equal(projection.direction, 'outbound');
    assert.equal(projection.slack_thread_ts, '300.1');
  });
});
