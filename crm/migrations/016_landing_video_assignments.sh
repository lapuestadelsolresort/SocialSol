#!/usr/bin/env bash
# Migration 016 wrapper: landing-page video provisioning schema.
# Mirrors 015_media_assets.sh.
#
# Adds landing_video_assignments + indexes. Idempotent — safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"
SQL_PATH="$(dirname "$0")/016_landing_video_assignments.sql"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

if [[ ! -f "$SQL_PATH" ]]; then
  echo "ERROR: SQL file not found at $SQL_PATH" >&2
  exit 1
fi

echo "[migration 016] DB: $DB_PATH"
echo "[migration 016] applying $SQL_PATH"

sqlite3 "$DB_PATH" < "$SQL_PATH"

echo "[migration 016] table inventory:"
sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='landing_video_assignments';"
sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='landing_video_assignments' ORDER BY name;"

echo "[migration 016] done"
