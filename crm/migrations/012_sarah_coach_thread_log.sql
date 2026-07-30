-- Migration 012: Phase R — R7 sarah-coach thread mapping + voice_drafts_log.sent_text
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/012_sarah_coach_thread_log.sh
--
-- Two changes for R7:
--   1. New table sarah_coach_thread_log: maps a Slack thread_ts (top-level
--      ts of a sarah-coach draft post) → voice_drafts_log_id, so the
--      !sent / !edit handlers in sarah-coach/scripts/outcome.js can
--      resolve which draft the user is acting on without scanning
--      voice_drafts_log by timestamp.
--   2. New column voice_drafts_log.sent_text: lets sarah-coach !edit log
--      the actual text Sarah sent (regina stores this on outreach_sends.sent_text,
--      but sarah-coach has no outreach_sends row, so we add it here so the
--      R3 feedback corpus stays complete).

-- ── sarah_coach_thread_log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sarah_coach_thread_log (
  thread_ts TEXT PRIMARY KEY,
  voice_drafts_log_id INTEGER NOT NULL REFERENCES voice_drafts_log(id),
  posted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sarah_coach_thread_log_log_id
  ON sarah_coach_thread_log(voice_drafts_log_id);

-- ── voice_drafts_log.sent_text ───────────────────────────────────────────
ALTER TABLE voice_drafts_log ADD COLUMN sent_text TEXT;
  -- Populated by sarah-coach/scripts/outcome.js when Sarah !edits a draft.
  -- regina populates outreach_sends.sent_text instead (one-shot inbounds
  -- have no outreach_sends row). NULL for sent_as_is and discarded outcomes.
