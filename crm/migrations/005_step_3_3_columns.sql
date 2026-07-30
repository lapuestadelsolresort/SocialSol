-- Migration 005: Step 3.3 — orchestrator + threshold tracking.
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/005_step_3_3_columns.sh
--
-- This migration adds:
--   1. outreach_sends.send_attempted_at — diagnostic timestamp stamped by
--      orchestrator.js on every gate-attempt, distinct from sent_at (only on
--      Resend 200) and scheduled_at (set at approve time). Useful for triage
--      of "why did this row sit at approved for 6 hours?"
--   2. compliance_failures.source value rename: 'send_pipeline' → 'send_time'.
--      The column itself was added in migration 004; this rename aligns with
--      the spec §6 enum (compose | send_time | edit_override | send_time_override).
--      Two new orchestrator-time values are introduced at the application layer:
--        - 'send_time'          (orchestrator's gate fail on a normal-path row)
--        - 'send_time_override' (gate fail on a row with prior edit_override)
--      No SQL ALTER COLUMN needed — the field is TEXT, valid values are
--      enforced at write-time in orchestrator.js + compliance.js + server.js.
--
-- IMPORTANT — outreach_sends.send_after stays NULL by design.
--   The column existed since migration 001 with the comment "earliest send time",
--   but 3.3's orchestrator queues solely on scheduled_at (`SELECT ... WHERE
--   scheduled_at <= datetime('now')`). The spec's §3.2 algorithm computes
--   scheduled_at directly with all jitter/window logic baked in — there is
--   no separate "earliest" bound to express. The approve handler does NOT
--   write send_after. Documented here so a future maintainer doesn't try to
--   make both columns authoritative and get them out of sync.

-- ── outreach_sends.send_attempted_at ─────────────────────────────────────
ALTER TABLE outreach_sends ADD COLUMN send_attempted_at TEXT;

-- ── compliance_failures source value rename ──────────────────────────────
-- One-shot: any historical 'send_pipeline' rows from migration 004 era
-- get their source aligned with the spec §6 enum. New writes from
-- compliance.js and orchestrator.js use 'send_time' going forward.
UPDATE compliance_failures SET source = 'send_time' WHERE source = 'send_pipeline';

-- ── Verification ─────────────────────────────────────────────────────────
SELECT 'outreach_sends.send_attempted_at present:' AS info;
SELECT name FROM pragma_table_info('outreach_sends') WHERE name='send_attempted_at';

SELECT 'compliance_failures.source value distribution:' AS info;
SELECT source, COUNT(*) AS n FROM compliance_failures GROUP BY source ORDER BY n DESC;
