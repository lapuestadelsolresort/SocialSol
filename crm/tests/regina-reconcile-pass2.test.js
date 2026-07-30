'use strict';
//
// Tests for the 14-day re-queue sweep + 3-strike auto-suppress.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, seedContactAndDossier, seedDraftRow, sql } = require('./fixtures/regina-test-db');
const { pass2RequeueSweep } = require('../../regina/scripts/gmail-reconcile');

const CFG = {
  reconciliation: {
    reminder_after_days: 14,
    max_reminders_before_suppress: 3,
  },
};

function makePostCollector() {
  const posts = [];
  const fn = async (channel, message, opts = {}) => {
    posts.push({ channel, message, threadTs: opts.threadTs || null });
    return { ok: true, ts: '1700.fake', channelId: channel, raw: null };
  };
  return { posts, fn };
}

async function ageDraft(db, sendId, ageDays) {
  const past = new Date(Date.now() - ageDays * 86400000).toISOString();
  await db.query(sql`
    UPDATE outreach_sends SET created_at = ${past} WHERE id = ${sendId}
  `);
}

test('pass2: skips drafts younger than reminder_after_days', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId } = await seedDraftRow(db, { slack_thread_ts: '1700.0001' });
  await ageDraft(db, sendId, 5); // 5 days old < 14
  const { posts, fn } = makePostCollector();
  const result = await pass2RequeueSweep(db, CFG, 'C_X', fn);
  assert.equal(result.scanned, 0);
  assert.equal(result.reminded, 0);
  assert.equal(result.suppressed, 0);
  assert.equal(posts.length, 0);
  await db.dispose();
});

test('pass2: posts reminder + bumps reminder_count when draft is 15d old', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId } = await seedDraftRow(db, { slack_thread_ts: '1700.0002' });
  await ageDraft(db, sendId, 15);
  const { posts, fn } = makePostCollector();
  const result = await pass2RequeueSweep(db, CFG, 'C_X', fn);
  assert.equal(result.reminded, 1);
  assert.equal(result.suppressed, 0);
  assert.equal(posts.length, 1);
  assert.match(posts[0].message, /unactioned \(1\/3\)/);
  assert.equal(posts[0].threadTs, '1700.0002');

  const [row] = await db.query(sql`SELECT reminder_count, last_reminded_at, status FROM outreach_sends WHERE id = ${sendId}`);
  assert.equal(row.reminder_count, 1);
  assert.ok(row.last_reminded_at);
  assert.equal(row.status, 'drafted');
  await db.dispose();
});

test('pass2: auto-suppresses + closes voice_drafts_log when reminder_count >= 3', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId, vdlId } = await seedDraftRow(db, { slack_thread_ts: '1700.0003' });
  await ageDraft(db, sendId, 60);
  await db.query(sql`
    UPDATE outreach_sends
    SET reminder_count = 3,
        last_reminded_at = ${new Date(Date.now() - 20 * 86400000).toISOString()}
    WHERE id = ${sendId}
  `);

  const { posts, fn } = makePostCollector();
  const result = await pass2RequeueSweep(db, CFG, 'C_X', fn);
  assert.equal(result.suppressed, 1);
  assert.equal(result.reminded, 0);
  assert.match(posts[0].message, /Auto-suppressed/);

  const [row] = await db.query(sql`SELECT status, skip_reason FROM outreach_sends WHERE id = ${sendId}`);
  assert.equal(row.status, 'rejected');
  assert.equal(row.skip_reason, 'auto_suppressed_unactioned_3x');

  const [vdl] = await db.query(sql`SELECT outcome FROM voice_drafts_log WHERE id = ${vdlId}`);
  assert.equal(vdl.outcome, 'discarded');
  await db.dispose();
});

test('pass2: does not double-remind when last_reminded_at is recent', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId } = await seedDraftRow(db, { slack_thread_ts: '1700.0004' });
  await ageDraft(db, sendId, 30);
  await db.query(sql`
    UPDATE outreach_sends
    SET reminder_count = 1,
        last_reminded_at = ${new Date(Date.now() - 2 * 86400000).toISOString()}
    WHERE id = ${sendId}
  `);
  const { posts, fn } = makePostCollector();
  const result = await pass2RequeueSweep(db, CFG, 'C_X', fn);
  // last_reminded_at < 14d ago → NOT re-reminded
  assert.equal(result.reminded, 0);
  assert.equal(posts.length, 0);
  await db.dispose();
});

test('pass2: skips non-regina drafts even if old', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  // Create a paulina campaign + send that is old.
  await db.query(sql`
    INSERT INTO outreach_campaigns (name, slug, campaign_kind, owning_agent, status, landing_page_url)
    VALUES (${'pcamp'}, ${'pcamp'}, ${'cold_outbound'}, ${'paulina'}, ${'active'}, ${'https://x'})
  `);
  const [{ id: pCampaign }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  const past = new Date(Date.now() - 30 * 86400000).toISOString();
  await db.query(sql`
    INSERT INTO outreach_sends (contact_id, campaign_id, status, send_method, draft_text,
      slack_thread_ts, created_at, sequence_step, body_full, body_preview, reminder_count)
    VALUES (${100}, ${pCampaign}, ${'drafted'}, ${'manual_email'}, ${'paulina old'},
      ${'1700.PAULINA'}, ${past}, ${1}, ${'p'}, ${'p'}, ${0})
  `);

  const { posts, fn } = makePostCollector();
  const result = await pass2RequeueSweep(db, CFG, 'C_X', fn);
  assert.equal(result.reminded, 0);
  assert.equal(result.suppressed, 0);
  await db.dispose();
});
