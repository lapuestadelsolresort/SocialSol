-- Migration 009: guest_dossiers v1 — supersedes 006's stub
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/009_guest_dossiers_v1.sh
--
-- This file is the canonical DDL reference. The wrapper drops + recreates
-- guest_dossiers because 006's stub was never populated (R1 noted it as a
-- placeholder; the extraction prompt's actual shape needs per-field
-- confidence + citations, which 006 didn't anticipate).
--
-- Shape: one row per Airbnb thread (PK = airbnb_thread_id). contact_ids is
-- a JSON array — group bookings produce one shared dossier across multiple
-- contacts. Each extractable field has three columns:
--   <field>                       value (string OR JSON array for list fields)
--   <field>_confidence            REAL 0.0–1.0
--   <field>_source_message_ids    JSON array of cited [message_id]s
--
-- Closed taxonomies + arrays + scalars per the extraction prompt.

DROP TABLE IF EXISTS guest_dossiers;

CREATE TABLE guest_dossiers (
  airbnb_thread_id TEXT PRIMARY KEY,
  contact_ids TEXT NOT NULL,                            -- JSON array of contacts.id

  -- Closed taxonomies
  trip_purpose TEXT,
  trip_purpose_confidence REAL,
  trip_purpose_source_message_ids TEXT,
  why_no_book TEXT,
  why_no_book_confidence REAL,
  why_no_book_source_message_ids TEXT,
  decision_timeline TEXT,
  decision_timeline_confidence REAL,
  decision_timeline_source_message_ids TEXT,
  language TEXT,
  language_confidence REAL,
  language_source_message_ids TEXT,

  -- Array free-text
  excitement_signals TEXT,
  excitement_signals_confidence REAL,
  excitement_signals_source_message_ids TEXT,
  objections TEXT,
  objections_confidence REAL,
  objections_source_message_ids TEXT,
  specific_features_mentioned TEXT,
  specific_features_mentioned_confidence REAL,
  specific_features_mentioned_source_message_ids TEXT,

  -- Scalar free-text
  dates_targeted TEXT,
  dates_targeted_confidence REAL,
  dates_targeted_source_message_ids TEXT,
  group_dynamics TEXT,
  group_dynamics_confidence REAL,
  group_dynamics_source_message_ids TEXT,
  geographic_hints TEXT,
  geographic_hints_confidence REAL,
  geographic_hints_source_message_ids TEXT,
  communication_style TEXT,
  communication_style_confidence REAL,
  communication_style_source_message_ids TEXT,
  occasion_anniversary_date TEXT,
  occasion_anniversary_date_confidence REAL,
  occasion_anniversary_date_source_message_ids TEXT,
  notes_for_sarah TEXT,
  notes_for_sarah_confidence REAL,
  notes_for_sarah_source_message_ids TEXT,

  -- Metadata
  extraction_status TEXT NOT NULL CHECK (extraction_status IN
    ('extracted','deferred_spanish','no_source','extraction_failed')),
  last_attempt_error TEXT,
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,
  extracted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  extraction_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_dossiers_status ON guest_dossiers(extraction_status);
CREATE INDEX idx_dossiers_reviewed ON guest_dossiers(reviewed_by_human);
CREATE INDEX idx_dossiers_why_no_book ON guest_dossiers(why_no_book);
