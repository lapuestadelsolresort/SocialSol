'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { main } = require('../scripts/reconcile-email-conversations');

test('historical reconciliation backfills inbound and Sarah Sent replies only when an original Slack thread exists', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-reconcile-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`);
    await db.query(sql`CREATE TABLE outreach_campaigns (id INTEGER PRIMARY KEY, slug TEXT, name TEXT)`);
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY, contact_id INTEGER, campaign_id INTEGER,
      subject TEXT, sent_at TEXT, status TEXT, slack_channel_id TEXT,
      slack_message_ts TEXT, workflow_run_id TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    await db.query(sql`INSERT INTO contacts (id, name, email) VALUES
      (1, 'Threaded', 'threaded@example.com'), (2, 'Synthetic', 'synthetic@example.com')`);
    await db.query(sql`INSERT INTO outreach_campaigns (id, slug, name)
      VALUES (1, 'planner_partner_program_v1', 'Planner')`);
    await db.query(sql`INSERT INTO outreach_sends (
      id, contact_id, campaign_id, subject, sent_at, status, slack_channel_id, slack_message_ts
    ) VALUES
      (10, 1, 1, 'Planner partnership', '2026-08-12T18:20:00Z', 'opened', 'CPAULINA', '100.1'),
      (11, 2, 1, 'Synthetic check', '2026-08-12T18:21:00Z', 'delivered', NULL, NULL)`);
    const searchMailboxSinceDays = async () => ({
      inbox: [
        { id: 'in-threaded', threadId: 'g-thread', messageId: '<in-threaded@example.com>',
          inReplyTo: '<outreach@example.com>', references: '<outreach@example.com>',
          from: { address: 'threaded@example.com' }, to: 'sarah@example.com',
          subject: 'Re: Planner partnership', text: 'Yes', internalDate: '2026-08-13T01:00:00Z' },
        { id: 'in-synthetic', threadId: 'g-synthetic', messageId: '<in-synthetic@example.com>',
          inReplyTo: '<test@example.com>', references: '<test@example.com>',
          from: { address: 'synthetic@example.com' }, to: 'sarah@example.com',
          subject: 'Re: Synthetic check', text: 'Test', internalDate: '2026-08-13T01:01:00Z' },
      ],
      sent: [
        { id: 'out-threaded', threadId: 'g-thread', messageId: '<out-threaded@example.com>',
          inReplyTo: '<in-threaded@example.com>', references: '<outreach@example.com> <in-threaded@example.com>',
          from: { address: 'sarah@example.com' }, to: 'threaded@example.com',
          subject: 'Re: Planner partnership', text: 'Here are the rates.', internalDate: '2026-08-13T02:00:00Z' },
      ],
    });
    const dry = await main(['--days', '3650'], { db, searchMailboxSinceDays });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.created, 0);
    assert.equal(dry.matchedInbound, 2);
    assert.equal(dry.skippedWithoutSlackThread, 1);

    const applied = await main(['--apply', '--days', '3650'], { db, searchMailboxSinceDays });
    assert.equal(applied.created, 2);
    assert.equal(applied.matchedOutbound, 1);
    assert.equal(applied.skippedWithoutSlackThread, 1);
    const events = await db.query(sql`SELECT provider_message_id, direction, slack_thread_ts
      FROM email_threads ORDER BY provider_message_id`);
    assert.deepEqual(events.map(row => row.provider_message_id), ['in-threaded', 'out-threaded']);
    assert.ok(events.every(row => row.slack_thread_ts === '100.1'));
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
