'use strict';
//
// crm/scripts/seed-experiments.js -- idempotent baseline experiment ledger.
//
// Registers the current control variants so every live LP arm has an experiment
// before paid traffic is evaluated.
//

const path = require('path');
const fs = require('fs');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db');
const ACTIVE_CAMPAIGNS = path.join(ROOT, 'campaigns', 'active-campaigns.json');

(async () => {
  const db = createDB(DB_PATH);
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      kind TEXT,
      bucket TEXT,
      funnel_stage TEXT,
      blast_radius TEXT DEFAULT 'low',
      hypothesis TEXT,
      rationale TEXT,
      change_made TEXT,
      primary_metric TEXT NOT NULL,
      guardrail_metrics TEXT,
      baseline_value TEXT,
      target_value TEXT,
      observation_window TEXT,
      review_at TEXT,
      linked_variant_slug TEXT,
      linked_campaign_id TEXT,
      linked_utm_campaign TEXT,
      result TEXT,
      conclusion TEXT,
      source TEXT DEFAULT 'operator',
      created_by TEXT DEFAULT 'sol',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      concluded_at TEXT
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_exp_status  ON experiments(status)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_exp_variant ON experiments(linked_variant_slug)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_exp_utm     ON experiments(linked_utm_campaign)`);

  const controls = [
    ['exp-weddings-control', 'Weddings control LP', 'weddings-control-en'],
    ['exp-fitness-control', 'Fitness control LP', 'fitness-control-en'],
    ['exp-retreats-control', 'Retreats control LP', 'retreats-control-en'],
    ['exp-planners-control', 'Planner partner-program control LP', 'planners-control-en'],
  ];
  for (const [slug, title, variant] of controls) {
    await db.query(sql`
      INSERT INTO experiments (
        slug, title, status, kind, bucket, funnel_stage, blast_radius,
        hypothesis, rationale, change_made, primary_metric, guardrail_metrics,
        observation_window, linked_variant_slug, source, created_by
      ) VALUES (
        ${slug}, ${title}, 'running', 'lp_variant', 'leads', 'cta', 'low',
        'Control benchmark for resort WhatsApp-click funnel.',
        'Baseline control must stay measurable before challengers are ramped.',
        'Registered existing live control variant in the optimizer ledger.',
        'wa_click_per_qualified', 'qualified_rate,lead_rate,booking_rate',
        '100 qualified sessions per page before promotion or kill decision',
        ${variant}, 'seed', 'sol'
      )
      ON CONFLICT(slug) DO UPDATE SET
        linked_variant_slug = excluded.linked_variant_slug,
        primary_metric = excluded.primary_metric,
        updated_at = datetime('now')
    `);
    console.log(`[seed-exp] ensured ${slug} -> ${variant}`);
  }

  let mirrorCampaigns = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ACTIVE_CAMPAIGNS, 'utf8'));
    if (Array.isArray(parsed)) mirrorCampaigns = parsed;
  } catch (_) {
    mirrorCampaigns = [];
  }
  for (const c of mirrorCampaigns) {
    if (c.status !== 'ACTIVE') continue;
    const slug = c.experiment_slug || `exp-campaign-${c.utm_campaign || c.campaign_id}`;
    await db.query(sql`
      INSERT INTO experiments (
        slug, title, status, kind, bucket, funnel_stage, blast_radius,
        hypothesis, rationale, change_made, primary_metric, guardrail_metrics,
        observation_window, linked_campaign_id, linked_utm_campaign, source, created_by
      ) VALUES (
        ${slug}, ${`Campaign: ${c.campaign_name || c.brief_id || c.campaign_id}`}, 'running', 'meta_campaign',
        ${c.bucket || 'leads'}, 'cta', 'low',
        'Exploratory campaign instrumentation until enough CRM sessions exist.',
        'Active resort campaign must be linked before spend or LP performance is evaluated.',
        'Registered active campaign mirror in the optimizer ledger.',
        'wa_click_per_qualified', 'qualified_rate,lead_rate,booking_rate',
        'Review after 100 qualified sessions or 7 days with zero tracked sessions',
        ${c.campaign_id || null}, ${c.utm_campaign || c.campaign_id || null}, 'seed', 'sol'
      )
      ON CONFLICT(slug) DO UPDATE SET
        linked_campaign_id = excluded.linked_campaign_id,
        linked_utm_campaign = excluded.linked_utm_campaign,
        updated_at = datetime('now')
    `);
    console.log(`[seed-exp] ensured ${slug} -> campaign ${c.campaign_id || c.utm_campaign}`);
  }

  let campaigns = [];
  try {
    campaigns = await db.query(sql`
      SELECT name, meta_campaign_id
      FROM campaigns
      WHERE meta_campaign_id IS NOT NULL
        AND meta_campaign_id <> ''
        AND (status = 'active' OR status = 'ACTIVE')
    `);
  } catch (_) {
    campaigns = [];
  }
  if (mirrorCampaigns.length) campaigns = [];
  for (const c of campaigns) {
    const cid = String(c.meta_campaign_id);
    const slug = `exp-campaign-${cid}`;
    await db.query(sql`
      INSERT INTO experiments (
        slug, title, status, kind, bucket, funnel_stage, blast_radius,
        hypothesis, rationale, change_made, primary_metric, guardrail_metrics,
        observation_window, linked_campaign_id, linked_utm_campaign, source, created_by
      ) VALUES (
        ${slug}, ${`Campaign: ${c.name || cid}`}, 'running', 'meta_campaign', 'leads', 'cta', 'low',
        'Exploratory campaign instrumentation until enough CRM sessions exist.',
        'Active resort campaign must be linked before spend or LP performance is evaluated.',
        'Registered existing active campaign in the optimizer ledger.',
        'wa_click_per_qualified', 'qualified_rate,lead_rate,booking_rate',
        'Review after 100 qualified sessions or 7 days with zero tracked sessions',
        ${cid}, ${cid}, 'seed', 'sol'
      )
      ON CONFLICT(slug) DO UPDATE SET
        linked_campaign_id = excluded.linked_campaign_id,
        linked_utm_campaign = excluded.linked_utm_campaign,
        updated_at = datetime('now')
    `);
    console.log(`[seed-exp] ensured ${slug} -> campaign ${cid}`);
  }
  console.log('[seed-exp] done');
  process.exit(0);
})().catch((e) => {
  console.error('[seed-exp] failed:', e);
  process.exit(1);
});
