-- Migration 001: Outbound Prospector tables
-- Idempotent: safe to re-run (all CREATE TABLE IF NOT EXISTS)
-- Does NOT touch existing leads, events, campaigns tables.

-- contacts: people the prospector has discovered or you imported
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Identity
  first_name TEXT,
  last_name TEXT,
  name TEXT NOT NULL,
  email TEXT,
  email_status TEXT DEFAULT 'unknown',  -- unknown | verified | bounced | invalid
  dedup_key TEXT UNIQUE NOT NULL,       -- email if present, else lower(name||'|'||company||'|'||website)

  -- About them
  company TEXT,
  title TEXT,
  linkedin_url TEXT,
  website TEXT,
  geography TEXT,
  specialties TEXT,
  recent_work TEXT,
  notes TEXT,

  -- Provenance (compliance: must be a business context)
  source TEXT,                           -- 'jason_pv_list' | 'brave_search' | 'manual_slack' | 'referral'
  source_query TEXT,
  context_source TEXT NOT NULL,          -- 'website_contact_page' | 'business_directory' |
                                         -- 'linkedin_business' | 'manual_jason_pv_list' | 'referral'

  -- Lifecycle
  status TEXT DEFAULT 'new',             -- new → queued → contacted → replied → converted → dead
  reply_status TEXT,                     -- positive | negative | unclear | none
  last_contacted_at TEXT,

  -- Suppression flags (denormalized from suppressions for fast filtering)
  do_not_contact BOOLEAN DEFAULT 0,
  do_not_contact_reason TEXT,            -- bounce | complaint | unsubscribe_link | negative_reply | manual
  unsubscribed_at TEXT,
  complained_at TEXT,
  bounced_at TEXT,

  -- Conversion link (the one foreign key, contacts → leads)
  converted_lead_id INTEGER REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_dnc ON contacts(do_not_contact);

-- outreach_campaigns: persona-level groupings
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,             -- 'planner_outreach_v1', 'corporate_retreat_v1'
  persona TEXT,                          -- 'wedding_planner', 'corporate_retreat_coordinator'
  landing_page_url TEXT NOT NULL,
  status TEXT DEFAULT 'active',          -- active | paused | archived
  created_at TEXT DEFAULT (datetime('now'))
);

-- outreach_sends: every email drafted, scheduled, sent
CREATE TABLE IF NOT EXISTS outreach_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  campaign_id INTEGER REFERENCES outreach_campaigns(id),
  sequence_step INTEGER DEFAULT 1,

  subject TEXT NOT NULL,
  body_full TEXT NOT NULL,
  body_preview TEXT,                     -- first 200 chars (display only)
  template_subject_id TEXT,              -- which subject variant was used
  template_body_id TEXT,                 -- which body variant was used

  resend_email_id TEXT,                  -- ID Resend returns at send time (webhook key)

  approved_by TEXT,                      -- Slack user ID who reacted ✅
  approved_at TEXT,

  send_after TEXT,                       -- earliest send time
  scheduled_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  bounced_at TEXT,
  complained_at TEXT,
  reply_detected_at TEXT,
  unsubscribe_detected_at TEXT,
  cancelled_at TEXT,

  status TEXT NOT NULL DEFAULT 'drafted',
  -- drafted → pending_approval → approved → scheduled → sent
  --   → delivered → opened → clicked → replied
  -- terminal: bounced | complained | cancelled
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_contact ON outreach_sends(contact_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_status ON outreach_sends(status);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_resend_id ON outreach_sends(resend_email_id);

-- suppressions: master kill list, queried on every send
CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  email TEXT UNIQUE NOT NULL,
  reason TEXT NOT NULL,                  -- unsubscribe_link | bounce | complaint | negative_reply | manual
  notes TEXT,
  added_by TEXT                          -- 'system_webhook' | 'slack_command:U123' | etc.
);
CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email);

-- compliance_failures: every send blocked by the gate, for diagnostics
CREATE TABLE IF NOT EXISTS compliance_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  contact_id INTEGER REFERENCES contacts(id),
  outreach_send_id INTEGER REFERENCES outreach_sends(id),
  failed_check TEXT NOT NULL,            -- 'physical_address' | 'unsubscribe_link' | 'reason_for_contact' |
                                         -- 'unfilled_template_token' | 'suppression_hit' | etc.
  details TEXT
);
