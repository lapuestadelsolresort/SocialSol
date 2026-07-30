#!/usr/bin/env node
'use strict';
//
// generate-proxies.js — for each registered video asset, write a 720p
// H.264 proxy + N keyframe JPEGs. Drone .LRF assets are already MP4 at
// ~720p, so we symlink rather than re-encode. Idempotent on status.
//
// Concurrency 2 to keep the Mac mini interactive while running.
//
// Usage: node generate-proxies.js [--limit=N] [--reroll-failed] [--concurrency=2]

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { makeProxy, makeThumbs } = require('../lib/ffmpeg-helpers');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');
const MEDIA_ROOT = path.join(path.resolve(__dirname, '..', '..'), 'media');

function parseArgs(argv) {
  const out = { concurrency: 2 };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'reroll-failed') out.rerollFailed = true;
    else if (m[1] === 'concurrency') out.concurrency = parseInt(m[2], 10);
    else if (m[1] === 'dry-run') out.dryRun = true;
  }
  return out;
}

// Pick N keyframes scaled to duration. Short clip → 3 frames. 15s → 4.
// 60s → 6. 300s+ → 12. Cap at 12 — beyond that vision cost overshoots
// marginal value for marketing search.
function keyframeCount(durationMs) {
  const sec = (durationMs || 0) / 1000;
  if (sec <= 8) return 3;
  if (sec <= 30) return 4;
  if (sec <= 60) return 6;
  if (sec <= 180) return 8;
  if (sec <= 600) return 10;
  return 12;
}

async function processAsset(db, asset, opts) {
  const shootSlug = await getShootSlug(db, asset.shoot_id);
  const proxiesDir = path.join(MEDIA_ROOT, 'proxies', shootSlug);
  const thumbsDir = path.join(MEDIA_ROOT, 'thumbs', shootSlug, String(asset.id));

  let proxyPath;
  if (asset.source_role === 'drone' || asset.source_role === 'drone_proxy') {
    // DJI ships an LRF sidecar (720p H.264, ~18 Mbps) next to every drone
    // .MP4. It's far better than any 720p re-encode we'd produce from the
    // 4K HEVC original and costs zero CPU. We COPY it (not symlink) so the
    // CRM server can read it. macOS TCC denies launchd-spawned processes
    // access to /Volumes/<external>/ unless Full Disk Access is granted to
    // every child of launchd — Node's fs.open hangs indefinitely on a
    // permission prompt the background process can never display. A local
    // copy under the user's home is always readable.
    const lrfPath = asset.source_role === 'drone_proxy'
      ? asset.source_path
      : asset.source_path.replace(/\.MP4$/i, '.LRF');
    proxyPath = path.join(proxiesDir, `${asset.id}.mp4`);
    if (fs.existsSync(lrfPath)) {
      fs.mkdirSync(proxiesDir, { recursive: true });
      if (fs.existsSync(proxyPath) || fs.lstatSync(proxyPath, { throwIfNoEntry: false })) {
        try { fs.unlinkSync(proxyPath); } catch {}
      }
      fs.copyFileSync(lrfPath, proxyPath);
    } else if (asset.source_role === 'drone_proxy') {
      throw new Error(`drone LRF sidecar missing: ${lrfPath}`);
    } else {
      // Renamed or trimmed drone files lose their LRF pairing (sidecar
      // keeps the original DJI name). Re-encoding the 4K HEVC is the only
      // remaining path to a proxy.
      console.log(`[proxy] no LRF for ${asset.filename}; re-encoding from 4K source`);
      if (opts.dryRun) {
        console.log(`[proxy] [dry-run] would encode ${asset.filename} -> ${proxyPath}`);
      } else {
        await makeProxy(asset.source_path, proxyPath);
      }
    }
  } else {
    proxyPath = path.join(proxiesDir, `${asset.id}.mp4`);
    if (opts.dryRun) {
      console.log(`[proxy] [dry-run] would encode ${asset.filename} -> ${proxyPath}`);
    } else {
      await makeProxy(asset.source_path, proxyPath);
    }
  }

  // Keyframes — even drone_proxy gets its own thumbs since LRF is full
  // drone footage, just at 720p.
  const n = keyframeCount(asset.duration_ms);
  let thumbs = [];
  if (opts.dryRun) {
    console.log(`[proxy] [dry-run] would extract ${n} thumbs -> ${thumbsDir}`);
  } else {
    thumbs = await makeThumbs(asset.source_path, thumbsDir, n);
  }

  if (opts.dryRun) return { proxyPath, thumbsDir, n };

  await db.query(sql`
    UPDATE media_assets
       SET proxy_path=${proxyPath}, thumb_dir=${thumbsDir}, status='proxied', last_error=NULL
     WHERE id=${asset.id}
  `);
  // Stash keyframe paths into media_keyframe_captions (caption text filled
  // later by caption-keyframes.js).
  for (const t of thumbs) {
    await db.query(sql`
      INSERT INTO media_keyframe_captions (asset_id, frame_idx, frame_path, timestamp_ms)
        VALUES (${asset.id}, ${t.frame_idx}, ${t.frame_path}, ${t.timestamp_ms})
      ON CONFLICT(asset_id, frame_idx) DO UPDATE SET
        frame_path=excluded.frame_path,
        timestamp_ms=excluded.timestamp_ms
    `);
  }

  return { proxyPath, thumbsDir, thumbCount: thumbs.length };
}

async function getShootSlug(db, shootId) {
  const [row] = await db.query(sql`SELECT slug FROM shoots WHERE id=${shootId}`);
  return row ? row.slug : `shoot-${shootId}`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const db = createDB(DB_PATH);

  const statusFilter = opts.rerollFailed
    ? sql`(status='registered' OR status='failed')`
    : sql`status='registered'`;
  const limitClause = opts.limit ? sql`LIMIT ${opts.limit}` : sql``;

  const assets = await db.query(sql`
    SELECT id, shoot_id, source_role, kind, filename, source_path, duration_ms
      FROM media_assets
     WHERE kind='video' AND ${statusFilter}
     ORDER BY source_role, id
     ${limitClause}
  `);
  console.log(`[proxy] ${assets.length} video asset(s) to process (concurrency=${opts.concurrency})`);

  let done = 0, failed = 0;
  const queue = [...assets];
  const workers = [];
  for (let w = 0; w < opts.concurrency; w++) {
    workers.push((async () => {
      while (queue.length) {
        const a = queue.shift();
        if (!a) break;
        const t0 = Date.now();
        try {
          await processAsset(db, a, opts);
          done++;
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          if (done % 5 === 0 || done < 5)
            console.log(`[proxy] ${done}/${assets.length} ${a.source_role}/${a.filename} (${dt}s)`);
        } catch (e) {
          failed++;
          console.warn(`[proxy] FAIL ${a.filename}: ${e.message}`);
          await db.query(sql`UPDATE media_assets SET status='failed', last_error=${e.message.slice(0, 500)} WHERE id=${a.id}`);
        }
      }
    })());
  }
  await Promise.all(workers);

  console.log(`[proxy] done. ok=${done} failed=${failed}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[proxy] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
