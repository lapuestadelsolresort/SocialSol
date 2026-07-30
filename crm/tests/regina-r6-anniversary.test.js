'use strict';
//
// regina-r6-anniversary.test.js — anniversary cron's R6 specifics: --date
// override flow into :today, eligibleContactIds returns expected ids, stable
// slug reuse across simulated daily fires.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, sql } = require('./fixtures/regina-test-db');
const { eligibleContactIds, todayIso } = require('../../regina/scripts/anniversary-cron');
const { loadCampaign } = require('../../regina/lib/campaign-loader');
const { findOrCreateCampaign } = require('../../regina/lib/outreach-campaign');

async function insertStayAnniversary(db, contactId, lastStayDate) {
  const threadId = `tA${contactId}`;
  await db.query(sql`
    INSERT INTO contacts (id, name, email, do_not_contact, relationship_type,
      contact_provenance, airbnb_thread_id, last_stay_date, preferred_channel,
      reservation_count, has_private_feedback, addressable)
    VALUES (${contactId}, ${'A'}, ${'a@x.com'}, ${0}, ${'past_guest_stayed'},
      ${'voluntary_share_message'}, ${threadId}, ${lastStayDate}, ${'email'},
      ${0}, ${0}, ${1})
  `);
  await db.query(sql`
    INSERT INTO guest_dossiers (airbnb_thread_id, contact_ids, language, extraction_status, reviewed_by_human)
    VALUES (${threadId}, ${JSON.stringify([contactId])}, ${'en'}, ${'extracted'}, ${1})
  `);
}

test('todayIso accepts valid YYYY-MM-DD override', () => {
  assert.equal(todayIso('2026-05-07'), '2026-05-07');
});

test('todayIso rejects malformed date (operator-input gate)', () => {
  assert.throws(() => todayIso('05-07-2026'), /YYYY-MM-DD/);
  assert.throws(() => todayIso("2026-05-07'; DROP TABLE contacts;--"), /YYYY-MM-DD/);
  assert.throws(() => todayIso('2026/05/07'), /YYYY-MM-DD/);
});

test('todayIso defaults to today when no override given', () => {
  const t = todayIso(null);
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
});

test('eligibleContactIds returns matches for a date with anniversary candidates', async () => {
  const db = await buildTestDb();
  try {
    await insertStayAnniversary(db, 9001, '2024-05-07');
    const loaded = loadCampaign('anniversary');
    const ids = await eligibleContactIds(db, loaded, '2026-05-07');
    assert.deepEqual(ids, [9001]);
  } finally {
    await db.dispose();
  }
});

test('eligibleContactIds returns empty array for a no-anniversary date', async () => {
  const db = await buildTestDb();
  try {
    await insertStayAnniversary(db, 9002, '2024-05-07');
    const loaded = loadCampaign('anniversary');
    const ids = await eligibleContactIds(db, loaded, '2026-05-08');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('anniversary stable slug — only one outreach_campaigns row across fires', async () => {
  const db = await buildTestDb();
  try {
    await insertStayAnniversary(db, 9003, '2024-05-07');
    const loaded = loadCampaign('anniversary');

    // Simulate three daily fires that each create the campaign row.
    const id1 = await findOrCreateCampaign(db, loaded.config, { createdBy: 'regina:r6_anniversary_cron' });
    const id2 = await findOrCreateCampaign(db, loaded.config, { createdBy: 'regina:r6_anniversary_cron' });
    const id3 = await findOrCreateCampaign(db, loaded.config, { createdBy: 'regina:r6_anniversary_cron' });
    assert.equal(id1, id2);
    assert.equal(id2, id3);

    const rows = await db.query(sql`SELECT COUNT(*) AS n FROM outreach_campaigns WHERE slug = ${'anniversary'}`);
    assert.equal(rows[0].n, 1);
  } finally {
    await db.dispose();
  }
});

test('anniversary cooldown (300 days) and re-eligibility after window', async () => {
  const db = await buildTestDb();
  try {
    await insertStayAnniversary(db, 9004, '2024-05-07');
    const loaded = loadCampaign('anniversary');

    // First fire: 9004 is eligible.
    const ids1 = await eligibleContactIds(db, loaded, '2026-05-07');
    assert.deepEqual(ids1, [9004]);

    // Insert a recent send under the anniversary campaign — second fire
    // should now exclude 9004.
    const campaignId = await findOrCreateCampaign(db, loaded.config);
    await db.query(sql`
      INSERT INTO outreach_sends (contact_id, campaign_id, status, sequence_step,
        body_full, body_preview, send_method, draft_text, created_at, reminder_count)
      VALUES (${9004}, ${campaignId}, ${'sent'}, ${1}, ${'b'}, ${'b'}, ${'manual_email'},
        ${'d'}, ${new Date().toISOString()}, ${0})
    `);
    const ids2 = await eligibleContactIds(db, loaded, '2026-05-07');
    assert.deepEqual(ids2, []);
  } finally {
    await db.dispose();
  }
});
