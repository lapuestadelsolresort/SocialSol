#!/usr/bin/env bash
# Migration 017 wrapper: renditions_json column on media_assets.
# Mirrors 011_vip_and_feedback_columns.sh. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

run_sql() {
  sqlite3 "$DB_PATH" "$1"
}

has_column() {
  local table="$1" column="$2" n
  n=$(run_sql "SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name='${column}';")
  [[ "$n" == "1" ]]
}

echo "[migration 017] DB: $DB_PATH"

if has_column media_assets renditions_json; then
  echo "[migration 017] media_assets.renditions_json exists — skip"
else
  echo "[migration 017] Adding media_assets.renditions_json…"
  run_sql "ALTER TABLE media_assets ADD COLUMN renditions_json TEXT;"
fi

echo "[migration 017] Verification:"
run_sql "SELECT '    ' || name FROM pragma_table_info('media_assets') WHERE name='renditions_json';"

echo "[migration 017] done"
