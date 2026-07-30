-- Migration 011 — vip + feedback_closure infrastructure (Phase R6).
--
-- This .sql is the canonical DDL reference. Idempotency lives in the
-- accompanying .sh wrapper (mirrors 010_regina_send_outcomes.sh).
--
-- Adds three columns to contacts:
--   reservation_count    — used by `vip` campaign eligibility (>=2 to qualify).
--                          NOT backfilled in R6; defaults to 0. Backfill is a
--                          separate R6.5+ sub-task.
--   has_private_feedback — used by `feedback_closure` campaign eligibility.
--                          NOT backfilled in R6; defaults to 0. Definition +
--                          backfill is a separate R6.5+ sub-task.
--   addressable          — derived from contact_provenance + email/phone
--                          presence. Backfilled in the .sh wrapper.
--
-- Plus two partial indexes to keep the eligibility queries fast.

ALTER TABLE contacts ADD COLUMN reservation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN has_private_feedback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN addressable INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_contacts_reservation_count
  ON contacts(reservation_count)
  WHERE reservation_count >= 2;

CREATE INDEX idx_contacts_feedback_closure
  ON contacts(has_private_feedback, addressable)
  WHERE has_private_feedback = 1 AND addressable = 1;

-- One-shot backfill (also lives in the .sh runner so re-runs converge).
UPDATE contacts SET addressable = CASE
  WHEN COALESCE(contact_provenance, '') != 'airbnb_thread_only'
       AND (email IS NOT NULL OR phone IS NOT NULL)
  THEN 1 ELSE 0 END;
