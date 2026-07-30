-- Migration 004: Step 3.2 — composer + dispatcher columns.
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/004_step_3_2_columns.sh
--
-- This migration adds:
--   1. outreach_campaigns: slug, persona_brief_path, description, created_by.
--      slug becomes the operator-facing identifier (vs. `name`, retained for display).
--   2. campaign_contacts: many-to-many junction so contacts can be attached to a
--      campaign before any draft exists. Today the only campaign↔contact link is
--      via outreach_sends.campaign_id, which is too late.
--   3. outreach_sends: composer + dispatcher fields (hook_angle, composer_inputs,
--      slack_message_ts, slack_channel_id, posted_at, rejection/edit metadata).
--   4. contacts: lead_quality (reply-disposition; separate from `status` lifecycle).
--   5. compliance_failures: source — distinguishes send-pipeline gate fails from
--      edit-override gate fails (logged for audit but don't block the auto-approve).

-- ── outreach_campaigns ────────────────────────────────────────────────────
ALTER TABLE outreach_campaigns ADD COLUMN slug TEXT;
ALTER TABLE outreach_campaigns ADD COLUMN persona_brief_path TEXT;
ALTER TABLE outreach_campaigns ADD COLUMN description TEXT;
ALTER TABLE outreach_campaigns ADD COLUMN created_by TEXT;

-- Backfill slug from name for any existing campaign so the unique index below
-- doesn't fail. Going forward, !new-campaign writes both name and slug.
UPDATE outreach_campaigns SET slug = name WHERE slug IS NULL;

-- Enforce uniqueness on slug. SQLite does not allow ALTER TABLE ADD COLUMN with
-- inline UNIQUE; using a unique index is the standard workaround.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_slug ON outreach_campaigns(slug);

-- ── campaign_contacts ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES outreach_campaigns(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  attached_at TEXT NOT NULL DEFAULT (datetime('now')),
  attached_by TEXT,
  UNIQUE(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_contact ON campaign_contacts(contact_id);

-- ── outreach_sends ────────────────────────────────────────────────────────
ALTER TABLE outreach_sends ADD COLUMN hook_angle TEXT;
ALTER TABLE outreach_sends ADD COLUMN composer_inputs TEXT;     -- JSON: {persona_id, model, attempt, ...}
ALTER TABLE outreach_sends ADD COLUMN slack_message_ts TEXT;
ALTER TABLE outreach_sends ADD COLUMN slack_channel_id TEXT;
ALTER TABLE outreach_sends ADD COLUMN posted_at TEXT;
ALTER TABLE outreach_sends ADD COLUMN rejected_reason TEXT;
ALTER TABLE outreach_sends ADD COLUMN rejected_by TEXT;
ALTER TABLE outreach_sends ADD COLUMN edited_by TEXT;
ALTER TABLE outreach_sends ADD COLUMN edited_at TEXT;
ALTER TABLE outreach_sends ADD COLUMN edit_history TEXT;        -- JSON array of prior versions

-- ── contacts ─────────────────────────────────────────────────────────────
-- lead_quality is reply-disposition; orthogonal to the `status` lifecycle.
-- Values: hot | not_interested | ambiguous | unset (NULL = unset).
ALTER TABLE contacts ADD COLUMN lead_quality TEXT;

-- ── compliance_failures ──────────────────────────────────────────────────
-- source distinguishes who triggered the gate evaluation:
--   'send_pipeline' (default) — send.sh hard-fail at send time
--   'edit_override'           — Sarah/Jason edit-modal saved content that
--                               failed the gate; auto-approved anyway, but
--                               logged here for audit.
ALTER TABLE compliance_failures ADD COLUMN source TEXT DEFAULT 'send_pipeline';

-- ── Verification ─────────────────────────────────────────────────────────
SELECT 'outreach_campaigns columns:' AS info;
SELECT name, type FROM pragma_table_info('outreach_campaigns');

SELECT 'campaign_contacts exists:' AS info;
SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_contacts';

SELECT 'outreach_sends new columns present:' AS info;
SELECT name FROM pragma_table_info('outreach_sends')
WHERE name IN ('hook_angle','composer_inputs','slack_message_ts','slack_channel_id',
               'posted_at','rejected_reason','rejected_by','edited_by','edited_at','edit_history');

SELECT 'contacts.lead_quality present:' AS info;
SELECT name FROM pragma_table_info('contacts') WHERE name='lead_quality';

SELECT 'compliance_failures.source present:' AS info;
SELECT name FROM pragma_table_info('compliance_failures') WHERE name='source';

SELECT 'campaigns + slug status:' AS info;
SELECT id, name, slug FROM outreach_campaigns;
