-- Migration 007: source_account_id on sarah_voice_corpus
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/007_voice_corpus_source_account.sh
--
-- Phase R uses multiple Sarah-voice accounts:
--   121885415 — Sarah's primary account (1,082 messages)
--   510010203 — older account in the same warm-host register (~211 messages)
--
-- The voice service (R3) and any future audit (e.g. "do drafts modeled on
-- alt-Sarah's messages get edited more heavily?") need to know which account
-- each message came from. Storing it on the row beats inferring from the
-- source string and beats joining against participants later.
--
-- This column is also forward-compatible with Gmail/WhatsApp ingestion in R3+:
-- those sources will carry their own per-platform account identity (Gmail
-- address numeric id, WhatsApp business id, etc).
--
-- Backfill: existing 993 rows (all from Airbnb messages.json) are tagged with
-- 121885415 — the only account in scope at R1's first ingest. The backfill
-- is guarded by `WHERE source_account_id IS NULL` so re-runs are no-ops.

ALTER TABLE sarah_voice_corpus ADD COLUMN source_account_id INTEGER;

CREATE INDEX idx_voice_corpus_source_account ON sarah_voice_corpus(source_account_id);

-- One-time backfill for rows that pre-date this column.
UPDATE sarah_voice_corpus
   SET source_account_id = 121885415
 WHERE source_account_id IS NULL
   AND source = 'airbnb_messages';

-- Verification
SELECT 'sarah_voice_corpus by source_account_id:' AS info;
SELECT source_account_id, COUNT(*) FROM sarah_voice_corpus
  GROUP BY source_account_id ORDER BY COUNT(*) DESC;
