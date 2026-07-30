#!/usr/bin/env node
'use strict';
//
// probe-and-register.js — walks a shoot root, ffprobes each file, and
// upserts a media_assets row. Idempotent: keyed on (shoot_id, source_role,
// filename). Re-runs only touch unseen files.
//
// Usage:
//   node probe-and-register.js --shoot-slug=2025-10-28-property \
//     --source-root=/Volumes/Sarah \
//     [--limit=N] [--dry-run] [--shoot-date=2025-10-28] \
//     [--location='La Puesta del Sol Resort, Nayarit'] [--description='...']

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { ffprobeJson, probeSummary } = require('../lib/ffmpeg-helpers');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

// Map folder layout on /Volumes/Sarah to a source_role + kind.
function classifyPath(fullPath, sourceRoot) {
  const rel = path.relative(sourceRoot, fullPath);
  const segs = rel.split(path.sep);
  const top = (segs[0] || '').toUpperCase();
  const ext = path.extname(fullPath).toLowerCase();
  const filename = path.basename(fullPath);

  // Skip hidden + system files.
  if (filename.startsWith('.')) return null;
  if (segs.includes('.Trashes') || segs.includes('System Volume Information')
      || segs.includes('.Spotlight-V100') || segs.includes('.fseventsd')) return null;

  if (top === 'A_CAM' && ext === '.mxf') return { source_role: 'a_cam', kind: 'video' };
  if (top === 'B_CAM' && ext === '.mxf') return { source_role: 'b_cam', kind: 'video' };
  if (top === 'DRONE' && ext === '.mp4') return { source_role: 'drone', kind: 'video' };
  // .LRF is DJI's 720p sidecar — not its own asset. generate-proxies.js
  // copies it locally as the proxy for the matching .MP4 (derives sibling
  // path). Registering it separately produced searchable duplicates and
  // wasted Whisper/vision spend captioning the same content twice.
  if (top === 'DRONE' && ext === '.lrf') return null;
  if (top === 'AUDIO' && segs[1] && segs[1].toUpperCase() === 'HOME' && ext === '.wav')
    return { source_role: 'audio_home', kind: 'audio' };
  if (top === 'AUDIO' && segs[1] && segs[1].toUpperCase() === 'HOST' && ext === '.wav')
    return { source_role: 'audio_host', kind: 'audio' };

  // XML sidecars: tracked alongside MXF but not registered as their own asset
  // — they're consumed for metadata enrichment at probe time.
  if ((top === 'A_CAM' || top === 'B_CAM') && ext === '.xml') return null;

  return null;
}

// Parse a Canon NewsML-G2 (A_CAM) or VideoClip (B_CAM) sidecar for
// device/lens/serial. Returns {} on parse fail — we degrade gracefully.
function parseCanonSidecar(xmlPath) {
  if (!fs.existsSync(xmlPath)) return {};
  let raw;
  try { raw = fs.readFileSync(xmlPath, 'utf8'); } catch { return {}; }
  const out = {};

  // B_CAM VideoClip schema: <Manufacturer>CANON</Manufacturer><ModelName>EOS C70</ModelName>...<Lens>EF24-70mm...</Lens>
  const mfg = raw.match(/<Manufacturer>([^<]+)<\/Manufacturer>/);
  if (mfg) out.device_make = mfg[1].trim();
  const model = raw.match(/<ModelName>([^<]+)<\/ModelName>/);
  if (model) out.device_model = model[1].trim();
  const serial = raw.match(/<SerialNo>([^<]+)<\/SerialNo>/);
  if (serial) out.device_serial = serial[1].trim();
  const lens = raw.match(/<Lens>([^<]+)<\/Lens>/);
  if (lens) out.lens = lens[1].trim();

  // A_CAM NewsML-G2 schema: <infoSource name="652876300028"/> + versionCreated.
  const infoSrc = raw.match(/<infoSource[^>]*name="([^"]+)"/);
  if (!out.device_serial && infoSrc) out.device_serial = infoSrc[1].trim();
  if (!out.device_make) out.device_make = 'CANON';
  const created = raw.match(/<versionCreated>([^<]+)<\/versionCreated>/)
    || raw.match(/<firstCreated>([^<]+)<\/firstCreated>/);
  if (created) out.source_created_at = created[1].trim();

  return out;
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'System Volume Information') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

async function ensureShoot(db, { slug, sourceRoot, shootDate, location, description }) {
  const existing = await db.query(sql`SELECT id FROM shoots WHERE slug=${slug}`);
  if (existing.length) return existing[0].id;
  await db.query(sql`
    INSERT INTO shoots (slug, source_root, shoot_date, location, description, ingested_at)
    VALUES (${slug}, ${sourceRoot}, ${shootDate || null}, ${location || null}, ${description || null}, datetime('now'))
  `);
  const [{ id }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  return id;
}

async function main() {
  const args = parseArgs(process.argv);
  const slug = args['shoot-slug'];
  const sourceRoot = args['source-root'];
  if (!slug || !sourceRoot) {
    console.error('Usage: probe-and-register.js --shoot-slug=<slug> --source-root=<path> [--shoot-date=YYYY-MM-DD] [--location=...] [--description=...] [--limit=N] [--dry-run]');
    process.exit(2);
  }
  if (!fs.existsSync(sourceRoot)) {
    console.error(`source-root does not exist: ${sourceRoot}`);
    process.exit(2);
  }

  const limit = args['limit'] ? parseInt(args['limit'], 10) : null;
  const dryRun = !!args['dry-run'];

  const db = createDB(DB_PATH);
  const shootId = await ensureShoot(db, {
    slug, sourceRoot,
    shootDate: args['shoot-date'],
    location: args['location'],
    description: args['description'],
  });
  console.log(`[probe] shoot=${slug} id=${shootId} root=${sourceRoot}`);

  const files = walk(sourceRoot);
  let registered = 0, updated = 0, skipped = 0, errored = 0;

  for (const full of files) {
    const cls = classifyPath(full, sourceRoot);
    if (!cls) { skipped++; continue; }

    const filename = path.basename(full);

    // Check existing row.
    const existing = await db.query(sql`
      SELECT id, status FROM media_assets
       WHERE shoot_id=${shootId} AND source_role=${cls.source_role} AND filename=${filename}
    `);

    if (existing.length) {
      // Refresh source_path only (file may have moved). Keep status.
      if (!dryRun) {
        await db.query(sql`UPDATE media_assets SET source_path=${full} WHERE id=${existing[0].id}`);
      }
      updated++;
      continue;
    }

    if (limit && registered >= limit) { skipped++; continue; }

    // Probe.
    let probe, sum;
    try {
      probe = await ffprobeJson(full);
      sum = probeSummary(probe);
    } catch (e) {
      console.warn(`[probe] FFPROBE FAIL ${filename}: ${e.message}`);
      errored++;
      continue;
    }

    // XML sidecar (videos only).
    let extra = {};
    if (cls.kind === 'video' && (cls.source_role === 'a_cam' || cls.source_role === 'b_cam')) {
      const xmlPath = full.replace(/\.MXF$/i, '.XML');
      extra = parseCanonSidecar(xmlPath);
    }
    // Drone: device_make/model from filename pattern (DJI_<ts>_<n>_D.MP4).
    if (cls.source_role === 'drone') {
      extra.device_make = extra.device_make || 'DJI';
    }
    // Audio: device_make hint from filename (e.g. Wireless_PRO).
    if (cls.kind === 'audio' && /Wireless_PRO/i.test(filename)) {
      extra.device_make = 'RØDE';
      extra.device_model = 'Wireless PRO';
    }

    if (dryRun) {
      console.log(`[probe] [dry-run] would register ${cls.source_role}/${filename} dur=${sum.duration_ms}ms`);
      registered++;
      continue;
    }

    try {
      await db.query(sql`
        INSERT INTO media_assets
          (shoot_id, source_role, kind, filename, source_path,
           size_bytes, duration_ms, container, codec_v, codec_a,
           width, height, fps, sample_rate, channels,
           device_make, device_model, device_serial, lens,
           source_created_at, status)
        VALUES
          (${shootId}, ${cls.source_role}, ${cls.kind}, ${filename}, ${full},
           ${sum.size_bytes}, ${sum.duration_ms}, ${sum.container}, ${sum.codec_v}, ${sum.codec_a},
           ${sum.width}, ${sum.height}, ${sum.fps}, ${sum.sample_rate}, ${sum.channels},
           ${extra.device_make || null}, ${extra.device_model || null}, ${extra.device_serial || null}, ${extra.lens || null},
           ${extra.source_created_at || sum.source_created_at || null}, 'registered')
      `);
      registered++;
      if (registered % 25 === 0) console.log(`[probe] registered ${registered}...`);
    } catch (e) {
      console.warn(`[probe] INSERT FAIL ${filename}: ${e.message}`);
      errored++;
    }
  }

  // Summary by role.
  const counts = await db.query(sql`
    SELECT source_role, COUNT(*) AS n, SUM(duration_ms) AS dur_ms_sum
      FROM media_assets WHERE shoot_id=${shootId} GROUP BY source_role ORDER BY source_role
  `);
  console.log(`[probe] done. registered=${registered} updated=${updated} skipped=${skipped} errored=${errored}`);
  console.log('[probe] per-role inventory:');
  for (const r of counts) {
    const mins = (r.dur_ms_sum || 0) / 60000;
    console.log(`  ${r.source_role.padEnd(14)} n=${String(r.n).padStart(4)}  total=${mins.toFixed(1)} min`);
  }

  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[probe] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
