-- 013: Gmail reply forwarder — dedupe table for gmail-reply-forwarder.js
CREATE TABLE IF NOT EXISTS processed_gmail_replies (
  message_id   TEXT PRIMARY KEY,
  forwarded_at TEXT NOT NULL,
  send_id      INTEGER,
  matched      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pgr_forwarded_at ON processed_gmail_replies(forwarded_at);
