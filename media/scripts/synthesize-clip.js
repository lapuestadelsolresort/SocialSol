#!/usr/bin/env node
'use strict';
//
// synthesize-clip.js — for each captioned asset, roll up its keyframes
// (and any overlapping transcript snippet) into one media_clip_synopses
// row. Flips status to 'captioned' when done.
//
// Usage: node synthesize-clip.js [--limit=N] [--concurrency=2]

const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { synthesizeClip } = require('../lib/vision-caption');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');

function parseArgs(argv) {
  const out = { concurrency: 2 };
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

  // Eligible assets: every keyframe row has a caption AND no synopsis row
  // exists yet. Photos have N=1 keyframe; videos have N=3-12.
  const assets = await db.query(sql`
    SELECT a.id, a.source_role, a.duration_ms, a.kind
      FROM media_assets a
     WHERE a.status IN ('proxied','transcribed','captioned')
       AND a.kind IN ('video','photo')
       AND NOT EXISTS (SELECT 1 FROM media_clip_synopses cs WHERE cs.asset_id = a.id)
       AND EXISTS (SELECT 1 FROM media_keyframe_captions k WHERE k.asset_id = a.id AND k.caption IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM media_keyframe_captions k WHERE k.asset_id = a.id AND k.caption IS NULL)
     ORDER BY a.id
     ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}
  `);
  console.log(`[synth] ${assets.length} asset(s) ready for synopsis`);

  let ok = 0, fail = 0, totalCost = 0;
  const queue = [...assets];

  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      if (!a) break;
      const t0 = Date.now();
      try {
        const keyframes = await db.query(sql`
          SELECT frame_idx, frame_path, timestamp_ms, caption, tags_json
            FROM media_keyframe_captions
           WHERE asset_id=${a.id} ORDER BY frame_idx
        `);
        const perFrame = keyframes.map(k => {
          const t = k.tags_json ? JSON.parse(k.tags_json) : {};
          return {
            caption: k.caption,
            setting: t.setting, mood: t.mood, people: t.people,
            camera_motion: t.camera_motion, time_of_day: t.time_of_day,
            usable: t.usable, notes: t.notes || '',
          };
        });
        // Transcripts for video assets aren't usually present (we
        // transcribe audio assets standalone). When they are, include
        // the first ~800 chars.
        let transcriptSnippet = '';
        const tr = await db.query(sql`SELECT text FROM media_transcripts WHERE asset_id=${a.id} ORDER BY id LIMIT 1`);
        if (tr.length && tr[0].text) transcriptSnippet = tr[0].text;

        const out = await synthesizeClip({
          keyframes,
          perFrame,
          transcriptSnippet,
          durationMs: a.duration_ms,
          sourceRole: a.source_role,
        });
        await db.query(sql`
          INSERT INTO media_clip_synopses (asset_id, synopsis, searchable_text, tags_json, persona_fit_json, cost_usd, embedding_status)
            VALUES (${a.id}, ${out.synopsis}, ${out.searchable_text}, ${JSON.stringify(out.tags)}, ${JSON.stringify(out.persona_fit)}, ${out.cost_usd}, 'pending')
        `);
        await db.query(sql`UPDATE media_assets SET status='captioned', last_error=NULL WHERE id=${a.id}`);
        totalCost += out.cost_usd;
        ok++;
        if (ok % 10 === 0 || ok < 5) {
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`[synth] ${ok}/${assets.length} asset=${a.id} "${(out.synopsis || '').slice(0, 100)}" (${dt}s, $${out.cost_usd})`);
        }
      } catch (e) {
        fail++;
        console.warn(`[synth] FAIL asset=${a.id}: ${e.message}`);
        await db.query(sql`UPDATE media_assets SET last_error=${e.message.slice(0, 500)} WHERE id=${a.id}`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < opts.concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  console.log(`[synth] done. ok=${ok} fail=${fail} total_cost=$${totalCost.toFixed(3)}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[synth] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
