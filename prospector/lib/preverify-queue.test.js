'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { preverifyQueue } = require('../scripts/preverify-queue');

test('preverification prioritizes a named mailbox and records only safe results as verified', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paulina-preverify-'));
  const db = createDB(path.join(directory, 'test.db'));
  t.after(async () => {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.query(sql`
    CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY, slug TEXT, status TEXT, allow_role_emails INTEGER
    )
  `);
  await db.query(sql`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, email TEXT, email_status TEXT,
      do_not_contact INTEGER, updated_at TEXT
    )
  `);
  await db.query(sql`
    CREATE TABLE campaign_contacts (
      id INTEGER PRIMARY KEY, campaign_id INTEGER, contact_id INTEGER, attached_at TEXT
    )
  `);
  await db.query(sql`CREATE TABLE suppressions (id INTEGER PRIMARY KEY, email TEXT)`);
  await db.query(sql`
    CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY, campaign_id INTEGER, contact_id INTEGER, status TEXT
    )
  `);
  await db.query(sql`
    INSERT INTO outreach_campaigns (id, slug, status, allow_role_emails)
    VALUES (7, 'planner_partner_program_v1', 'active', 0)
  `);
  await db.query(sql`
    INSERT INTO contacts (id, email, email_status, do_not_contact)
    VALUES (1, 'info@example.com', 'unknown', 0),
           (2, 'sarah@example.com', 'unknown', 0)
  `);
  await db.query(sql`
    INSERT INTO campaign_contacts (id, campaign_id, contact_id, attached_at)
    VALUES (1, 7, 1, '2026-01-01'), (2, 7, 2, '2026-01-02')
  `);

  const result = await preverifyQueue(
    { campaignSlug: 'planner_partner_program_v1', targetValid: 1, maxChecks: 1, dryRun: false },
    {
      db,
      config: { email_verification: { fail_closed: true } },
      apiKey: 'test-key',
      resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'valid' }) }),
    },
  );

  assert.equal(result.checked, 1);
  assert.equal(result.verified, 1);
  assert.equal(result.target_met, true);
  const rows = await db.query(sql`SELECT id, email_status FROM contacts ORDER BY id`);
  assert.deepEqual(rows, [
    { id: 1, email_status: 'unknown' },
    { id: 2, email_status: 'verified' },
  ]);
});
