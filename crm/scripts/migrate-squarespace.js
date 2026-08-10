#!/usr/bin/env node
'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');

const ROOT = path.resolve(__dirname, '..', '..');
const dbPath = path.resolve(process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db'));
const dryRun = process.argv.includes('--dry-run');

const db = new Database(dbPath, { readonly: dryRun, fileMustExist: dryRun });
try {
  db.pragma('foreign_keys = ON');
  if (dryRun) {
    const existing = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'squarespace_%'"
    ).get().n;
    console.log(JSON.stringify({ ok: true, dry_run: true, db_path: dbPath, existing_squarespace_tables: existing }));
  } else {
    db.transaction(() => ensureSchemaBetterSqlite(db))();
    const created = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'squarespace_%'"
    ).get().n;
    console.log(JSON.stringify({ ok: true, dry_run: false, db_path: dbPath, squarespace_tables: created }));
  }
} finally {
  db.close();
}
