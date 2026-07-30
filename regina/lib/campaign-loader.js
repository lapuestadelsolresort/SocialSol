'use strict';
//
// campaign-loader.js — read regina/library/campaigns/<slug>.json + the
// referenced eligibility SQL, validate the strategy file, and bind named
// params (`:batch_size`, `:today`) into the SQL text.
//
// Used by:
//   - regina/scripts/batch.js          (interactive !batch <slug>)
//   - regina/scripts/anniversary-cron.js (daily 09:00 cron)
//
// SQL parameter binding is by string substitution because @databases/sql
// uses tagged templates, not :foo placeholders. Substitution is safe
// ONLY because bindParams() rejects non-integer batch_size and any
// today value that fails the YYYY-MM-DD regex.

const fs = require('fs');
const path = require('path');
const { INTENT_SET } = require('../../crm/lib/voice-intents');

const REGINA_ROOT = path.resolve(__dirname, '..');
const CAMPAIGNS_DIR = path.join(REGINA_ROOT, 'library', 'campaigns');

// Authoritative campaign_kind list. Must match migration 006's column
// comment + 'ad_hoc' added in R5. Drift would silently let through
// strategy files whose campaign_kind never gets matched by the
// 'already contacted' eligibility filter.
const CAMPAIGN_KINDS = new Set([
  'cold_outbound',
  'reactivation_anniversary',
  'reactivation_winback',
  'reactivation_referral',
  'reactivation_conversion',
  'reactivation_vip',
  'reactivation_feedback_closure',
  'inbound_inquiry_response',
  'ad_hoc',
]);

const RECIPIENT_RELATIONSHIPS = new Set([
  'past_guest_stayed',
  'past_guest_inquired',
  'past_guest_cancelled',
  'prospect_planner',
  'unknown',
]);

const OWNING_AGENTS = new Set(['regina', 'paulina', 'sol', 'adhoc']);

const REQUIRED_FIELDS = [
  'slug',
  'name',
  'campaign_kind',
  'intent',
  'owning_agent',
  'recipient_relationship',
  'language',
  'description',
  'landing_page_url',
  'prompt_context',
];

function validate(config, slug) {
  for (const f of REQUIRED_FIELDS) {
    if (config[f] == null || config[f] === '') {
      throw new Error(`campaign ${slug}: missing required field '${f}'`);
    }
  }
  if (config.slug !== slug) {
    throw new Error(`campaign ${slug}: file slug='${config.slug}' does not match filename`);
  }
  if (!CAMPAIGN_KINDS.has(config.campaign_kind)) {
    throw new Error(`campaign ${slug}: unknown campaign_kind '${config.campaign_kind}'`);
  }
  if (!INTENT_SET.has(config.intent)) {
    throw new Error(`campaign ${slug}: unknown intent '${config.intent}' (see crm/lib/voice-intents.js)`);
  }
  if (!OWNING_AGENTS.has(config.owning_agent)) {
    throw new Error(`campaign ${slug}: unknown owning_agent '${config.owning_agent}'`);
  }
  if (!RECIPIENT_RELATIONSHIPS.has(config.recipient_relationship)) {
    throw new Error(`campaign ${slug}: unknown recipient_relationship '${config.recipient_relationship}'`);
  }
  if (config.language !== 'en') {
    throw new Error(`campaign ${slug}: only language='en' is supported in Phase R (got '${config.language}')`);
  }

  const hasSql = typeof config.eligibility_sql_path === 'string' && config.eligibility_sql_path.length > 0;
  const hasIds = Array.isArray(config.contact_ids);
  if (hasSql === hasIds) {
    // Either both or neither — both invalid.
    throw new Error(
      `campaign ${slug}: must specify exactly one of eligibility_sql_path (real campaign) or contact_ids (smoke escape hatch); got ${hasSql ? 'both' : 'neither'}`
    );
  }
  if (hasSql) {
    if (!Number.isInteger(config.default_batch_size) || config.default_batch_size < 1 || config.default_batch_size > 100) {
      throw new Error(`campaign ${slug}: default_batch_size must be an integer 1..100`);
    }
  }
}

function loadSqlText(config, slug) {
  if (!config.eligibility_sql_path) return null;
  const sqlPath = path.resolve(REGINA_ROOT, config.eligibility_sql_path);
  if (!sqlPath.startsWith(REGINA_ROOT + path.sep)) {
    throw new Error(`campaign ${slug}: eligibility_sql_path escapes regina root: ${config.eligibility_sql_path}`);
  }
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`campaign ${slug}: eligibility SQL not found at ${sqlPath}`);
  }
  return fs.readFileSync(sqlPath, 'utf8');
}

/**
 * Substitute :batch_size and :today into the SQL text. Strict regex/integer
 * gates — any caller-supplied today is verified before substitution.
 */
function bindParams(sqlText, { batchSize, today }) {
  const n = Number(batchSize);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`bindParams: batchSize must be int 1..100, got ${batchSize}`);
  }
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`bindParams: today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }
  return sqlText
    .replace(/:batch_size\b/g, String(n))
    .replace(/:today\b/g, `'${today}'`);
}

/**
 * Load a campaign strategy file by slug.
 *
 * @returns {{
 *   config: object,
 *   sqlText: string|null,
 *   bindParams: (params: {batchSize:number, today:string}) => string|null
 * }}
 */
function loadCampaign(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9_]+$/.test(slug)) {
    throw new Error(`loadCampaign: slug must be lowercase alphanumeric+underscore, got ${JSON.stringify(slug)}`);
  }
  const cfgPath = path.join(CAMPAIGNS_DIR, `${slug}.json`);
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`loadCampaign: strategy file not found at ${cfgPath}`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error(`loadCampaign: ${slug}.json is not valid JSON: ${e.message}`);
  }
  validate(config, slug);
  const sqlText = loadSqlText(config, slug);
  return {
    config,
    sqlText,
    bindParams: (params) => (sqlText ? bindParams(sqlText, params) : null),
  };
}

module.exports = {
  loadCampaign,
  bindParams,
  CAMPAIGN_KINDS,
  RECIPIENT_RELATIONSHIPS,
  OWNING_AGENTS,
  REGINA_ROOT,
};
