'use strict';
//
// regina-test-db.js — builds an in-memory SQLite DB seeded with the minimum
// schema Regina needs (contacts, outreach_campaigns, outreach_sends,
// guest_dossiers, voice_drafts_log) plus the migration 010 columns.
//
// Used by regina-*.test.js suites.

// IMPORTANT: import @databases/sqlite from regina/node_modules so the test
// uses the SAME module instance regina/lib/* uses. If we required from this
// file's directory chain we'd get crm/node_modules's copy, and the SQLQuery
// class identity check inside @databases would fail across the two instances.
const REGINA_DBSQLITE = require.resolve(
  '@databases/sqlite',
  { paths: [require('path').resolve(__dirname, '../../../regina')] }
);
const dbsql = require(REGINA_DBSQLITE);
const createDB = dbsql.default || dbsql;
const { sql } = dbsql;

async function buildTestDb() {
  const db = createDB(':memory:');

  // Foreign keys are off by default in the in-memory DB; for tests we don't
  // bother turning them on — we'd just be checking our own fixtures.

  await db.query(sql`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      phone TEXT,
      do_not_contact INTEGER DEFAULT 0,
      relationship_type TEXT,
      contact_provenance TEXT,
      airbnb_account_id INTEGER,
      airbnb_thread_id INTEGER,
      last_stay_date TEXT,
      preferred_channel TEXT,
      review_rating INTEGER,
      trip_purpose TEXT,
      reservation_count INTEGER NOT NULL DEFAULT 0,
      has_private_feedback INTEGER NOT NULL DEFAULT 0,
      addressable INTEGER NOT NULL DEFAULT 0
    )
  `);

  await db.query(sql`
    CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE,
      persona_brief_path TEXT,
      description TEXT,
      landing_page_url TEXT,
      created_by TEXT,
      campaign_kind TEXT,
      owning_agent TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      contact_id INTEGER,
      campaign_id INTEGER,
      sequence_step INTEGER,
      subject TEXT,
      body_full TEXT,
      body_preview TEXT,
      sent_at TEXT,
      status TEXT,
      error TEXT,
      send_method TEXT,
      draft_text TEXT,
      sent_text TEXT,
      edit_distance INTEGER,
      slack_thread_ts TEXT,
      slack_channel_id TEXT,
      slack_body_ts TEXT,
      sent_by_user_id TEXT,
      posted_at TEXT,
      defer_until TEXT,
      skip_reason TEXT,
      reminder_count INTEGER DEFAULT 0,
      last_reminded_at TEXT,
      voice_drafts_log_id INTEGER
    )
  `);

  await db.query(sql`
    CREATE TABLE guest_dossiers (
      airbnb_thread_id TEXT PRIMARY KEY,
      contact_ids TEXT NOT NULL,
      trip_purpose TEXT,
      why_no_book TEXT,
      why_no_book_confidence REAL,
      decision_timeline TEXT,
      language TEXT,
      excitement_signals TEXT,
      objections TEXT,
      specific_features_mentioned TEXT,
      dates_targeted TEXT,
      group_dynamics TEXT,
      geographic_hints TEXT,
      communication_style TEXT,
      occasion_anniversary_date TEXT,
      notes_for_sarah TEXT,
      extraction_status TEXT NOT NULL,
      last_attempt_error TEXT,
      reviewed_by_human INTEGER DEFAULT 0,
      extraction_model TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE voice_drafts_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent TEXT NOT NULL,
      agent TEXT NOT NULL,
      contact_id INTEGER,
      draft_text TEXT NOT NULL,
      retrieved_example_ids TEXT,
      cost_usd REAL,
      outcome TEXT NOT NULL DEFAULT 'pending',
      edit_distance INTEGER,
      sent_text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // R7 (migration 012) — sarah-coach thread mapping.
  await db.query(sql`
    CREATE TABLE sarah_coach_thread_log (
      thread_ts TEXT PRIMARY KEY,
      voice_drafts_log_id INTEGER NOT NULL REFERENCES voice_drafts_log(id),
      posted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

// Insert a contact + a dossier covering it. Defaults are en/extracted/inquired.
async function seedContactAndDossier(db, overrides = {}) {
  const contact = {
    id: 100,
    name: 'Patricia Test',
    email: 'patricia@example.com',
    phone: null,
    do_not_contact: 0,
    relationship_type: 'past_guest_inquired',
    contact_provenance: 'voluntary_share_message',
    airbnb_account_id: 12345,
    airbnb_thread_id: '999000111',
    last_stay_date: null,
    preferred_channel: 'email',
    ...overrides.contact,
  };
  const dossier = {
    airbnb_thread_id: contact.airbnb_thread_id,
    contact_ids: JSON.stringify([contact.id]),
    trip_purpose: 'family_vacation',
    why_no_book: 'price',
    decision_timeline: 'actively_deciding',
    language: 'en',
    excitement_signals: '["mentioned the kitchen"]',
    objections: '["price"]',
    specific_features_mentioned: '["pool"]',
    dates_targeted: 'August 2026',
    group_dynamics: '4 adults 2 kids',
    geographic_hints: 'Texas',
    communication_style: 'warm, casual',
    occasion_anniversary_date: null,
    notes_for_sarah: 'Patricia inquired in March about an August family stay; nearly booked but went elsewhere on price.',
    extraction_status: 'extracted',
    last_attempt_error: null,
    reviewed_by_human: 1,
    extraction_model: 'claude-sonnet-4-6',
    ...overrides.dossier,
  };

  await db.query(sql`
    INSERT INTO contacts (id, name, email, phone, do_not_contact,
      relationship_type, contact_provenance, airbnb_account_id, airbnb_thread_id,
      last_stay_date, preferred_channel)
    VALUES (${contact.id}, ${contact.name}, ${contact.email}, ${contact.phone},
      ${contact.do_not_contact}, ${contact.relationship_type},
      ${contact.contact_provenance}, ${contact.airbnb_account_id},
      ${contact.airbnb_thread_id}, ${contact.last_stay_date},
      ${contact.preferred_channel})
  `);

  await db.query(sql`
    INSERT INTO guest_dossiers (airbnb_thread_id, contact_ids, trip_purpose,
      why_no_book, decision_timeline, language, excitement_signals, objections,
      specific_features_mentioned, dates_targeted, group_dynamics,
      geographic_hints, communication_style, occasion_anniversary_date,
      notes_for_sarah, extraction_status, last_attempt_error, reviewed_by_human,
      extraction_model)
    VALUES (${dossier.airbnb_thread_id}, ${dossier.contact_ids},
      ${dossier.trip_purpose}, ${dossier.why_no_book},
      ${dossier.decision_timeline}, ${dossier.language},
      ${dossier.excitement_signals}, ${dossier.objections},
      ${dossier.specific_features_mentioned}, ${dossier.dates_targeted},
      ${dossier.group_dynamics}, ${dossier.geographic_hints},
      ${dossier.communication_style}, ${dossier.occasion_anniversary_date},
      ${dossier.notes_for_sarah}, ${dossier.extraction_status},
      ${dossier.last_attempt_error}, ${dossier.reviewed_by_human},
      ${dossier.extraction_model})
  `);

  return { contact, dossier };
}

async function seedDraftRow(db, overrides = {}) {
  // Insert a campaign first if needed.
  const campaign = {
    name: overrides.campaign_name || `test_camp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    slug: overrides.campaign_slug || `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    campaign_kind: 'ad_hoc',
    owning_agent: 'regina',
  };
  await db.query(sql`
    INSERT INTO outreach_campaigns (name, slug, campaign_kind, owning_agent, status,
      landing_page_url, persona_brief_path, description, created_by)
    VALUES (${campaign.name}, ${campaign.slug}, ${campaign.campaign_kind},
      ${campaign.owning_agent}, ${'active'}, ${'https://lapuestadelsolresort.com/'},
      ${'test'}, ${'test'}, ${'test'})
  `);
  const [{ id: campaignId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);

  // Insert a voice_drafts_log row to link
  await db.query(sql`
    INSERT INTO voice_drafts_log (intent, agent, contact_id, draft_text, outcome)
    VALUES (${overrides.intent || 'ad_hoc'}, ${'regina'},
      ${overrides.contact_id || 100}, ${overrides.draft_text || 'hello world draft'},
      ${'pending'})
  `);
  const [{ id: vdlId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);

  // Insert outreach_sends row
  const fields = {
    contact_id: 100,
    campaign_id: campaignId,
    status: 'drafted',
    send_method: 'manual_email',
    draft_text: 'hello world draft',
    slack_thread_ts: '1700000000.000100',
    slack_channel_id: 'C_TEST',
    voice_drafts_log_id: vdlId,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  await db.query(sql`
    INSERT INTO outreach_sends
      (contact_id, campaign_id, status, send_method, draft_text,
       slack_thread_ts, slack_channel_id, voice_drafts_log_id, created_at,
       sequence_step, body_full, body_preview, reminder_count)
    VALUES
      (${fields.contact_id}, ${fields.campaign_id}, ${fields.status},
       ${fields.send_method}, ${fields.draft_text}, ${fields.slack_thread_ts},
       ${fields.slack_channel_id}, ${fields.voice_drafts_log_id},
       ${fields.created_at}, ${1}, ${fields.draft_text},
       ${(fields.draft_text || '').slice(0, 200)}, ${0})
  `);
  const [{ id: sendId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  return { sendId, vdlId, campaignId };
}

module.exports = { buildTestDb, seedContactAndDossier, seedDraftRow, sql };
