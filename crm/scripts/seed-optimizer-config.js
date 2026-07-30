'use strict';
//
// crm/scripts/seed-optimizer-config.js -- idempotent resort optimizer defaults.
//
// Values are JSON-encoded so Python and Node callers parse the same shape. The
// seed never overwrites an operator edit; it only fills missing keys.
//

const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db');

const DEFAULTS = {
  meta_mode: 'propose',
  budget_cap_daily: 0.0,
  bucket_split: { reach: 0.35, engagement: 0.35, leads: 0.30 },
  bucket_split_ramp: { weeks: 6, target: { reach: 0.20, engagement: 0.30, leads: 0.50 } },
  bucket_split_started_at: new Date().toISOString().slice(0, 10),
  reward_weights: { qualified_session: 0.10, cta_view: 0.20, whatsapp_click: 1.0, lead: 1.5, booking: 4.0 },
  promotion_gate_qualified: 100,
  exploration_floor_share: 0.15,
  ceilings: { cost_per_whatsapp_click_max: 45.0, zero_click_spend_pause: 35.0 },
  change_limits: { max_new_variants_per_day: 3, max_weight_delta_per_pass: 0.25 },
  rollback_window_sessions: 150,
  pause_all: false,
};

(async () => {
  const db = createDB(DB_PATH);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS optimizer_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS bandit_arms (
      arm_id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      bucket TEXT NOT NULL,
      metric TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1.0,
      beta REAL NOT NULL DEFAULT 1.0,
      n_qualified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      pass_id TEXT,
      actor TEXT DEFAULT 'optimizer',
      action TEXT NOT NULL,
      target_kind TEXT,
      target_id TEXT,
      before TEXT,
      after TEXT,
      rationale TEXT
    )
  `);
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS budget_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      bucket TEXT NOT NULL,
      variant_id INTEGER,
      meta_object_id TEXT,
      planned_spend REAL DEFAULT 0,
      actual_spend REAL DEFAULT 0,
      sessions INTEGER DEFAULT 0,
      qualified_sessions INTEGER DEFAULT 0,
      cta_views INTEGER DEFAULT 0,
      cta_clicks INTEGER DEFAULT 0,
      leads INTEGER DEFAULT 0,
      bookings INTEGER DEFAULT 0,
      reconciled_at TEXT
    )
  `);
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS optimizer_compliance_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      draft_id TEXT,
      channel TEXT,
      failed_check TEXT,
      details TEXT,
      source TEXT DEFAULT 'agent_generated'
    )
  `);
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS meta_smoke_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT
    )
  `);

  let seeded = 0;
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const before = await db.query(sql`SELECT key FROM optimizer_config WHERE key = ${key}`);
    if (before.length) {
      console.log(`[seed-cfg] keep   ${key} (already set)`);
      continue;
    }
    await db.query(sql`
      INSERT INTO optimizer_config (key, value)
      VALUES (${key}, ${JSON.stringify(value)})
      ON CONFLICT(key) DO NOTHING
    `);
    console.log(`[seed-cfg] seed   ${key} = ${JSON.stringify(value)}`);
    seeded += 1;
  }
  console.log(`[seed-cfg] done (${seeded} key(s) seeded, ${Object.keys(DEFAULTS).length - seeded} kept)`);
  process.exit(0);
})().catch((e) => {
  console.error('[seed-cfg] failed:', e);
  process.exit(1);
});
