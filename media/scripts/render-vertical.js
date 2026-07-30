#!/usr/bin/env node
'use strict';
//
// render-vertical.js — render an IG-ready 9:16 (or 1:1) rendition of a
// video asset from its 4K original (media/originals/). On-demand, per
// campaign pick — not a bulk pipeline stage. Idempotent per (asset, aspect):
// re-running overwrites the file and updates renditions_json.
//
// Renders from source_path (full-resolution original), NOT the 720p proxy —
// a 9:16 crop of 720p leaves only ~405px of width. If the drive is
// unmounted, pass --from-proxy to explicitly accept the low-res fallback.
//
// Usage:
//   node render-vertical.js --asset-id=8 [--asset-id=131 ...] \
//     [--aspect=9x16|1x1] [--crop-x=0.5] [--from-proxy]
//
//   --crop-x: horizontal center of the crop window as a 0..1 fraction of
//             the excess width (0=left edge, 0.5=center, 1=right edge).

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { run } = require('../lib/ffmpeg-helpers');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');
const MEDIA_ROOT = path.join(path.resolve(__dirname, '..', '..'), 'media');

const ASPECTS = {
  '9x16': { w: 1080, h: 1920 },
  '1x1': { w: 1080, h: 1080 },
};

function parseArgs(argv) {
  const out = { assetIds: [], aspect: '9x16', cropX: 0.5 };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'asset-id') out.assetIds.push(parseInt(m[2], 10));
    else if (m[1] === 'aspect') out.aspect = m[2];
    else if (m[1] === 'crop-x') out.cropX = parseFloat(m[2]);
    else if (m[1] === 'from-proxy') out.fromProxy = true;
  }
  return out;
}

async function renderOne(db, assetId, opts) {
  const [a] = await db.query(sql`
    SELECT a.id, a.kind, a.filename, a.source_path, a.proxy_path,
           a.renditions_json, s.slug AS shoot_slug
      FROM media_assets a JOIN shoots s ON s.id = a.shoot_id
     WHERE a.id=${assetId}
  `);
  if (!a) throw new Error(`asset ${assetId} not found`);
  if (a.kind !== 'video') throw new Error(`asset ${assetId} is kind=${a.kind}; only video can be rendered`);

  let src = a.source_path;
  let fromProxy = false;
  if (!fs.existsSync(src)) {
    if (opts.fromProxy && a.proxy_path && fs.existsSync(a.proxy_path)) {
      src = a.proxy_path;
      fromProxy = true;
      console.warn(`[render] #${assetId}: source unreachable, using 720p proxy (--from-proxy)`);
    } else {
      throw new Error(
        `source unreachable: ${src} — restore the original (or pass --from-proxy to accept a 720p-derived rendition)`
      );
    }
  }

  const { w, h } = ASPECTS[opts.aspect];
  const cropX = Math.min(1, Math.max(0, opts.cropX));
  const outDir = path.join(MEDIA_ROOT, 'renditions', a.shoot_slug);
  const outPath = path.join(outDir, `${assetId}-${opts.aspect}.mp4`);
  fs.mkdirSync(outDir, { recursive: true });

  // Crop the widest window with the target aspect, positioned by cropX
  // along the excess width, then scale to the target frame. yuv420p sheds
  // 4:2:2 10-bit XF-AVC chroma so IG/QuickTime/Chrome all accept it.
  const ratio = `${w}/${h}`;
  const vf = [
    `crop='min(iw,ih*${ratio})':'min(ih,iw/(${ratio}))':'(iw-out_w)*${cropX}':'(ih-out_h)/2'`,
    `scale=${w}:${h}`,
  ].join(',');

  const t0 = Date.now();
  await run('ffmpeg', [
    '-y',
    '-i', src,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', vf,
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath,
  ]);

  const renditions = a.renditions_json ? JSON.parse(a.renditions_json) : {};
  renditions[opts.aspect] = {
    path: outPath,
    width: w,
    height: h,
    rendered_at: new Date().toISOString(),
    from_proxy: fromProxy,
  };
  await db.query(sql`
    UPDATE media_assets SET renditions_json=${JSON.stringify(renditions)} WHERE id=${assetId}
  `);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const mb = (fs.statSync(outPath).size / 1e6).toFixed(1);
  console.log(`[render] #${assetId} ${a.filename} → ${outPath} (${w}x${h}, ${mb} MB, ${dt}s)`);
  console.log(`[render]   serve: http://localhost:3456/api/media/rendition/${assetId}/${opts.aspect}`);
  return outPath;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.assetIds.length || opts.assetIds.some((n) => !Number.isInteger(n))) {
    console.error('Usage: render-vertical.js --asset-id=N [--asset-id=M ...] [--aspect=9x16|1x1] [--crop-x=0..1] [--from-proxy]');
    process.exit(2);
  }
  if (!ASPECTS[opts.aspect]) {
    console.error(`invalid --aspect=${opts.aspect}; allowed: ${Object.keys(ASPECTS).join(', ')}`);
    process.exit(2);
  }

  const db = createDB(DB_PATH);
  let failed = 0;
  for (const id of opts.assetIds) {
    try {
      await renderOne(db, id, opts);
    } catch (e) {
      failed++;
      console.error(`[render] FAIL #${id}: ${e.message}`);
    }
  }
  await db.dispose();
  if (failed) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error('[render] FATAL:', e.message); process.exit(1); });
}
