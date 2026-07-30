'use strict';
//
// regina-r6-eligibility.test.js — runs each of the six R6 eligibility SQLs
// against an in-memory fixture DB and asserts the returned id list.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, sql } = require('./fixtures/regina-test-db');
const { loadCampaign } = require('../../regina/lib/campaign-loader');

async function runSql(db, slug, { batchSize = 100, today = '2026-05-07' } = {}) {
  const loaded = loadCampaign(slug);
  const bound = loaded.bindParams({ batchSize, today });
  const rows = await db.query(sql.__dangerous__rawValue(bound));
  return rows.map((r) => r.id);
}

async function insertContact(db, c) {
  const fields = {
    id: null,
    name: 'Test',
    email: 'test@example.com',
    phone: null,
    do_not_contact: 0,
    relationship_type: 'past_guest_stayed',
    contact_provenance: 'voluntary_share_message',
    airbnb_account_id: null,
    airbnb_thread_id: String(Math.floor(Math.random() * 1e9)),
    last_stay_date: '2025-04-01',
    preferred_channel: 'email',
    review_rating: null,
    trip_purpose: null,
    reservation_count: 0,
    has_private_feedback: 0,
    addressable: 1,
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
  return fields;
}

async function insertDossier(db, contactId, threadId, overrides = {}) {
  const d = {
    why_no_book: null,
    why_no_book_confidence: null,
    language: 'en',
    extraction_status: 'extracted',
    ...overrides,
  };
  await db.query(sql`
    INSERT INTO guest_dossiers (airbnb_thread_id, contact_ids, language, extraction_status,
      why_no_book, why_no_book_confidence, reviewed_by_human)
    VALUES (${threadId}, ${JSON.stringify([contactId])}, ${d.language}, ${d.extraction_status},
      ${d.why_no_book}, ${d.why_no_book_confidence}, ${1})
  `);
}

async function insertSend(db, { contactId, slug, campaignKind, status, deferUntil = null, createdAt = null }) {
  await db.query(sql`
    INSERT INTO outreach_campaigns (name, slug, campaign_kind, owning_agent, status,
      landing_page_url, persona_brief_path, description, created_by)
    VALUES (${slug + '_camp'}, ${slug}, ${campaignKind}, ${'regina'}, ${'active'},
      ${'https://x/'}, ${'p'}, ${'d'}, ${'test'})
  `);
  const [{ id: campaignId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  await db.query(sql`
    INSERT INTO outreach_sends (contact_id, campaign_id, status, defer_until, created_at,
      sequence_step, body_full, body_preview, send_method, draft_text)
    VALUES (${contactId}, ${campaignId}, ${status}, ${deferUntil}, ${createdAt || new Date().toISOString()},
      ${1}, ${'b'}, ${'b'}, ${'manual_email'}, ${'d'})
  `);
}

// ── referral_mining ──────────────────────────────────────────────────────

test('referral_mining: includes a 5-star reviewer with a clean dossier', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1001, review_rating: 5, airbnb_thread_id: 't1001' });
    await insertDossier(db, 1001, 't1001');
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, [1001]);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: excludes a contact already sent under reactivation_referral', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1002, review_rating: 5, airbnb_thread_id: 't1002' });
    await insertDossier(db, 1002, 't1002');
    await insertSend(db, { contactId: 1002, slug: 'referral_mining', campaignKind: 'reactivation_referral', status: 'sent' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: excludes a contact currently in drafted state', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1003, review_rating: 5, airbnb_thread_id: 't1003' });
    await insertDossier(db, 1003, 't1003');
    await insertSend(db, { contactId: 1003, slug: 'referral_mining_2', campaignKind: 'reactivation_referral', status: 'drafted' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: re-eligible after defer_until has passed', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1004, review_rating: 5, airbnb_thread_id: 't1004' });
    await insertDossier(db, 1004, 't1004');
    // deferred row, but defer_until is in the past → contact should be eligible again.
    await insertSend(db, { contactId: 1004, slug: 'referral_mining_3', campaignKind: 'reactivation_referral', status: 'deferred', deferUntil: '2020-01-01' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, [1004]);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: excluded while defer_until is in the future', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1005, review_rating: 5, airbnb_thread_id: 't1005' });
    await insertDossier(db, 1005, 't1005');
    await insertSend(db, { contactId: 1005, slug: 'referral_mining_4', campaignKind: 'reactivation_referral', status: 'deferred', deferUntil: '2099-01-01' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: campaign_kind isolation — winback row does NOT block referral', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1006, review_rating: 5, airbnb_thread_id: 't1006' });
    await insertDossier(db, 1006, 't1006');
    await insertSend(db, { contactId: 1006, slug: 'wb_a', campaignKind: 'reactivation_winback', status: 'sent' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, [1006]);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: do_not_contact=1 excluded', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1007, review_rating: 5, airbnb_thread_id: 't1007', do_not_contact: 1 });
    await insertDossier(db, 1007, 't1007');
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: dossier with extraction_status != extracted excluded', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1008, review_rating: 5, airbnb_thread_id: 't1008' });
    await insertDossier(db, 1008, 't1008', { extraction_status: 'deferred_spanish' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('referral_mining: dossier language=es excluded', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 1009, review_rating: 5, airbnb_thread_id: 't1009' });
    await insertDossier(db, 1009, 't1009', { language: 'es' });
    const ids = await runSql(db, 'referral_mining');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

// ── winback_cancelled ────────────────────────────────────────────────────

test('winback_cancelled: includes past_guest_cancelled cohort', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 2001, relationship_type: 'past_guest_cancelled', airbnb_thread_id: 't2001' });
    await insertDossier(db, 2001, 't2001');
    const ids = await runSql(db, 'winback_cancelled');
    assert.deepEqual(ids, [2001]);
  } finally {
    await db.dispose();
  }
});

test('winback_cancelled: excludes past_guest_stayed', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 2002, relationship_type: 'past_guest_stayed', airbnb_thread_id: 't2002' });
    await insertDossier(db, 2002, 't2002');
    const ids = await runSql(db, 'winback_cancelled');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

// ── inquiry_conversion ───────────────────────────────────────────────────

test('inquiry_conversion: includes price-blocker with confidence >= 0.6', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 3001, relationship_type: 'past_guest_inquired', airbnb_thread_id: 't3001' });
    await insertDossier(db, 3001, 't3001', { why_no_book: 'price', why_no_book_confidence: 0.85 });
    const ids = await runSql(db, 'inquiry_conversion');
    assert.deepEqual(ids, [3001]);
  } finally {
    await db.dispose();
  }
});

test('inquiry_conversion: confidence floor enforced — 0.5 excluded', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 3002, relationship_type: 'past_guest_inquired', airbnb_thread_id: 't3002' });
    await insertDossier(db, 3002, 't3002', { why_no_book: 'price', why_no_book_confidence: 0.5 });
    const ids = await runSql(db, 'inquiry_conversion');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('inquiry_conversion: refuses why_no_book=went_elsewhere', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 3003, relationship_type: 'past_guest_inquired', airbnb_thread_id: 't3003' });
    await insertDossier(db, 3003, 't3003', { why_no_book: 'went_elsewhere', why_no_book_confidence: 0.95 });
    const ids = await runSql(db, 'inquiry_conversion');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('inquiry_conversion: dates_unavailable + no_response also accepted', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 3004, relationship_type: 'past_guest_inquired', airbnb_thread_id: 't3004' });
    await insertDossier(db, 3004, 't3004', { why_no_book: 'dates_unavailable', why_no_book_confidence: 0.7 });
    await insertContact(db, { id: 3005, relationship_type: 'past_guest_inquired', airbnb_thread_id: 't3005' });
    await insertDossier(db, 3005, 't3005', { why_no_book: 'no_response', why_no_book_confidence: 0.6 });
    const ids = await runSql(db, 'inquiry_conversion');
    assert.deepEqual(ids.sort(), [3004, 3005]);
  } finally {
    await db.dispose();
  }
});

// ── anniversary ──────────────────────────────────────────────────────────

test('anniversary: matches MM-DD on last_stay_date', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 4001, relationship_type: 'past_guest_stayed', last_stay_date: '2024-05-07', airbnb_thread_id: 't4001' });
    await insertDossier(db, 4001, 't4001');
    const ids = await runSql(db, 'anniversary', { today: '2026-05-07' });
    assert.deepEqual(ids, [4001]);
  } finally {
    await db.dispose();
  }
});

test('anniversary: 300-day cooldown enforced', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 4002, relationship_type: 'past_guest_stayed', last_stay_date: '2024-05-07', airbnb_thread_id: 't4002' });
    await insertDossier(db, 4002, 't4002');
    // Fired the anniversary 100 days ago — within the 300d cooldown.
    const recent = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    await insertSend(db, { contactId: 4002, slug: 'anniversary', campaignKind: 'reactivation_anniversary', status: 'sent', createdAt: recent });
    const ids = await runSql(db, 'anniversary', { today: '2026-05-07' });
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('anniversary: re-eligible after 300d window passes', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 4003, relationship_type: 'past_guest_stayed', last_stay_date: '2024-05-07', airbnb_thread_id: 't4003' });
    await insertDossier(db, 4003, 't4003');
    // 350 days ago → outside the 300d cooldown.
    const old = new Date(Date.now() - 350 * 24 * 60 * 60 * 1000).toISOString();
    await insertSend(db, { contactId: 4003, slug: 'anniversary_old', campaignKind: 'reactivation_anniversary', status: 'sent', createdAt: old });
    const ids = await runSql(db, 'anniversary', { today: '2026-05-07' });
    assert.deepEqual(ids, [4003]);
  } finally {
    await db.dispose();
  }
});

test('anniversary: campaign_kind isolation — winback row does NOT block anniversary', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 4004, relationship_type: 'past_guest_stayed', last_stay_date: '2024-05-07', airbnb_thread_id: 't4004' });
    await insertDossier(db, 4004, 't4004');
    // Recent winback send — should NOT block today's anniversary.
    await insertSend(db, { contactId: 4004, slug: 'wb_b', campaignKind: 'reactivation_winback', status: 'sent', createdAt: new Date().toISOString() });
    const ids = await runSql(db, 'anniversary', { today: '2026-05-07' });
    assert.deepEqual(ids, [4004]);
  } finally {
    await db.dispose();
  }
});

test('anniversary: MM-DD mismatch excluded', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 4005, relationship_type: 'past_guest_stayed', last_stay_date: '2024-05-08', airbnb_thread_id: 't4005' });
    await insertDossier(db, 4005, 't4005');
    const ids = await runSql(db, 'anniversary', { today: '2026-05-07' });
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

// ── vip ──────────────────────────────────────────────────────────────────

test('vip: returns 0 rows when reservation_count is 0 (R6 default)', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 5001, airbnb_thread_id: 't5001' });
    await insertDossier(db, 5001, 't5001');
    const ids = await runSql(db, 'vip');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('vip: includes contact with reservation_count >= 2 (post-backfill simulation)', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 5002, reservation_count: 3, airbnb_thread_id: 't5002' });
    await insertDossier(db, 5002, 't5002');
    const ids = await runSql(db, 'vip');
    assert.deepEqual(ids, [5002]);
  } finally {
    await db.dispose();
  }
});

// ── feedback_closure ─────────────────────────────────────────────────────

test('feedback_closure: 0 rows when has_private_feedback=0 (R6 default)', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 6001, airbnb_thread_id: 't6001' });
    await insertDossier(db, 6001, 't6001');
    const ids = await runSql(db, 'feedback_closure');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

test('feedback_closure: includes contact with has_private_feedback=1 + email', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, { id: 6002, has_private_feedback: 1, email: 'fb@x.com', airbnb_thread_id: 't6002' });
    await insertDossier(db, 6002, 't6002');
    const ids = await runSql(db, 'feedback_closure');
    assert.deepEqual(ids, [6002]);
  } finally {
    await db.dispose();
  }
});

test('feedback_closure: looser filter — airbnb_thread_only contact included', async () => {
  const db = await buildTestDb();
  try {
    // No email or phone, but airbnb_thread_only provenance — admitted for
    // feedback_closure. The provenance hard rule routes channel at draft time.
    await insertContact(db, {
      id: 6003,
      has_private_feedback: 1,
      email: null,
      phone: null,
      contact_provenance: 'airbnb_thread_only',
      airbnb_thread_id: 't6003',
    });
    await insertDossier(db, 6003, 't6003');
    const ids = await runSql(db, 'feedback_closure');
    assert.deepEqual(ids, [6003]);
  } finally {
    await db.dispose();
  }
});

test('feedback_closure: contact with no email/phone AND non-airbnb_thread_only excluded', async () => {
  const db = await buildTestDb();
  try {
    await insertContact(db, {
      id: 6004,
      has_private_feedback: 1,
      email: null,
      phone: null,
      contact_provenance: 'voluntary_share_message',
      airbnb_thread_id: 't6004',
    });
    await insertDossier(db, 6004, 't6004');
    const ids = await runSql(db, 'feedback_closure');
    assert.deepEqual(ids, []);
  } finally {
    await db.dispose();
  }
});

// ── batch_size honored ───────────────────────────────────────────────────

test('LIMIT :batch_size is honored across all SQL files', async () => {
  const db = await buildTestDb();
  try {
    for (let i = 7001; i <= 7010; i++) {
      await insertContact(db, { id: i, review_rating: 5, airbnb_thread_id: `t${i}` });
      await insertDossier(db, i, `t${i}`);
    }
    const ids = await runSql(db, 'referral_mining', { batchSize: 3 });
    assert.equal(ids.length, 3);
  } finally {
    await db.dispose();
  }
});
