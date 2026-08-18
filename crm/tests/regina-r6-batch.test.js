'use strict';
//
// regina-r6-batch.test.js — exercises the R6-specific bits of the batch
// pipeline: SQL-driven contact resolution, the smoke escape hatch, and the
// stable-slug findOrCreateCampaign helper. The full Voice-Service+Slack
// end-to-end path stays covered by production verification (per plan); these
// tests pin the loader→SQL→helpers boundary that R6 introduced.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, sql } = require('./fixtures/regina-test-db');
const { resolveContactIds } = require('../../regina/scripts/batch');
const { loadCampaign } = require('../../regina/lib/campaign-loader');
const { findOrCreateCampaign, deleteCampaignIfEmpty } = require('../../regina/lib/outreach-campaign');

async function insertContact(db, c) {
  const fields = {
    name: 'Test', email: 'test@example.com', phone: null,
    do_not_contact: 0, relationship_type: 'past_guest_stayed',
    contact_provenance: 'voluntary_share_message', airbnb_account_id: null,
    airbnb_thread_id: String(Math.floor(Math.random() * 1e9)),
    last_stay_date: '2025-04-01', preferred_channel: 'email',
    review_rating: null, trip_purpose: null,
    reservation_count: 0, has_private_feedback: 0, addressable: 1,
    ...c,
  };
  await db.query(sql`
    INSERT INTO contacts (id, name, email, phone, do_not_contact, relationship_type,
      contact_provenance, airbnb_account_id, airbnb_thread_id, last_stay_date,
      preferred_channel, review_rating, trip_purpose,
      reservation_count, has_private_feedback, addressable)
    VALUES (${fields.id}, ${fields.name}, ${fields.email}, ${fields.phone},
      ${fields.do_not_contact}, ${fields.relationship_type}, ${fields.contact_provenance},
      ${fields.airbnb_account_id}, ${fields.airbnb_thread_id}, ${fields.last_stay_date},
      ${fields.preferred_channel}, ${fields.review_rating}, ${fields.trip_purpose},
      ${fields.reservation_count}, ${fields.has_private_feedback}, ${fields.addressable})
  `);
}

async function insertDossier(db, contactId, threadId) {
  await db.query(sql`
    INSERT INTO guest_dossiers (airbnb_thread_id, contact_ids, language, extraction_status, reviewed_by_human)
    VALUES (${threadId}, ${JSON.stringify([contactId])}, ${'en'}, ${'extracted'}, ${1})
  `);
}

// ── resolveContactIds: SQL path ──────────────────────────────────────────

test('resolveContactIds runs the campaign SQL and returns ids', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 8001, review_rating: 5, airbnb_thread_id: 't8001' });
    await insertDossier(db, 8001, 't8001');
    const loaded = loadCampaign('referral_mining');
    const ids = await resolveContactIds(db, loaded, 5, '2026-05-07');
    assert.deepEqual(ids, [8001]);
  } finally {
    await db.dispose();
  }
});

test('resolveContactIds returns empty array when SQL matches nothing (empty-day input)', async () => {
  const db = await buildTestDb();
  try {
    // No contacts inserted.
    const loaded = loadCampaign('referral_mining');
    const ids = await resolveContactIds(db, loaded, 5, '2026-05-07');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('resolveContactIds honors batchSize (LIMIT) over default_batch_size', async () => {
  const db = await buildTestDb();
  try {
    for (let i = 8101; i <= 8110; i++) {
      await insertContact(db, { id: i, review_rating: 5, airbnb_thread_id: `t${i}` });
      await insertDossier(db, i, `t${i}`);
    }
    const loaded = loadCampaign('referral_mining');
    const ids = await resolveContactIds(db, loaded, 2, '2026-05-07');
    assert.equal(ids.length, 2);
  } finally {
    await db.dispose();
  }
});

// ── resolveContactIds: smoke escape hatch ───────────────────────────────

test('resolveContactIds uses contact_ids array when no SQL is present (smoke)', async () => {
  const db = await buildTestDb();
  try {
    // The mechanism: a strategy file with contact_ids and no eligibility SQL
    // uses the static list directly, truncated to batchSize. Driven from a
    // synthetic config — the shipped smoke.json deliberately carries no ids
    // (F-050c), and this test is about the escape hatch, not that file.
    const loaded = { config: { slug: 'smoke', contact_ids: [1, 2, 3] }, sqlText: null };
    const ids = await resolveContactIds(db, loaded, 2, '2026-05-07');
    assert.equal(ids.length, 2);
    assert.deepEqual(ids, [1, 2]);
  } finally {
    await db.dispose();
  }
});

test('the shipped smoke campaign carries no contact ids (F-050c)', async () => {
  // `!batch` with no slug defaults to smoke, and the escape hatch skips the
  // eligibility SQL entirely — no suppression or already-contacted filtering.
  // Any id parked here would be dispatched to repeatedly.
  const loaded = loadCampaign('smoke');
  assert.ok(Array.isArray(loaded.config.contact_ids));
  assert.equal(loaded.config.contact_ids.length, 0);
  assert.equal(loaded.sqlText, null);
});

// ── findOrCreateCampaign: stable slug behavior ──────────────────────────

test('findOrCreateCampaign creates a row on first call and reuses it on subsequent calls', async () => {
  const db = await buildTestDb();
  try {
    const loaded = loadCampaign('anniversary');
    const id1 = await findOrCreateCampaign(db, loaded.config, { createdBy: 'test:1' });
    const id2 = await findOrCreateCampaign(db, loaded.config, { createdBy: 'test:2' });
    assert.equal(id1, id2);
    const rows = await db.query(sql`SELECT slug FROM outreach_campaigns WHERE slug = ${'anniversary'}`);
    assert.equal(rows.length, 1);
  } finally {
    await db.dispose();
  }
});

test('findOrCreateCampaign uses the strategy file fields verbatim', async () => {
  const db = await buildTestDb();
  try {
    const loaded = loadCampaign('referral_mining');
    const id = await findOrCreateCampaign(db, loaded.config);
    const rows = await db.query(sql`SELECT * FROM outreach_campaigns WHERE id = ${id}`);
    const row = rows[0];
    assert.equal(row.slug, 'referral_mining');
    assert.equal(row.campaign_kind, 'reactivation_referral');
    assert.equal(row.owning_agent, 'regina');
    assert.equal(row.status, 'active');
    assert.equal(row.persona_brief_path, 'regina/library/campaigns/referral_mining.json');
  } finally {
    await db.dispose();
  }
});

test('deleteCampaignIfEmpty removes a campaign with no sends', async () => {
  const db = await buildTestDb();
  try {
    const loaded = loadCampaign('vip');
    const id = await findOrCreateCampaign(db, loaded.config);
    await deleteCampaignIfEmpty(db, id);
    const rows = await db.query(sql`SELECT slug FROM outreach_campaigns WHERE id = ${id}`);
    assert.equal(rows.length, 0);
  } finally {
    await db.dispose();
  }
});

test('deleteCampaignIfEmpty preserves a campaign that has sends (anniversary stable-slug protection)', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 8201, relationship_type: 'past_guest_stayed', airbnb_thread_id: 't8201' });
    const loaded = loadCampaign('anniversary');
    const id = await findOrCreateCampaign(db, loaded.config);
    // Insert a send referencing this campaign.
    await db.query(sql`
      INSERT INTO outreach_sends (contact_id, campaign_id, status, sequence_step,
        body_full, body_preview, send_method, draft_text, created_at, reminder_count)
      VALUES (${8201}, ${id}, ${'drafted'}, ${1}, ${'b'}, ${'b'}, ${'manual_email'}, ${'d'},
        ${new Date().toISOString()}, ${0})
    `);
    await deleteCampaignIfEmpty(db, id);
    const rows = await db.query(sql`SELECT slug FROM outreach_campaigns WHERE id = ${id}`);
    assert.equal(rows.length, 1);
  } finally {
    await db.dispose();
  }
});
