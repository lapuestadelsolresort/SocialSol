-- 014: Direct-email importer staging table for import-direct-email-contacts.js.
-- One row per Gmail thread the importer has classified. Rows live here until
-- a human approves or rejects them; approved rows then flow through
-- apply-staging-approvals.js into the live `contacts` table.
CREATE TABLE IF NOT EXISTS pending_contacts_staging (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id           TEXT NOT NULL UNIQUE,
  extracted_email     TEXT NOT NULL,
  extracted_name      TEXT,
  thread_subject      TEXT,
  thread_snippet      TEXT,
  first_message_at    TEXT,
  last_message_at     TEXT,
  message_count       INTEGER,
  llm_classification  TEXT,
  llm_category        TEXT,
  llm_confidence      REAL,
  llm_reasoning       TEXT,
  existing_contact_id INTEGER,
  suggested_action    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  batch_id            TEXT NOT NULL,
  reviewed_at         TEXT,
  reviewed_by         TEXT,
  applied_at          TEXT,
  applied_contact_id  INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pcs_status ON pending_contacts_staging(status);
CREATE INDEX IF NOT EXISTS idx_pcs_batch  ON pending_contacts_staging(batch_id);
CREATE INDEX IF NOT EXISTS idx_pcs_email  ON pending_contacts_staging(extracted_email);
