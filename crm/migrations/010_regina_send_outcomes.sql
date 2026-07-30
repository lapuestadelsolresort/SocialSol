-- Migration 010: Phase R — R5 Regina send outcomes + R3 feedback loop
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/010_regina_send_outcomes.sh
--
-- This file is the canonical DDL reference. The wrapper applies each
-- ALTER / CREATE conditionally so re-runs are no-ops.
--
-- Adds outreach_sends columns Regina needs for !skip / !defer / re-queue
-- sweep / long-draft message split, and the FK linking each send to its
-- voice_drafts_log row so terminal commands can close the R3 feedback loop.
--
-- Status enum stays code-enforced (TEXT). New values 'rejected' and
-- 'deferred' join the existing { drafted | pending_approval | approved |
-- scheduled | sent | delivered | opened | clicked | replied | bounced |
-- complained | cancelled } set at the application layer — no DDL change.

-- ── outreach_sends extensions ────────────────────────────────────────────
ALTER TABLE outreach_sends ADD COLUMN defer_until TEXT;
  -- ISO timestamp; populated by !defer N
ALTER TABLE outreach_sends ADD COLUMN skip_reason TEXT;
  -- Free text from !skip <reason>; also 'auto_suppressed_unactioned_3x'
ALTER TABLE outreach_sends ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;
  -- Bumped each time the 14-day reminder fires (0..3)
ALTER TABLE outreach_sends ADD COLUMN last_reminded_at TEXT;
  -- ISO timestamp of the most recent reminder post
ALTER TABLE outreach_sends ADD COLUMN slack_body_ts TEXT;
  -- Only set when long-draft split required: ts of the threaded reply that
  -- carries <<DRAFT_BODY>>\n<draft>; NULL means draft body lives in the
  -- top-level message itself.
ALTER TABLE outreach_sends ADD COLUMN voice_drafts_log_id INTEGER
  REFERENCES voice_drafts_log(id);
  -- FK to the voice_drafts_log row created by the Voice Service. Lets
  -- sent.js / skip.js / gmail-reconcile.js close the R3 feedback loop
  -- (outcome: pending → sent_as_is | sent_with_edits | discarded).

-- ── indexes ──────────────────────────────────────────────────────────────
CREATE INDEX idx_outreach_sends_defer_until
  ON outreach_sends(defer_until)
  WHERE defer_until IS NOT NULL;

CREATE INDEX idx_outreach_sends_status_reminder
  ON outreach_sends(status, last_reminded_at)
  WHERE status = 'drafted';

CREATE INDEX idx_outreach_sends_slack_thread_ts
  ON outreach_sends(slack_thread_ts)
  WHERE slack_thread_ts IS NOT NULL;

CREATE INDEX idx_outreach_sends_voice_drafts_log_id
  ON outreach_sends(voice_drafts_log_id)
  WHERE voice_drafts_log_id IS NOT NULL;
