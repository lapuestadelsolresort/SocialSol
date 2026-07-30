-- Migration 006: Phase R — Reactivation + Voice Service
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/006_reactivation_and_voice.sh
--
-- This file is the canonical DDL reference. The wrapper applies each
-- ALTER / CREATE conditionally so re-runs are no-ops.
--
-- Three concerns:
--   1. Extends contacts/outreach_campaigns/outreach_sends with reactivation columns
--   2. Creates new tables: guest_dossiers, sarah_voice_corpus, voice_drafts_log
--   3. Adds a partial UNIQUE index on contacts.airbnb_account_id
--      (SQLite ALTER TABLE cannot add a UNIQUE constraint; partial index avoids
--       collisions on Paulina's pre-existing rows where airbnb_account_id IS NULL)
--
-- See Project_Status.md "Phase R" for the schema rationale.

-- ── contacts extensions ──────────────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN relationship_type TEXT;
  -- past_guest_stayed | past_guest_cancelled | past_guest_inquired | prospect_planner
ALTER TABLE contacts ADD COLUMN contact_provenance TEXT;
  -- voluntary_share_message | airbnb_thread_only | manual_entry | planner_research
ALTER TABLE contacts ADD COLUMN airbnb_account_id INTEGER;
ALTER TABLE contacts ADD COLUMN airbnb_thread_id INTEGER;
ALTER TABLE contacts ADD COLUMN trip_purpose TEXT;
ALTER TABLE contacts ADD COLUMN last_stay_date TEXT;
ALTER TABLE contacts ADD COLUMN review_rating INTEGER;
ALTER TABLE contacts ADD COLUMN preferred_channel TEXT;
  -- email | whatsapp | airbnb_thread
ALTER TABLE contacts ADD COLUMN phone TEXT;

CREATE UNIQUE INDEX idx_contacts_airbnb_account_id
  ON contacts(airbnb_account_id)
  WHERE airbnb_account_id IS NOT NULL;
CREATE INDEX idx_contacts_relationship_type ON contacts(relationship_type);
CREATE INDEX idx_contacts_provenance ON contacts(contact_provenance);

-- ── outreach_campaigns extensions ────────────────────────────────────────
ALTER TABLE outreach_campaigns ADD COLUMN campaign_kind TEXT;
  -- cold_outbound | reactivation_anniversary | reactivation_winback |
  -- reactivation_referral | reactivation_conversion | reactivation_vip |
  -- reactivation_feedback_closure | inbound_inquiry_response
ALTER TABLE outreach_campaigns ADD COLUMN owning_agent TEXT;
  -- paulina | regina | sol

-- ── outreach_sends extensions ────────────────────────────────────────────
ALTER TABLE outreach_sends ADD COLUMN send_method TEXT;
  -- resend | manual_email | manual_whatsapp | manual_airbnb_thread
ALTER TABLE outreach_sends ADD COLUMN draft_text TEXT;
ALTER TABLE outreach_sends ADD COLUMN sent_text TEXT;
ALTER TABLE outreach_sends ADD COLUMN edit_distance INTEGER;
ALTER TABLE outreach_sends ADD COLUMN slack_thread_ts TEXT;
ALTER TABLE outreach_sends ADD COLUMN sent_by_user_id TEXT;

-- ── guest_dossiers ───────────────────────────────────────────────────────
-- One row per contact. R1 leaves this empty; R4 (dossier extraction job)
-- populates it from messages.json via Claude Sonnet 4.6.
CREATE TABLE IF NOT EXISTS guest_dossiers (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id),
  trip_purpose TEXT,
  why_no_book TEXT,                        -- price | dates_unavailable | no_response | went_elsewhere | other
  why_no_book_confidence REAL,             -- 0.0 – 1.0
  excitement_signals TEXT,                 -- free text
  objections TEXT,
  specific_features TEXT,                  -- features they mentioned wanting
  dates_targeted TEXT,
  group_dynamics TEXT,
  decision_timeline TEXT,
  geographic_hints TEXT,
  language TEXT,
  communication_style TEXT,
  occasion_anniversary_date TEXT,
  notes_for_sarah TEXT,
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ── sarah_voice_corpus ───────────────────────────────────────────────────
-- Every Sarah-authored message. R1 seeds from Airbnb messages.json;
-- R2 indexes into Chroma; future rows arrive incrementally from Gmail/WhatsApp.
CREATE TABLE IF NOT EXISTS sarah_voice_corpus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                    -- airbnb_messages | gmail | whatsapp
  source_id TEXT NOT NULL,                 -- thread/conversation id within source
  message_id TEXT NOT NULL,                -- platform message id (string; Airbnb uses large ints)
  contact_id INTEGER REFERENCES contacts(id),
    -- Resolved at ingestion via thread non-host participant → contacts.airbnb_account_id.
    -- NULL if the thread's other party isn't in the 218-contact directory.
    -- Stored on the row (not derived via JOIN) because contacts.airbnb_thread_id only holds
    -- the most recent thread per contact — older threads from repeat guests would lose linkage.
  direction TEXT NOT NULL,                 -- outbound (inbound deferred per Phase R spec)
  sent_at TEXT NOT NULL,
  body TEXT NOT NULL,
  intent_tags TEXT,                        -- JSON array, NULL until tagging step
  recipient_relationship TEXT,             -- VESTIGIAL: never populated. The indexer
                                           --   derives recipient_relationship by JOINing
                                           --   sarah_voice_corpus.contact_id ->
                                           --   contacts.relationship_type and writes ONLY
                                           --   to Chroma metadata. To query, JOIN to
                                           --   contacts; this column always reads NULL.
                                           --   See crm/scripts/index-voice-corpus.js
                                           --   deriveRecipientRelationship for rationale.
  language TEXT NOT NULL DEFAULT 'en',
  word_count INTEGER NOT NULL,
  embedding_status TEXT NOT NULL DEFAULT 'pending',  -- pending | indexed | failed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(source, source_id, message_id)
);
CREATE INDEX idx_voice_corpus_status ON sarah_voice_corpus(language, embedding_status);
CREATE INDEX idx_voice_corpus_contact ON sarah_voice_corpus(contact_id);

-- ── voice_drafts_log ─────────────────────────────────────────────────────
-- Every Voice Service draft. R3 wires the writes; R1 only creates the table.
CREATE TABLE IF NOT EXISTS voice_drafts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent TEXT NOT NULL,                    -- reactivation_* | inbound_inquiry_response | cold_outbound_planner | ad_hoc
  agent TEXT NOT NULL,                     -- regina | paulina | sol
  contact_id INTEGER REFERENCES contacts(id),
  draft_text TEXT NOT NULL,
  retrieved_example_ids TEXT,              -- JSON array of sarah_voice_corpus.id
  cost_usd REAL,
  outcome TEXT NOT NULL DEFAULT 'pending', -- pending | sent_as_is | sent_with_edits | discarded
  edit_distance INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_voice_drafts_agent ON voice_drafts_log(agent);
CREATE INDEX idx_voice_drafts_outcome ON voice_drafts_log(outcome);

-- Verification (tail of migration runs)
SELECT 'contacts new columns:' AS info;
SELECT name FROM pragma_table_info('contacts')
  WHERE name IN ('relationship_type','contact_provenance','airbnb_account_id',
                 'airbnb_thread_id','trip_purpose','last_stay_date',
                 'review_rating','preferred_channel','phone');

SELECT 'new tables:' AS info;
SELECT name FROM sqlite_master WHERE type='table'
  AND name IN ('guest_dossiers','sarah_voice_corpus','voice_drafts_log')
  ORDER BY name;
