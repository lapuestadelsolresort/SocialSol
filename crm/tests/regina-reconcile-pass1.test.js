'use strict';
//
// Tests for Gmail Sent reconciliation (auto-mark / possible-match / no-match).
// Mocks searchSentSince via the deps param so no real Gmail calls happen.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, seedContactAndDossier, seedDraftRow, sql } = require('./fixtures/regina-test-db');
const { pass1Reconciliation } = require('../../regina/scripts/gmail-reconcile');

const CFG = {
  reconciliation: {
    lookback_days: 7,
    auto_mark_threshold: 0.6,
    possible_match_threshold: 0.4,
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

function fakeGmail(messagesByEmail) {
  return async (days, opts = {}) => {
    const to = (opts.toFilter || '').toLowerCase();
    return messagesByEmail[to] || [];
  };
}

const DRAFT = 'Hi Patricia, hope your summer is going well! — Sarah';

test('pass1: ≥0.6 similarity → auto-mark + voice_drafts_log sent_with_edits', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId, vdlId } = await seedDraftRow(db, {
    draft_text: DRAFT,
    slack_thread_ts: '1700.A1',
    slack_channel_id: 'C_TEST',
  });

  const fakeSearchSent = fakeGmail({
    'patricia@example.com': [{
      id: 'gmail_1',
      to: 'patricia@example.com',
      from: 'sarah@lapuestadelsolresort.com',
      subject: 'Catching up',
      body: 'Hi Patricia, hope your summer is going great! — Sarah',
      sent_at: '2026-05-09T14:00:00.000Z',
    }],
  });

  const { posts, fn } = makePostCollector();
  const hcPinged = { value: false };
  const result = await pass1Reconciliation(db, CFG, 'C_FALLBACK', fn, hcPinged, { searchSentSince: fakeSearchSent });

  assert.equal(result.autoMarked, 1);
  assert.equal(result.possibleMatches, 0);
  assert.equal(hcPinged.value, true, 'healthcheck pinged after Gmail success');

  const [row] = await db.query(sql`SELECT status, sent_text, edit_distance FROM outreach_sends WHERE id = ${sendId}`);
  assert.equal(row.status, 'sent');
  assert.match(row.sent_text, /summer is going great/);
  assert.ok(row.edit_distance > 0);

  const [vdl] = await db.query(sql`SELECT outcome, edit_distance FROM voice_drafts_log WHERE id = ${vdlId}`);
  assert.equal(vdl.outcome, 'sent_with_edits');
  assert.ok(vdl.edit_distance > 0);

  assert.ok(posts.find((p) => /Auto-reconciled/.test(p.message)));
  await db.dispose();
});

test('pass1: 0.4-0.6 similarity → possible match notification, no DB writes', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  const { sendId, vdlId } = await seedDraftRow(db, {
    draft_text: DRAFT,
    slack_thread_ts: '1700.A2',
  });

  // Heavily edited body — drops similarity into 0.4-0.6 band.
  const fakeSearchSent = fakeGmail({
    'patricia@example.com': [{
      id: 'gmail_2',
      to: 'patricia@example.com',
      from: 'sarah@lapuestadelsolresort.com',
      subject: 'Re: Last summer',
      body: 'Hi Patricia, summer is wrapping up. Drop me a line when you can!',
      sent_at: '2026-05-09T14:00:00.000Z',
    }],
  });

  const { posts, fn } = makePostCollector();
  const hcPinged = { value: false };
  const result = await pass1Reconciliation(db, CFG, 'C_X', fn, hcPinged, { searchSentSince: fakeSearchSent });

  assert.equal(result.autoMarked, 0);
  assert.equal(result.possibleMatches, 1);

  const [row] = await db.query(sql`SELECT status, sent_text FROM outreach_sends WHERE id = ${sendId}`);
  assert.equal(row.status, 'drafted', 'no auto-mark below auto_mark_threshold');
  assert.equal(row.sent_text, null);

  const [vdl] = await db.query(sql`SELECT outcome FROM voice_drafts_log WHERE id = ${vdlId}`);
  assert.equal(vdl.outcome, 'pending', 'voice_drafts_log untouched on possible_match');

  assert.ok(posts.find((p) => /Possible match/.test(p.message)));
  await db.dispose();
});

test('pass1: <0.4 similarity → no action, no posts', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  await seedDraftRow(db, {
    draft_text: DRAFT,
    slack_thread_ts: '1700.A3',
  });

  const fakeSearchSent = fakeGmail({
    'patricia@example.com': [{
      id: 'gmail_3',
      to: 'patricia@example.com',
      from: 'sarah@lapuestadelsolresort.com',
      subject: 'Wholly different',
      body: 'Quick note about our plumber appointment tomorrow. Nothing related at all to the inquiry.',
      sent_at: '2026-05-09T14:00:00.000Z',
    }],
  });

  const { posts, fn } = makePostCollector();
  const hcPinged = { value: false };
  const result = await pass1Reconciliation(db, CFG, 'C_X', fn, hcPinged, { searchSentSince: fakeSearchSent });

  assert.equal(result.autoMarked, 0);
  assert.equal(result.possibleMatches, 0);
  assert.equal(posts.length, 0);
  await db.dispose();
});

test('pass1: no Gmail candidates → no action, no posts', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  await seedDraftRow(db, { draft_text: DRAFT, slack_thread_ts: '1700.A4' });

  const fakeSearchSent = fakeGmail({}); // empty
  const { posts, fn } = makePostCollector();
  const hcPinged = { value: false };
  const result = await pass1Reconciliation(db, CFG, 'C_X', fn, hcPinged, { searchSentSince: fakeSearchSent });

  assert.equal(result.scanned, 1);
  assert.equal(result.autoMarked, 0);
  assert.equal(result.possibleMatches, 0);
  // healthcheck pinged because Gmail responded (with []).
  assert.equal(hcPinged.value, true);
  await db.dispose();
});

test('pass1: skips manual_whatsapp / manual_airbnb_thread drafts (only manual_email)', async () => {
  const db = await buildTestDb();
  await seedContactAndDossier(db);
  await seedDraftRow(db, {
    draft_text: DRAFT,
    send_method: 'manual_whatsapp',
    slack_thread_ts: '1700.A5',
  });
  const fakeSearchSent = fakeGmail({
    'patricia@example.com': [{ id: 'g', to: 'patricia@example.com', body: DRAFT, sent_at: '2026-05-09T14:00:00.000Z' }],
  });
  const { posts, fn } = makePostCollector();
  const hcPinged = { value: false };
  const result = await pass1Reconciliation(db, CFG, 'C_X', fn, hcPinged, { searchSentSince: fakeSearchSent });
  assert.equal(result.scanned, 0);
  assert.equal(posts.length, 0);
  await db.dispose();
});
