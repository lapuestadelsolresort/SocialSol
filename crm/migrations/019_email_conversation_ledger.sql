-- 019: Durable email conversation ledger and confirmation-gated Slack replies.
-- Runtime startup also applies this shape through crm/lib/workflow-schema.js.

-- The legacy table originated in crm/server.js rather than migration 001.
-- Creating that exact base shape makes a fresh ordered migration run and an
-- upgrade of the production table converge on the same additive ALTERs below.
CREATE TABLE IF NOT EXISTS email_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  contact_id INTEGER REFERENCES contacts(id),
  outreach_send_id INTEGER REFERENCES outreach_sends(id),
  direction TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  resend_email_id TEXT,
  from_address TEXT,
  to_address TEXT,
  received_at TEXT,
  sentiment TEXT,
  sentiment_notes TEXT,
  forwarded_to TEXT
);

ALTER TABLE email_threads ADD COLUMN provider TEXT NOT NULL DEFAULT 'gmail';
ALTER TABLE email_threads ADD COLUMN provider_message_id TEXT;
ALTER TABLE email_threads ADD COLUMN provider_thread_id TEXT;
ALTER TABLE email_threads ADD COLUMN rfc_message_id TEXT;
ALTER TABLE email_threads ADD COLUMN in_reply_to TEXT;
ALTER TABLE email_threads ADD COLUMN references_header TEXT;
ALTER TABLE email_threads ADD COLUMN raw_body_text TEXT;
ALTER TABLE email_threads ADD COLUMN actor_user_id TEXT;
ALTER TABLE email_threads ADD COLUMN classification_source TEXT;
ALTER TABLE email_threads ADD COLUMN classified_at TEXT;
ALTER TABLE email_threads ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE email_threads ADD COLUMN processing_error TEXT;
ALTER TABLE email_threads ADD COLUMN processed_at TEXT;
ALTER TABLE email_threads ADD COLUMN slack_channel_id TEXT;
ALTER TABLE email_threads ADD COLUMN slack_thread_ts TEXT;
ALTER TABLE email_threads ADD COLUMN slack_message_ts TEXT;
ALTER TABLE email_threads ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id);
ALTER TABLE email_threads ADD COLUMN workflow_effect_id TEXT REFERENCES workflow_effects(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_provider_message
  ON email_threads(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_processing
  ON email_threads(processing_status, received_at);
CREATE INDEX IF NOT EXISTS idx_email_threads_outreach_send
  ON email_threads(outreach_send_id, received_at);

CREATE TABLE IF NOT EXISTS email_reply_proposals (
  id TEXT PRIMARY KEY,
  outreach_send_id INTEGER NOT NULL REFERENCES outreach_sends(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  inbound_email_thread_id INTEGER NOT NULL REFERENCES email_threads(id),
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  acceptance_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_by TEXT NOT NULL,
  confirmed_by TEXT,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  proposal_run_id TEXT REFERENCES workflow_runs(id),
  confirmation_run_id TEXT REFERENCES workflow_runs(id),
  provider_message_id TEXT,
  provider_thread_id TEXT,
  workflow_effect_id TEXT REFERENCES workflow_effects(id),
  processing_error TEXT,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_reply_proposals_status
  ON email_reply_proposals(status, expires_at);
