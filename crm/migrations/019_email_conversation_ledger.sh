#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB_PATH="${DB_PATH:-$ROOT/crm/data/crm.db}"

node - "$DB_PATH" <<'NODE'
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('./crm/lib/workflow-schema');
const db = new Database(process.argv[2]);
try {
  db.pragma('foreign_keys = ON');
  db.transaction(() => ensureSchemaBetterSqlite(db))();
  console.log('[migration 019] email conversation ledger ready');
} finally {
  db.close();
}
NODE
