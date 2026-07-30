#!/usr/bin/env node
'use strict';
//
// register-photos.js — register a local directory of photos as
// media_assets with kind='photo'. The photo file itself is its own
// "keyframe", so it gets one media_keyframe_captions row at frame_idx=0
// pointing at the source file. No proxy is generated.
//
// Use this for:
//   - A private local Drive cache supplied with --source-dir
//   - Any directory of curated stills you want surfaced to agents
//
// Usage:
//   node register-photos.js \
//     --shoot-slug=2025-07-wedding-shoot \
//     --source-dir=/path/to/photos \
//     --pattern='wedding-*.jpg' \
//     --source-role=gdrive_photo \
//     [--shoot-date=2025-07-01] [--location='...'] [--description='...']
//     [--gdrive-folder-id=18NUil...] [--limit=N] [--dry-run]

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { ffprobeJson, probeSummary } = require('../lib/ffmpeg-helpers');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');

function parseArgs(argv) {
  const out = { sourceRole: 'gdrive_photo' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'shoot-slug') out.slug = m[2];
    else if (m[1] === 'source-dir') out.sourceDir = m[2];
    else if (m[1] === 'pattern') out.pattern = m[2];
    else if (m[1] === 'source-role') out.sourceRole = m[2];
    else if (m[1] === 'shoot-date') out.shootDate = m[2];
    else if (m[1] === 'location') out.location = m[2];
    else if (m[1] === 'description') out.description = m[2];
    else if (m[1] === 'gdrive-folder-id') out.gdriveFolderId = m[2];
    else if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'dry-run') out.dryRun = true;
  }
  return out;
}

// Glob a fixed pattern like 'wedding-*.jpg' against a directory listing.
function matchPattern(name, pattern) {
  if (!pattern) return true;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(name);
}

async function ensureShoot(db, { slug, sourceRoot, shootDate, location, description, notes }) {
  const existing = await db.query(sql`SELECT id FROM shoots WHERE slug=${slug}`);
  if (existing.length) return existing[0].id;
  await db.query(sql`
    INSERT INTO shoots (slug, source_root, shoot_date, location, description, notes, ingested_at)
    VALUES (${slug}, ${sourceRoot}, ${shootDate || null}, ${location || null}, ${description || null}, ${notes || null}, datetime('now'))
  `);
  const [{ id }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  return id;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.slug || !args.sourceDir) {
    console.error('Usage: register-photos.js --shoot-slug=<slug> --source-dir=<path> [--pattern=<glob>] [--source-role=gdrive_photo] [...]');
    process.exit(2);
  }
  if (!fs.existsSync(args.sourceDir)) {
    console.error(`source-dir does not exist: ${args.sourceDir}`);
    process.exit(2);
  }

  const db = createDB(DB_PATH);
  const notes = args.gdriveFolderId ? `gdrive_folder_id=${args.gdriveFolderId}` : null;
  const shootId = await ensureShoot(db, {
    slug: args.slug,
    sourceRoot: args.sourceDir,
    shootDate: args.shootDate,
    location: args.location,
    description: args.description,
    notes,
  });
  console.log(`[photos] shoot=${args.slug} id=${shootId} root=${args.sourceDir} pattern=${args.pattern || '*'}`);

  const entries = fs.readdirSync(args.sourceDir, { withFileTypes: true })
    .filter(e => e.isFile() && matchPattern(e.name, args.pattern));
  console.log(`[photos] found ${entries.length} files matching pattern`);

  let registered = 0, updated = 0, errored = 0;
  for (const e of entries) {
    if (args.limit && registered >= args.limit) break;
    const full = path.join(args.sourceDir, e.name);

    const existing = await db.query(sql`
      SELECT id FROM media_assets WHERE shoot_id=${shootId} AND source_role=${args.sourceRole} AND filename=${e.name}
    `);
    if (existing.length) {
      if (!args.dryRun) await db.query(sql`UPDATE media_assets SET source_path=${full} WHERE id=${existing[0].id}`);
      updated++;
      continue;
    }

    let probe, sum;
    try {
      probe = await ffprobeJson(full);
      sum = probeSummary(probe);
    } catch (err) {
      console.warn(`[photos] probe FAIL ${e.name}: ${err.message}`);
      errored++;
      continue;
    }

    if (args.dryRun) {
      console.log(`[photos] [dry-run] would register ${e.name} ${sum.width}x${sum.height}`);
      registered++;
      continue;
    }

    await db.query(sql`
      INSERT INTO media_assets
        (shoot_id, source_role, kind, filename, source_path, proxy_path, thumb_dir,
         size_bytes, container, codec_v, width, height, status)
      VALUES
        (${shootId}, ${args.sourceRole}, 'photo', ${e.name}, ${full}, ${full}, ${args.sourceDir},
         ${sum.size_bytes}, ${sum.container}, ${sum.codec_v}, ${sum.width}, ${sum.height}, 'proxied')
    `);
    const [{ id: assetId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
    // Register the photo itself as keyframe 0 so caption-keyframes.js and
    // synthesize-clip.js handle it uniformly with video assets.
    await db.query(sql`
      INSERT INTO media_keyframe_captions (asset_id, frame_idx, frame_path, timestamp_ms)
        VALUES (${assetId}, 0, ${full}, 0)
    `);
    registered++;
    if (registered % 5 === 0) console.log(`[photos] registered ${registered}...`);
  }

  console.log(`[photos] done. registered=${registered} updated=${updated} errored=${errored}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[photos] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
