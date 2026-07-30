'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { getOrAssignVariant } = require('../lib/variants');

async function buildDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resort-lp-opt-'));
  const db = createDB(path.join(dir, 'crm.db'));
  await db.query(sql`
    CREATE TABLE lp_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      page_slug TEXT NOT NULL,
      language TEXT NOT NULL,
      source TEXT,
      audience TEXT,
      status TEXT NOT NULL,
      traffic_weight INTEGER NOT NULL,
      config TEXT NOT NULL
    )
  `);
  await db.query(sql`
    CREATE TABLE lp_assignments (
      session_id TEXT PRIMARY KEY,
      variant_id INTEGER NOT NULL
    )
  `);
  await db.query(sql`
    CREATE TABLE experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      primary_metric TEXT NOT NULL,
      linked_variant_slug TEXT,
      linked_utm_campaign TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

test('campaign-linked experiment pins a UTM campaign to its live variant', async () => {
  const db = await buildDb();
  try {
    await db.query(sql`
      INSERT INTO lp_variants (slug, page_slug, language, source, audience, status, traffic_weight, config)
      VALUES
        ('retreats-control-en', 'retreats', 'en', NULL, NULL, 'live', 1, '{}'),
        ('retreats-challenger-en', 'retreats', 'en', NULL, NULL, 'live', 100, '{}')
    `);
    await db.query(sql`
      INSERT INTO experiments (slug, title, status, primary_metric, linked_variant_slug, linked_utm_campaign)
      VALUES (
        'exp-retreats-campaign',
        'Retreats campaign binding',
        'running',
        'wa_click_per_qualified',
        'retreats-control-en',
        'resort-test-campaign'
      )
    `);

    const assigned = await getOrAssignVariant({
      db,
      sql,
      session_id: 'phase1-smoke',
      page_slug: 'retreats',
      language: 'en',
      source: null,
      audience: null,
      campaign: 'resort-test-campaign',
    });

    assert.equal(assigned.slug, 'retreats-control-en');
  } finally {
    if (db.dispose) await db.dispose();
  }
});
