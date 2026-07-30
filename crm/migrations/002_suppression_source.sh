#!/usr/bin/env bash
# Migration 002 wrapper: idempotent ALTER TABLE for SQLite.
#
# SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we check
# pragma_table_info before applying. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

HAS_SOURCE=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM pragma_table_info('suppressions') WHERE name='source';")

if [[ "$HAS_SOURCE" == "0" ]]; then
  echo "[migration 002] Adding source column to suppressions…"
  sqlite3 "$DB_PATH" < "$HERE/002_suppression_source.sql"
else
  echo "[migration 002] source column already exists — running backfill only"
  sqlite3 "$DB_PATH" <<'SQL'
UPDATE suppressions SET source = 'legacy' WHERE source IS NULL;
SELECT 'rows by source:' AS info;
SELECT source, COUNT(*) AS n FROM suppressions GROUP BY source;
SQL
fi

echo "[migration 002] done"
