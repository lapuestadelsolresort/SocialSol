#!/usr/bin/env node
'use strict';
//
// caption-keyframes.js — for each asset with status='proxied' (i.e.
// keyframes have been generated), call Claude vision on every keyframe
// and write into media_keyframe_captions. Idempotent: skips frames that
// already have a non-null caption.
//
// Usage: node caption-keyframes.js [--limit=N] [--concurrency=3]

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { captionFrame } = require('../lib/vision-caption');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');

function parseArgs(argv) {
  const out = { concurrency: 3 };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'concurrency') out.concurrency = parseInt(m[2], 10);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  const db = createDB(DB_PATH);

  // Pull all uncaptioned keyframe rows belonging to non-failed assets.
  // We filter by frame_path existence at the application level.
  const rows = await db.query(sql`
    SELECT k.id, k.asset_id, k.frame_idx, k.frame_path, k.timestamp_ms,
           a.source_role, a.duration_ms, a.lens
      FROM media_keyframe_captions k
      JOIN media_assets a ON a.id = k.asset_id
     WHERE k.caption IS NULL AND a.status IN ('proxied','transcribed','captioned')
     ORDER BY k.asset_id, k.frame_idx
     ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}
  `);
  console.log(`[vision] ${rows.length} keyframe(s) pending`);

  let ok = 0, fail = 0, totalCost = 0;
  const queue = [...rows];

  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      if (!r) break;
      if (!fs.existsSync(r.frame_path)) {
        console.warn(`[vision] missing file ${r.frame_path} — skip`);
        fail++;
        continue;
      }
      const t0 = Date.now();
      const hint = [
        r.source_role && `source: ${r.source_role}`,
        r.lens && `lens: ${r.lens}`,
        r.duration_ms && `clip duration ${(r.duration_ms/1000).toFixed(1)}s`,
      ].filter(Boolean).join('; ');
      try {
        const out = await captionFrame(r.frame_path, { contextHint: hint });
        await db.query(sql`
          UPDATE media_keyframe_captions
             SET caption=${out.caption}, tags_json=${JSON.stringify({
                 setting: out.setting, mood: out.mood, people: out.people,
                 camera_motion: out.camera_motion, time_of_day: out.time_of_day,
                 persona_fit: out.persona_fit, usable: out.usable, notes: out.notes,
               })}, cost_usd=${out.cost_usd}
           WHERE id=${r.id}
        `);
        totalCost += out.cost_usd;
        ok++;
        if (ok % 10 === 0 || ok < 5) {
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`[vision] ${ok}/${rows.length} asset=${r.asset_id} k${r.frame_idx} "${(out.caption || '').slice(0, 80)}" (${dt}s, $${out.cost_usd})`);
        }
      } catch (e) {
        fail++;
        console.warn(`[vision] FAIL asset=${r.asset_id} k${r.frame_idx}: ${e.message}`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < opts.concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  console.log(`[vision] done. ok=${ok} fail=${fail} total_cost=$${totalCost.toFixed(3)}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[vision] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
