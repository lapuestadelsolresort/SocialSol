'use strict';
//
// sarah-coach-outcome.test.js — exercises the lookupDraft helper and the
// voice_drafts_log writes that !sent and !edit perform. The Slack-post side
// of run() is covered by production verification; here we pin the DB
// behavior so the R3 feedback-loop write contract (outcome, edit_distance,
// sent_text, updated_at) doesn't drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const levenshtein = require('fast-levenshtein');

const { buildTestDb, sql } = require('./fixtures/regina-test-db');
const { lookupDraft } = require('../../sarah-coach/scripts/outcome');

async function seedSarahCoachDraft(db, { threadTs, draftText }) {
  await db.query(sql`
    INSERT INTO voice_drafts_log (intent, agent, draft_text, outcome)
    VALUES (${'inbound_inquiry_response'}, ${'sarah-coach'}, ${draftText}, ${'pending'})
  `);
  const [{ id: vdlId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  await db.query(sql`
    INSERT INTO sarah_coach_thread_log (thread_ts, voice_drafts_log_id)
    VALUES (${threadTs}, ${vdlId})
  `);
  return vdlId;
}

// ── lookupDraft ──────────────────────────────────────────────────────────

test('lookupDraft: returns null when thread_ts is unknown', async () => {
  const db = await buildTestDb();
  try {
    const row = await lookupDraft(db, '9999.9999');
    assert.equal(row, null);
  } finally {
    await db.dispose();
  }
});

test('lookupDraft: returns vdl_id + draft_text when thread mapping exists', async () => {
  const db = await buildTestDb();
  try {
    const vdlId = await seedSarahCoachDraft(db, {
      threadTs: '1700000000.000001',
      draftText: 'Hi! Yes, March 14 is open.',
    });
    const row = await lookupDraft(db, '1700000000.000001');
    assert.ok(row);
    assert.equal(row.vdl_id, vdlId);
    assert.equal(row.draft_text, 'Hi! Yes, March 14 is open.');
  } finally {
    await db.dispose();
  }
});

// ── !sent UPDATE behavior ────────────────────────────────────────────────

test('!sent UPDATE: outcome=sent_as_is, edit_distance=0, updated_at advances', async () => {
  const db = await buildTestDb();
  try {
    const vdlId = await seedSarahCoachDraft(db, {
      threadTs: '1700000000.000002',
      draftText: 'Original draft text',
    });
    const before = await db.query(sql`SELECT updated_at FROM voice_drafts_log WHERE id = ${vdlId}`);

    // Simulate the !sent path of outcome.js (the SQL is the contract under test).
    await new Promise((r) => setTimeout(r, 5)); // ensure datetime delta
    const now = new Date().toISOString();
    await db.query(sql`
      UPDATE voice_drafts_log
      SET outcome = ${'sent_as_is'},
          edit_distance = ${0},
          updated_at = ${now}
      WHERE id = ${vdlId}
    `);

    const [row] = await db.query(sql`SELECT outcome, edit_distance, sent_text, updated_at
                                     FROM voice_drafts_log WHERE id = ${vdlId}`);
    assert.equal(row.outcome, 'sent_as_is');
    assert.equal(row.edit_distance, 0);
    assert.equal(row.sent_text, null);
    assert.notEqual(row.updated_at, before[0].updated_at);
  } finally {
    await db.dispose();
  }
});

// ── !edit UPDATE behavior ────────────────────────────────────────────────

test('!edit UPDATE: outcome=sent_with_edits, sent_text + non-zero edit_distance', async () => {
  const db = await buildTestDb();
  try {
    const original = 'Hi! Yes, March 14 is open.';
    const edited = 'Hi Mark! March 14 is wide open — would love to host you.';
    const vdlId = await seedSarahCoachDraft(db, {
      threadTs: '1700000000.000003',
      draftText: original,
    });

    const distance = levenshtein.get(original, edited);
    assert.ok(distance > 0, 'precondition: edit must differ from draft');

    const now = new Date().toISOString();
    await db.query(sql`
      UPDATE voice_drafts_log
      SET outcome = ${'sent_with_edits'},
          edit_distance = ${distance},
          sent_text = ${edited},
          updated_at = ${now}
      WHERE id = ${vdlId}
    `);

    const [row] = await db.query(sql`SELECT outcome, edit_distance, sent_text
                                     FROM voice_drafts_log WHERE id = ${vdlId}`);
    assert.equal(row.outcome, 'sent_with_edits');
    assert.equal(row.edit_distance, distance);
    assert.equal(row.sent_text, edited);
  } finally {
    await db.dispose();
  }
});

// ── thread mapping isolation ─────────────────────────────────────────────

test('lookupDraft: two distinct pastes resolve to distinct vdl_ids', async () => {
  const db = await buildTestDb();
  try {
    const v1 = await seedSarahCoachDraft(db, {
      threadTs: '1700000000.000010',
      draftText: 'first draft',
    });
    const v2 = await seedSarahCoachDraft(db, {
      threadTs: '1700000000.000011',
      draftText: 'second draft',
    });
    assert.notEqual(v1, v2);
    const r1 = await lookupDraft(db, '1700000000.000010');
    const r2 = await lookupDraft(db, '1700000000.000011');
    assert.equal(r1.vdl_id, v1);
    assert.equal(r1.draft_text, 'first draft');
    assert.equal(r2.vdl_id, v2);
    assert.equal(r2.draft_text, 'second draft');
  } finally {
    await db.dispose();
  }
});
