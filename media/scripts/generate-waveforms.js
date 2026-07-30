#!/usr/bin/env node
'use strict';
//
// generate-waveforms.js — for each registered audio asset, write a
// waveform PNG. Idempotent: flips status to 'proxied' when done.

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { makeWaveform } = require('../lib/ffmpeg-helpers');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');
const MEDIA_ROOT = path.join(path.resolve(__dirname, '..', '..'), 'media');

async function main() {
  const db = createDB(DB_PATH);
  const assets = await db.query(sql`
    SELECT a.id, a.filename, a.source_path, s.slug
      FROM media_assets a JOIN shoots s ON s.id = a.shoot_id
     WHERE a.kind='audio' AND a.status='registered'
     ORDER BY a.id
  `);
  console.log(`[waveform] ${assets.length} audio asset(s)`);

  let ok = 0, fail = 0;
  for (const a of assets) {
    const dst = path.join(MEDIA_ROOT, 'waveforms', a.slug, `${a.id}.png`);
    try {
      await makeWaveform(a.source_path, dst);
      await db.query(sql`UPDATE media_assets SET waveform_path=${dst}, status='proxied', last_error=NULL WHERE id=${a.id}`);
      ok++;
      if (ok % 5 === 0 || ok < 5) console.log(`[waveform] ${ok}/${assets.length} ${a.filename}`);
    } catch (e) {
      fail++;
      console.warn(`[waveform] FAIL ${a.filename}: ${e.message}`);
      await db.query(sql`UPDATE media_assets SET status='failed', last_error=${e.message.slice(0, 500)} WHERE id=${a.id}`);
    }
  }
  console.log(`[waveform] done. ok=${ok} fail=${fail}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[waveform] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
