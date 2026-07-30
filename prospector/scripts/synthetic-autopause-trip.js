#!/usr/bin/env node
'use strict';

/**
 * Synthetic autopause trip.
 *
 * Validates the orchestrator-autopause healthcheck pings end-to-end without
 * touching prod state.json or crm/data/crm.db.
 *
 * Spins up a tmp SQLite + tmp state.json, inserts 3 synthetic bounced rows,
 * invokes checkThresholdsAndMaybePause with hooks mirroring crm/server.js
 * (real Slack + real execSync curl healthcheck), then cleans up tmp files.
 *
 * Run from anywhere:
 *   node "$SOCIALSOL_ROOT/prospector/scripts/synthetic-autopause-trip.js"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { checkThresholdsAndMaybePause } = require('../lib/threshold-pause');
const { postToChannel: slackPostToChannel } = require('../research/scripts/lib/slack');

const PROSPECTOR_DIR = path.join(__dirname, '..');
const PROSPECTOR_CONFIG_PATH = path.join(PROSPECTOR_DIR, 'config.json');
const HEALTHCHECKS_PATH = path.join(PROSPECTOR_DIR, '..', '..', 'workspace', 'secrets', 'healthchecks.json');

const NO_SLACK = process.argv.includes('--no-slack');

(async () => {
  const stamp = Date.now();
  const tmpDbPath = path.join(os.tmpdir(), `autopause-test-${stamp}.db`);
  const tmpStatePath = path.join(os.tmpdir(), `autopause-test-state-${stamp}.json`);

  console.log(`[trip] tmp db:    ${tmpDbPath}`);
  console.log(`[trip] tmp state: ${tmpStatePath}`);
  if (NO_SLACK) console.log('[trip] --no-slack: Slack hook will be omitted from hooks object');

  fs.writeFileSync(tmpStatePath, JSON.stringify({ paused: false }, null, 2) + '\n');

  const db = createDB(tmpDbPath);
  await db.query(sql`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL
    )
  `);
  await db.query(sql`
    CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      status TEXT,
      bounced_at TEXT,
      complained_at TEXT
    )
  `);

  const now = new Date().toISOString();
  for (let i = 1; i <= 3; i++) {
    const email = `synthetic-${stamp}-${i}@example.invalid`;
    await db.query(sql`INSERT INTO contacts (id, email) VALUES (${i}, ${email})`);
    await db.query(sql`INSERT INTO outreach_sends (id, contact_id, status, bounced_at, complained_at) VALUES (${i}, ${i}, 'bounced', ${now}, NULL)`);
  }
  console.log('[trip] seeded 3 synthetic bounced rows in tmp db');

  const config = JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
  const PROSPECTOR_CHANNEL_ID = config.channel_id || null;

  let resolvedHcUrl = null;
  try {
    const hc = JSON.parse(fs.readFileSync(HEALTHCHECKS_PATH, 'utf8'));
    const id = hc.checks?.['orchestrator-autopause'];
    if (hc.base_url && id) resolvedHcUrl = `${hc.base_url}/${id}/fail`;
  } catch { /* hook will warn */ }
  console.log(`[trip] resolved healthcheck URL: ${resolvedHcUrl || '(unresolved — hook will warn and skip)'}`);

  const fired = { slackPost: false, healthcheckFail: false };
  let result;
  let stateAfter;

  const hooks = {
    healthcheckFail: () => {
      fired.healthcheckFail = true;
      let url;
      try {
        const hc = JSON.parse(fs.readFileSync(HEALTHCHECKS_PATH, 'utf8'));
        const id = hc.checks?.['orchestrator-autopause'];
        if (!hc.base_url || !id) {
          console.warn(`[trip] healthcheck 'orchestrator-autopause' not configured, skipping fail ping`);
          return;
        }
        url = `${hc.base_url}/${id}/fail`;
      } catch (e) {
        console.warn(`[trip] healthcheck config read failed: ${e.message}`);
        return;
      }
      try {
        execSync(`curl -fsS --max-time 5 ${JSON.stringify(url)} >/dev/null 2>&1`);
        console.log(`[trip] healthcheckFail fired → curl ${url} (HTTP OK or fail-soft)`);
      } catch (e) {
        console.warn(`[trip] healthcheckFail curl failed: ${e.message}`);
      }
    },
  };
  if (!NO_SLACK) {
    hooks.slackPost = async (msg) => {
      fired.slackPost = true;
      if (PROSPECTOR_CHANNEL_ID) {
        await slackPostToChannel('channel:' + PROSPECTOR_CHANNEL_ID, msg);
        console.log(`[trip] slackPost fired → channel:${PROSPECTOR_CHANNEL_ID}`);
      } else {
        console.log('[trip] slackPost fired but PROSPECTOR_CHANNEL_ID is null — no network call');
      }
    };
  }

  try {
    result = await checkThresholdsAndMaybePause(db, sql, config, hooks, { statePath: tmpStatePath });
    try { stateAfter = JSON.parse(fs.readFileSync(tmpStatePath, 'utf8')); } catch { /* missing */ }
  } finally {
    try { await db.dispose(); } catch {}
    for (const p of [tmpDbPath, tmpDbPath + '-shm', tmpDbPath + '-wal', tmpStatePath]) {
      try { fs.unlinkSync(p); } catch {}
    }
    if (resolvedHcUrl) {
      const startUrl = resolvedHcUrl.replace(/\/fail$/, '/start');
      console.log(`[trip] TEST COMPLETE — Healthchecks orchestrator-autopause is now in 'down' state. Run curl ${startUrl} or click Resume on the dashboard before next autopause test.`);
    } else {
      console.log(`[trip] TEST COMPLETE — healthcheck URL was unresolved, dashboard state unchanged.`);
    }
  }

  console.log('[trip] result struct:', JSON.stringify(result, null, 2));
  console.log('[trip] tmp state.json after trip:', JSON.stringify(stateAfter, null, 2));
  console.log('[trip] hooks fired:', fired);

  let ok = true;
  if (!result || !result.tripped) {
    console.error('[trip] ❌ expected result.tripped=true; threshold-pause did not trip on 3 bounces');
    ok = false;
  }
  if (!NO_SLACK && !fired.slackPost) { console.error('[trip] ❌ slackPost did not fire'); ok = false; }
  if (!fired.healthcheckFail) { console.error('[trip] ❌ healthcheckFail did not fire'); ok = false; }
  if (!stateAfter || stateAfter.paused !== true || stateAfter.paused_by !== 'auto_threshold:bounce_24h') {
    console.error('[trip] ❌ tmp state.json was not flipped as expected');
    ok = false;
  }

  if (ok) {
    console.log('[trip] ✅ tripped, both hooks fired, tmp state flipped. Now check the Healthchecks dashboard for an orchestrator-autopause /fail ping within the last ~30s.');
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[trip] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
