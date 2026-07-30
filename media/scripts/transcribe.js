#!/usr/bin/env node
'use strict';
//
// transcribe.js — runs Whisper on every audio asset and writes one
// media_transcripts row per (asset_id, source='whisper-api'). Idempotent.
//
// Usage:
//   node transcribe.js [--limit=N] [--concurrency=1] [--language=en]
//
// Notes on cost: total audio at this shoot ~147 min → ~$0.88 at $0.006/min.
// Concurrency defaults to 1 because each call is heavy (network + multi-MB
// upload) and OpenAI rate-limits Whisper aggressively per account; raise
// to 2 only if you've confirmed headroom.

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { transcribeAudioSource } = require('../lib/whisper-client');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');
const MEDIA_ROOT = path.join(path.resolve(__dirname, '..', '..'), 'media');

function parseArgs(argv) {
  const out = { concurrency: 1, language: 'en' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'concurrency') out.concurrency = parseInt(m[2], 10);
    else if (m[1] === 'language') out.language = m[2];
    else if (m[1] === 'reroll-failed') out.rerollFailed = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  const db = createDB(DB_PATH);

  const statusFilter = opts.rerollFailed
    ? sql`(a.status='proxied' OR a.status='failed')`
    : sql`a.status='proxied'`;
  const limitClause = opts.limit ? sql`LIMIT ${opts.limit}` : sql``;

  const assets = await db.query(sql`
    SELECT a.id, a.filename, a.source_path, a.duration_ms, s.slug
      FROM media_assets a JOIN shoots s ON s.id = a.shoot_id
      LEFT JOIN media_transcripts t ON t.asset_id = a.id AND t.source = 'whisper-api'
     WHERE a.kind='audio' AND ${statusFilter} AND t.id IS NULL
     ORDER BY a.id
     ${limitClause}
  `);
  console.log(`[whisper] ${assets.length} audio asset(s) pending`);

  let ok = 0, fail = 0, totalCost = 0;
  const queue = [...assets];

  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      if (!a) break;
      const t0 = Date.now();
      const tmpDir = path.join(MEDIA_ROOT, 'transcripts', a.slug, `tmp_${a.id}`);
      try {
        const r = await transcribeAudioSource(a.source_path, {
          language: opts.language,
          tmpDir,
          durationSec: (a.duration_ms || 0) / 1000,
        });
        await db.query(sql`
          INSERT INTO media_transcripts (asset_id, source, language, text, segments_json, cost_usd)
            VALUES (${a.id}, 'whisper-api', ${r.language}, ${r.text}, ${JSON.stringify(r.segments)}, ${r.cost_usd})
          ON CONFLICT(asset_id, source) DO UPDATE SET
            language=excluded.language,
            text=excluded.text,
            segments_json=excluded.segments_json,
            cost_usd=excluded.cost_usd
        `);
        await db.query(sql`UPDATE media_assets SET status='transcribed', last_error=NULL WHERE id=${a.id}`);
        totalCost += r.cost_usd;
        ok++;
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[whisper] ${ok}/${assets.length} ${a.filename} dur=${(r.duration_sec/60).toFixed(1)}min cost=$${r.cost_usd.toFixed(3)} (${dt}s) preview="${(r.text || '').slice(0, 80).replace(/\s+/g, ' ')}"`);
      } catch (e) {
        fail++;
        console.warn(`[whisper] FAIL ${a.filename}: ${e.message}`);
        await db.query(sql`UPDATE media_assets SET status='failed', last_error=${e.message.slice(0, 500)} WHERE id=${a.id}`);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  const workers = [];
  for (let w = 0; w < opts.concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  console.log(`[whisper] done. ok=${ok} fail=${fail} total_cost=$${totalCost.toFixed(3)}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[whisper] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
