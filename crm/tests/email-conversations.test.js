'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const {
  classifyReply,
  ingestEmailEvent,
  resolveOutreachSend,
  stripQuotedHistory,
} = require('../lib/email-conversations');
const { ensureSchemaAsync } = require('../lib/workflow-schema');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-conversations-'));
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
      slack_channel_id TEXT, slack_message_ts TEXT
    )`);
    // Reproduce the pre-019 table so this also verifies the additive upgrade.
    await db.query(sql`CREATE TABLE email_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')), contact_id INTEGER,
      outreach_send_id INTEGER, direction TEXT NOT NULL, subject TEXT,
      body_text TEXT, body_html TEXT, resend_email_id TEXT, from_address TEXT,
      to_address TEXT, received_at TEXT, sentiment TEXT, sentiment_notes TEXT,
      forwarded_to TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('quoted outreach history is removed before deterministic classification', () => {
  const body = [
    'We’re excited about it. This is exactly what we want.',
    '',
    'On Wed, Aug 12, 2026 at 11:20 AM Sarah wrote:',
    '> We host planner retreats in Sayulita.',
    '> If this is not relevant, unsubscribe here.',
  ].join('\n');
  assert.equal(stripQuotedHistory(body), 'We’re excited about it. This is exactly what we want.');
  const result = classifyReply(body);
  assert.equal(result.quality, 'hot');
  assert.equal(result.reason, 'excited');
  assert.doesNotMatch(result.normalizedText, /unsubscribe/i);
});

test('a quoted unsubscribe footer cannot mark a reply not_interested', () => {
  const neutral = [
    'Thanks for reaching out.',
    '',
    'On Tue, Aug 11, 2026 at 9:00 AM Sarah wrote:',
    '> Hello from La Puesta del Sol.',
    '> Unsubscribe: https://example.invalid/u/123',
  ].join('\n');
  assert.equal(classifyReply(neutral).quality, 'ambiguous');
  assert.equal(classifyReply('No thanks. Please unsubscribe me.').quality, 'not_interested');
});

test('collapsed HTML reply history is removed before classification', () => {
  const reciprocal = "Like wise if you need a planner&nbsp; Robin&nbsp; On May 20, 2026, at 4:45 PM, Sarah &lt;sarah@example.com&gt; wrote: Hi there. Reply 'unsubscribe' to unsubscribe@example.com.";
  assert.equal(stripQuotedHistory(reciprocal), 'Like wise if you need a planner  Robin');
  assert.equal(classifyReply(reciprocal).quality, 'ambiguous');

  const retiring = "Thank you but we are in the process of retiring.&nbsp; Sent from my iPhone On May 22, 2026, at 10:22 PM, Sarah &lt;sarah@example.com&gt; wrote: Hi Jo Ann. Reply 'unsubscribe' to unsubscribe@example.com.";
  const result = classifyReply(retiring);
  assert.equal(result.quality, 'not_interested');
  assert.equal(result.reason, 'retiring');
  assert.doesNotMatch(result.normalizedText, /unsubscribe/i);
});

test('legacy email_threads upgrades and Gmail ingestion is matched and idempotent', async () => {
  await withDb(async db => {
    const columns = new Set((await db.query(sql`PRAGMA table_info(email_threads)`)).map(row => row.name));
    for (const name of ['provider_message_id', 'provider_thread_id', 'raw_body_text',
      'processing_status', 'slack_thread_ts', 'workflow_run_id']) {
      assert.equal(columns.has(name), true, name);
    }
    await db.query(sql`INSERT INTO contacts (id, name, email, status)
      VALUES (7, 'Planner', 'planner@example.com', 'contacted')`);
    await db.query(sql`INSERT INTO outreach_campaigns (id, slug, name)
      VALUES (3, 'planner_partner_program_v1', 'Planner partners')`);
    await db.query(sql`INSERT INTO outreach_sends (
      id, contact_id, campaign_id, subject, sent_at, status,
      slack_channel_id, slack_message_ts
    ) VALUES (
      10339, 7, 3, 'A planner partnership', '2026-08-12T18:20:00.055Z',
      'opened', 'CPAULINA', '1786549495.693669'
    )`);
    const message = {
      provider: 'gmail', providerMessageId: 'gmail-1', providerThreadId: 'thread-1',
      rfcMessageId: '<reply-1@example.com>', inReplyTo: '<original@example.com>',
      from: 'Gretel <planner@example.com>', to: 'Sarah <sarah@example.com>',
      subject: 'Re: A planner partnership',
      text: 'We are excited about it.\n\nOn Wed, Sarah wrote:\n> Unsubscribe here.',
      internalDate: '2026-08-13T03:59:00.000Z', direction: 'inbound',
    };
    const matched = await resolveOutreachSend(db, message);
    assert.equal(matched.id, 10339);
    const unrelated = await resolveOutreachSend(db, {
      ...message, providerMessageId: 'gmail-unrelated', subject: 'Re: Your vendor invoice',
    });
    assert.equal(unrelated, null);
    const first = await ingestEmailEvent(db, message);
    const replay = await ingestEmailEvent(db, message);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(first.event.body_text, 'We are excited about it.');
    assert.match(first.event.raw_body_text, /Unsubscribe/);
    assert.equal(first.event.slack_thread_ts, '1786549495.693669');
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM email_threads`);
    assert.equal(count, 1);
  });
});
