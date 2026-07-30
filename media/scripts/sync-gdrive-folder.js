#!/usr/bin/env node
'use strict';
//
// sync-gdrive-folder.js — pull a Google Drive folder into the local
// photo cache, then call register-photos.js to register them.
//
// PREREQ — one-time Workspace admin step:
//   In Google Workspace admin, the configured service account
//   (see crm/lib/gmail-client.js) needs DWD for the scope
//   `https://www.googleapis.com/auth/gmail.readonly` only. To use this
//   script, ADD the scope
//   `https://www.googleapis.com/auth/drive.readonly` to that DWD grant.
//   Workspace admin → Security → API controls → Domain-wide delegation
//   → edit the existing client ID → append the new scope → save.
//   No new key needed; same service account JSON file.
//
// Usage:
//   node sync-gdrive-folder.js \
//     --folder-id=<FOLDER_ID> \
//     --shoot-slug=<SHOOT_SLUG> \
//     --cache-dir=/path/to/socialsol/media/photos-cache/<SHOOT_SLUG>

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { execFileSync } = require('child_process');
const { loadServiceAccount } = require('../../crm/lib/gmail-client');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'folder-id') out.folderId = m[2];
    else if (m[1] === 'shoot-slug') out.slug = m[2];
    else if (m[1] === 'cache-dir') out.cacheDir = m[2];
    else if (m[1] === 'shoot-date') out.shootDate = m[2];
    else if (m[1] === 'location') out.location = m[2];
    else if (m[1] === 'description') out.description = m[2];
    else if (m[1] === 'dry-run') out.dryRun = true;
  }
  return out;
}

function getDriveClient() {
  const sa = loadServiceAccount();
  const impersonateUser = process.env.GMAIL_IMPERSONATE_USER;
  if (!impersonateUser) throw new Error('GMAIL_IMPERSONATE_USER is required');
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: DRIVE_SCOPES,
    subject: impersonateUser,
  });
  return google.drive({ version: 'v3', auth });
}

async function listFolder(drive, folderId) {
  let pageToken = null;
  const out = [];
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)',
      pageSize: 1000,
      pageToken,
    });
    out.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

async function downloadFile(drive, fileId, dst) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dst);
    res.data.on('error', reject).pipe(out).on('finish', resolve).on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.folderId || !args.slug) {
    console.error('Usage: sync-gdrive-folder.js --folder-id=<id> --shoot-slug=<slug> [--cache-dir=<path>] [--dry-run]');
    process.exit(2);
  }
  const cacheDir = args.cacheDir
    ? args.cacheDir.replace(/^~/, process.env.HOME || '')
    : path.join(path.resolve(__dirname, '..', '..'), 'media', 'photos-cache', args.slug);
  fs.mkdirSync(cacheDir, { recursive: true });

  let drive;
  try { drive = getDriveClient(); }
  catch (e) { console.error('[gdrive] auth setup FAILED:', e.message); process.exit(1); }

  let files;
  try { files = await listFolder(drive, args.folderId); }
  catch (e) {
    console.error('[gdrive] list FAILED:', e.message);
    console.error('If this is a 403/insufficient-scope error, add the drive.readonly DWD scope (see header comment).');
    process.exit(1);
  }
  console.log(`[gdrive] folder ${args.folderId}: ${files.length} files`);

  const images = files.filter(f => /^image\//.test(f.mimeType || ''));
  console.log(`[gdrive] ${images.length} image file(s) to sync`);

  let downloaded = 0, skipped = 0, errored = 0;
  for (const f of images) {
    const dst = path.join(cacheDir, f.name);
    if (fs.existsSync(dst) && (fs.statSync(dst).size === Number(f.size || 0))) {
      skipped++;
      continue;
    }
    if (args.dryRun) {
      console.log(`[gdrive] [dry-run] would download ${f.name} (${f.size} B)`);
      downloaded++;
      continue;
    }
    try {
      await downloadFile(drive, f.id, dst);
      downloaded++;
      if (downloaded % 5 === 0 || downloaded < 5) console.log(`[gdrive] downloaded ${downloaded}/${images.length} ${f.name}`);
    } catch (e) {
      errored++;
      console.warn(`[gdrive] download FAILED ${f.name}: ${e.message}`);
    }
  }
  console.log(`[gdrive] done. downloaded=${downloaded} skipped=${skipped} errored=${errored}`);

  if (args.dryRun) return;

  // Hand off to register-photos.js for the DB side.
  console.log('[gdrive] handing off to register-photos.js...');
  const regArgs = [
    'scripts/register-photos.js',
    `--shoot-slug=${args.slug}`,
    `--source-dir=${cacheDir}`,
    `--source-role=gdrive_photo`,
    `--gdrive-folder-id=${args.folderId}`,
  ];
  if (args.shootDate) regArgs.push(`--shoot-date=${args.shootDate}`);
  if (args.location) regArgs.push(`--location=${args.location}`);
  if (args.description) regArgs.push(`--description=${args.description}`);
  execFileSync(process.execPath, regArgs, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
}

if (require.main === module) {
  main().catch((e) => { console.error('[gdrive] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
