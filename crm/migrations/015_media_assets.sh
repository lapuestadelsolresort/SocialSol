#!/usr/bin/env bash
# Migration 015 wrapper: media assets pipeline schema.
# Mirrors 014_pending_contacts_staging.sh.
#
# Adds shoots, media_assets, media_transcripts, media_keyframe_captions,
# media_clip_synopses, plus indexes. Idempotent — safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"
SQL_PATH="$(dirname "$0")/015_media_assets.sql"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

if [[ ! -f "$SQL_PATH" ]]; then
  echo "ERROR: SQL file not found at $SQL_PATH" >&2
  exit 1
fi

echo "[migration 015] DB: $DB_PATH"
echo "[migration 015] applying $SQL_PATH"

sqlite3 "$DB_PATH" < "$SQL_PATH"

echo "[migration 015] table inventory:"
sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('shoots','media_assets','media_transcripts','media_keyframe_captions','media_clip_synopses') ORDER BY name;"

echo "[migration 015] done"
