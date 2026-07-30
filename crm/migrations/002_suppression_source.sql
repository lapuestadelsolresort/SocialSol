-- Migration 002: add source column to suppressions
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/002_suppression_source.sh
--
-- Or apply directly (one-shot — re-runs error on the ALTER):
--   sqlite3 crm/data/crm.db < crm/migrations/002_suppression_source.sql
--
-- The new `source` column distinguishes provenance of suppression rows:
--   'resend_webhook'    — bounce / complaint / Resend-detected unsubscribe
--   'unsubscribe_link'  — recipient clicked the public unsubscribe endpoint
--   'slack_command'     — manual !dnc from #prospector-paulina
--   'legacy'            — pre-migration rows backfilled by this script
--   NULL                — caller didn't pass a source (acceptable)
--
-- `source` is intentionally orthogonal to `reason` (the existing category column).
-- reason  = what kind of suppression (bounce | complaint | unsubscribe_link | manual | negative_reply)
-- source  = which lever fired the suppression
-- Same string can appear in both columns (e.g. unsubscribe_link) without
-- conflict; the columns answer different questions.

ALTER TABLE suppressions ADD COLUMN source TEXT;

UPDATE suppressions SET source = 'legacy' WHERE source IS NULL;

-- Verification output
SELECT 'suppressions schema:' AS info;
SELECT sql FROM sqlite_master WHERE type='table' AND name='suppressions';

SELECT 'rows by source:' AS info;
SELECT source, COUNT(*) AS n FROM suppressions GROUP BY source;
