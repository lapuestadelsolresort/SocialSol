#!/usr/bin/env node
'use strict';
//
// provision-landing-video.js — operator CLI for Phase M2.
//
// End-to-end: read a media_assets row, transcode the source file to a
// landing-page-friendly 1080p H.264 MP4, POST to /api/landing/finalize-video
// which moves it into landing/apps/<slug>/public/video/<slot>.mp4 and
// records the assignment.
//
// Why a CLI not "agent calls API directly":
// The CRM is launched by launchd and cannot read /Volumes/<external>/ —
// macOS TCC hangs fs.open indefinitely (see
// feedback_launchd_tcc_external_volumes). This CLI runs in the operator's
// shell where Terminal.app's Full Disk Access is inherited, so ffmpeg
// can stream the source. The output lands in web-staging/ (local disk)
// and the API takes it from there.
//
// Usage:
//   node provision-landing-video.js \
//     --asset-id=2 --slug=retreats --slot=pool \
//     [--start-offset-ms=1000] [--duration-ms=8000] \
//     [--target-height=1080] [--crf=24] \
//     [--notes="..."] [--provisioned-by="jason"]
//     [--base-url=http://localhost:3456] [--dry-run]
//
// CRF picker (libx264, content-adaptive — bitrate varies with motion):
//   21  visually transparent, very high quality (12–18 Mbps for high-motion 1080p)
//   24  default — good quality, web-sized (5–8 Mbps typical)
//   27  okay quality, small files (~3–5 Mbps)
// Hero loops over the public internet usually want CRF 24–26.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { transcodeForWeb } = require('../lib/web-transcode');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');
const STAGING_DIR = process.env.MEDIA_STAGING_DIR
  || path.join(path.resolve(__dirname, '..', '..'), 'media', 'web-staging');

function parseArgs(argv) {
  const out = { baseUrl: 'http://localhost:3456' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const k = m[1].replace(/-/g, '_');
    out[k] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const sec = parseFloat(r.stdout.trim());
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}

async function main() {
  const a = parseArgs(process.argv);
  if (!a.asset_id || !a.slug || !a.slot) {
    console.error('Usage: provision-landing-video.js --asset-id=N --slug=<slug> --slot=<slot> [options]');
    process.exit(2);
  }
  const assetId = parseInt(a.asset_id, 10);
  if (!Number.isInteger(assetId)) { console.error('--asset-id must be an integer'); process.exit(2); }
  const targetHeight = a.target_height ? parseInt(a.target_height, 10) : 1080;
  const startMs = a.start_offset_ms ? parseInt(a.start_offset_ms, 10) : 0;
  const durMs = a.duration_ms ? parseInt(a.duration_ms, 10) : undefined;
  const crf = a.crf ? parseInt(a.crf, 10) : 24;

  const db = createDB(DB_PATH);
  const [asset] = await db.query(sql`
    SELECT id, kind, source_role, filename, source_path, duration_ms, width, height
      FROM media_assets WHERE id=${assetId}
  `);
  if (!asset) { console.error(`asset_id=${assetId} not found`); process.exit(1); }
  if (asset.kind !== 'video') { console.error(`asset is kind=${asset.kind}, not video`); process.exit(1); }
  if (!fs.existsSync(asset.source_path)) {
    console.error(`source file missing: ${asset.source_path}`);
    process.exit(1);
  }

  console.log(`[provision] asset_id=${asset.id} (${asset.source_role}/${asset.filename}) ${asset.width}x${asset.height} ${asset.duration_ms}ms`);
  console.log(`[provision] source: ${asset.source_path}`);
  console.log(`[provision] target: ${a.slug}/${a.slot}.mp4 @ ${targetHeight}p` + (startMs ? ` ss=${startMs}ms` : '') + (durMs ? ` t=${durMs}ms` : ''));

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const stamp = Date.now();
  const stagedOut = path.join(STAGING_DIR, `${a.slug}-${a.slot}-${assetId}-${stamp}.mp4`);

  if (a.dry_run) {
    console.log(`[provision] [dry-run] would transcode -> ${stagedOut} then POST to ${a.baseUrl}/api/landing/finalize-video`);
    await db.dispose();
    return;
  }

  console.log('[provision] running ffmpeg...');
  const t0 = Date.now();
  try {
    await transcodeForWeb(asset.source_path, stagedOut, {
      height: targetHeight,
      startMs,
      durMs,
      crf,
    });
  } catch (e) {
    console.error(`[provision] ffmpeg failed: ${e.message}`);
    process.exit(1);
  }
  const ffmpegSec = ((Date.now() - t0) / 1000).toFixed(1);
  const outStat = fs.statSync(stagedOut);
  const outDurMs = durMs || probeDuration(stagedOut) || null;
  const outBitrateKbps = outDurMs ? Math.round((outStat.size * 8) / outDurMs) : null;
  console.log(`[provision] ffmpeg ok in ${ffmpegSec}s: ${outStat.size} bytes (~${outBitrateKbps} kbps)`);

  console.log('[provision] POST /api/landing/finalize-video ...');
  const res = await fetch(`${a.baseUrl}/api/landing/finalize-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_id: assetId,
      slug: a.slug,
      slot: a.slot,
      transcoded_path: stagedOut,
      target_height: targetHeight,
      target_bitrate_kbps: outBitrateKbps,
      duration_ms: outDurMs,
      start_offset_ms: startMs,
      provisioned_by: a.provisioned_by || process.env.USER || null,
      notes: a.notes || null,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`[provision] API ${res.status}:`, body);
    // Leave the staged file around so operator can debug or retry.
    process.exit(1);
  }
  console.log('[provision] done.');
  console.log(JSON.stringify(body, null, 2));
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[provision] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
