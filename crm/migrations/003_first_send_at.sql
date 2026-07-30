-- Migration 003: add first_send_at to outreach_campaigns
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/003_first_send_at.sh
--
-- Or apply directly (one-shot — re-runs error on the ALTER):
--   sqlite3 crm/data/crm.db < crm/migrations/003_first_send_at.sql
--
-- The compliance gate (Phase D Step 3.1b) needs `first_send_at` to compute
-- which weekly send cap applies for the current calendar week:
--   cap_index = calendar_weeks_since_first_send + 1
--   cap = config.weekly_send_caps['week_' + cap_index]  (falls back to week_4_plus)
-- NULL means "campaign hasn't sent yet" — gate treats this as cap_index 1.
--
-- send.sh (or the Step 3.3 orchestrator) is responsible for stamping this
-- column on the FIRST successful send for a campaign:
--   UPDATE outreach_campaigns SET first_send_at = datetime('now')
--   WHERE id = ? AND first_send_at IS NULL;

ALTER TABLE outreach_campaigns ADD COLUMN first_send_at TEXT;

-- Verification output
SELECT 'outreach_campaigns schema:' AS info;
SELECT sql FROM sqlite_master WHERE type='table' AND name='outreach_campaigns';

SELECT 'campaigns + first_send_at status:' AS info;
SELECT id, name, first_send_at FROM outreach_campaigns;
