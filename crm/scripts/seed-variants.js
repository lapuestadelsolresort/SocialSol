'use strict';
//
// crm/scripts/seed-variants.js — idempotent seed for every landing-page variant
// config in lp/variants/*.json.
//
// Safe to run repeatedly: variants are upserted by slug (insert new, update
// config of existing). Tenancy is page_slug (weddings|fitness|retreats) — no
// partners/stores. Creates the LP tables IF NOT EXISTS so it works standalone
// even before the server has booted against this DB file.
//
//   node crm/scripts/seed-variants.js
//

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db');
const VARIANTS_DIR = path.join(ROOT, 'lp', 'variants');

(async () => {
  const db = createDB(DB_PATH);

  // Mirror the server's initDB LP schema so the seed is self-sufficient.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS lp_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL, page_slug TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en',
      source TEXT, audience TEXT, status TEXT NOT NULL DEFAULT 'draft',
      traffic_weight INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL,
      experiment_id INTEGER, type TEXT DEFAULT 'landing_page', is_control INTEGER DEFAULT 0,
      compliance_status TEXT DEFAULT 'unknown', bucket TEXT DEFAULT 'leads',
      funnel_stage TEXT DEFAULT 'cta', meta_object_id TEXT,
      created_by TEXT DEFAULT 'seed', approved_by TEXT, approved_at TEXT, retired_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  for (const spec of [
    'experiment_id INTEGER',
    "type TEXT DEFAULT 'landing_page'",
    'is_control INTEGER DEFAULT 0',
    "compliance_status TEXT DEFAULT 'unknown'",
    "bucket TEXT DEFAULT 'leads'",
    "funnel_stage TEXT DEFAULT 'cta'",
    'meta_object_id TEXT',
  ]) {
    try {
      await db.query(sql.__dangerous__rawValue(`ALTER TABLE lp_variants ADD COLUMN ${spec}`));
    } catch (_) { /* duplicate column on existing DB */ }
  }
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_lpv_slug ON lp_variants(slug)`);

  const files = fs.readdirSync(VARIANTS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const config = JSON.parse(fs.readFileSync(path.join(VARIANTS_DIR, f), 'utf8'));
    const slug = config.slug || f.replace(/\.json$/, '');
    const weight = config.traffic_weight != null ? config.traffic_weight : 100;
    const exists = await db.query(sql`SELECT id FROM lp_variants WHERE slug = ${slug}`);
    if (exists.length) {
      await db.query(sql`
        UPDATE lp_variants
        SET config = ${JSON.stringify(config)},
            page_slug = ${config.page_slug},
            status = ${config.status || 'live'},
            traffic_weight = ${weight},
            language = ${config.language || 'en'},
            source = ${config.source || null},
            audience = ${config.audience || null},
            type = ${config.type || 'landing_page'},
            is_control = ${config.is_control ? 1 : 0},
            compliance_status = ${config.compliance_status || 'unknown'},
            bucket = ${config.bucket || 'leads'},
            funnel_stage = ${config.funnel_stage || 'cta'},
            meta_object_id = ${config.meta_object_id || null}
        WHERE slug = ${slug}
      `);
      console.log(`[seed] updated ${slug}`);
    } else {
      await db.query(sql`
        INSERT INTO lp_variants (
          slug, page_slug, language, source, audience, status, traffic_weight,
          config, type, is_control, compliance_status, bucket, funnel_stage,
          meta_object_id, created_by, approved_by, approved_at
        ) VALUES (
          ${slug}, ${config.page_slug}, ${config.language || 'en'}, ${config.source || null}, ${config.audience || null},
          ${config.status || 'live'}, ${weight},
          ${JSON.stringify(config)}, ${config.type || 'landing_page'}, ${config.is_control ? 1 : 0},
          ${config.compliance_status || 'unknown'}, ${config.bucket || 'leads'},
          ${config.funnel_stage || 'cta'}, ${config.meta_object_id || null},
          'seed', 'jason', datetime('now')
        )
      `);
      console.log(`[seed] inserted ${slug}`);
    }
  }
  console.log('[seed] done');
  process.exit(0);
})().catch((e) => { console.error('[seed] failed:', e); process.exit(1); });
