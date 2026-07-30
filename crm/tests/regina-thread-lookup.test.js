'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, seedContactAndDossier, seedDraftRow, sql } = require('./fixtures/regina-test-db');
const { findDraftByThread, findDraftedByThread } = require('../../regina/lib/thread-lookup');

test('findDraftByThread: returns null when thread_ts not found', async () => {
  const db = await buildTestDb();
  const row = await findDraftByThread(db, '9999.9999');
  assert.equal(row, null);
  await db.dispose();
});

test('findDraftByThread: returns row when matching regina draft exists', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId } = await seedDraftRow(db, { slack_thread_ts: '1700.0001' });
  const row = await findDraftByThread(db, '1700.0001');
  assert.ok(row);
  assert.equal(row.id, sendId);
  assert.equal(row.contact_name, 'Patricia Test');
  await db.dispose();
});

test('findDraftByThread: scoped to owning_agent=regina', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  // Insert a campaign with owning_agent=paulina and a send under it.
  await db.query(sql`
    INSERT INTO outreach_campaigns (name, slug, campaign_kind, owning_agent, status, landing_page_url)
    VALUES (${'p1'}, ${'p1'}, ${'cold_outbound'}, ${'paulina'}, ${'active'}, ${'https://x'})
  `);
  const [{ id: pCampaignId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  await db.query(sql`
    INSERT INTO outreach_sends (contact_id, campaign_id, status, send_method, draft_text,
      slack_thread_ts, sequence_step, body_full, body_preview, reminder_count)
    VALUES (${100}, ${pCampaignId}, ${'drafted'}, ${'manual_email'}, ${'paulina draft'},
      ${'1700.SHARED'}, ${1}, ${'paulina draft'}, ${'paulina draft'}, ${0})
  `);
  // Default lookup with agent='regina' should NOT find paulina's row.
  const row = await findDraftByThread(db, '1700.SHARED');
  assert.equal(row, null);
  await db.dispose();
});

test('findDraftedByThread: flags _stale_status when row is no longer drafted', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId } = await seedDraftRow(db, { slack_thread_ts: '1700.0002', status: 'sent' });
  const row = await findDraftedByThread(db, '1700.0002');
  assert.ok(row);
  assert.equal(row.id, sendId);
  assert.equal(row._stale_status, 'sent');
  await db.dispose();
});

test('findDraftedByThread: returns plain row when status is drafted', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  await seedDraftRow(db, { slack_thread_ts: '1700.0003', status: 'drafted' });
  const row = await findDraftedByThread(db, '1700.0003');
  assert.ok(row);
  assert.equal(row.status, 'drafted');
  assert.equal(row._stale_status, undefined);
  await db.dispose();
});
