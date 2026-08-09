#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { DB_PATH } = require('../../lib/runtime-paths');
const { calculateDailyCapacity } = require('../lib/throughput');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

async function main() {
  const campaignSlug = process.argv[2];
  if (!campaignSlug) {
    process.stderr.write('Usage: daily-capacity.js <campaign_slug>\n');
    process.exit(2);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const db = createDB(DB_PATH);
  try {
    const [campaign] = await db.query(sql`
      SELECT id, slug, first_send_at, status
      FROM outreach_campaigns WHERE slug = ${campaignSlug} LIMIT 1
    `);
    if (!campaign || campaign.status !== 'active') {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        reason: campaign ? 'campaign_not_active' : 'campaign_not_found',
        campaign_slug: campaignSlug,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    const capacity = await calculateDailyCapacity(db, sql, config, campaign);
    process.stdout.write(`${JSON.stringify({ ok: true, ...capacity })}\n`);
  } finally {
    await db.dispose();
  }
}

main().catch((error) => {
  process.stderr.write(`[daily-capacity] FATAL: ${error.stack || error.message}\n`);
  process.exit(1);
});
