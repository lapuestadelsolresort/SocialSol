#!/usr/bin/env bash
# Migration 007 wrapper: idempotent ALTER for sarah_voice_corpus.source_account_id
# Mirrors 003_first_send_at.sh / 006 patterns.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

run_sql() { sqlite3 "$DB_PATH" "$1"; }

has_column() {
  local table="$1" column="$2" n
  n=$(run_sql "SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name='${column}';")
  [[ "$n" == "1" ]]
}

has_index() {
  local index="$1" n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${index}';")
  [[ "$n" == "1" ]]
}

echo "[migration 007] DB: $DB_PATH"

if has_column sarah_voice_corpus source_account_id; then
  echo "[migration 007] sarah_voice_corpus.source_account_id exists — skip ADD COLUMN"
else
  echo "[migration 007] Adding sarah_voice_corpus.source_account_id…"
  run_sql "ALTER TABLE sarah_voice_corpus ADD COLUMN source_account_id INTEGER;"
fi

if has_index idx_voice_corpus_source_account; then
  echo "[migration 007] idx_voice_corpus_source_account exists — skip"
else
  echo "[migration 007] Creating idx_voice_corpus_source_account…"
  run_sql "CREATE INDEX idx_voice_corpus_source_account ON sarah_voice_corpus(source_account_id);"
fi

# Backfill for pre-existing Airbnb-sourced rows. Guarded by IS NULL so re-runs
# don't trample any future ingest that already populated the column.
NULL_BEFORE=$(run_sql "SELECT COUNT(*) FROM sarah_voice_corpus WHERE source = 'airbnb_messages' AND source_account_id IS NULL;")
if [[ "$NULL_BEFORE" == "0" ]]; then
  echo "[migration 007] backfill — no NULL airbnb_messages rows, nothing to do"
else
  echo "[migration 007] Backfilling ${NULL_BEFORE} pre-existing airbnb_messages rows with source_account_id=121885415…"
  run_sql "UPDATE sarah_voice_corpus
              SET source_account_id = 121885415
            WHERE source_account_id IS NULL
              AND source = 'airbnb_messages';"
fi

echo
echo "[migration 007] Verification:"
echo "  sarah_voice_corpus rows by source_account_id:"
run_sql "SELECT '    ' || COALESCE(source_account_id, 'NULL') || ': ' || COUNT(*)
         FROM sarah_voice_corpus GROUP BY source_account_id ORDER BY COUNT(*) DESC;"

echo "[migration 007] done"
