#!/usr/bin/env bash
# Migration 008 wrapper: idempotent ALTER for sarah_voice_corpus embedding provenance.
# Mirrors 006/007 patterns.

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

echo "[migration 008] DB: $DB_PATH"

if has_column sarah_voice_corpus embedding_model; then
  echo "[migration 008] sarah_voice_corpus.embedding_model exists - skip ADD COLUMN"
else
  echo "[migration 008] Adding sarah_voice_corpus.embedding_model..."
  run_sql "ALTER TABLE sarah_voice_corpus ADD COLUMN embedding_model TEXT;"
fi

if has_column sarah_voice_corpus embedded_at; then
  echo "[migration 008] sarah_voice_corpus.embedded_at exists - skip ADD COLUMN"
else
  echo "[migration 008] Adding sarah_voice_corpus.embedded_at..."
  run_sql "ALTER TABLE sarah_voice_corpus ADD COLUMN embedded_at TEXT;"
fi

if has_column sarah_voice_corpus embedding_error; then
  echo "[migration 008] sarah_voice_corpus.embedding_error exists - skip ADD COLUMN"
else
  echo "[migration 008] Adding sarah_voice_corpus.embedding_error..."
  run_sql "ALTER TABLE sarah_voice_corpus ADD COLUMN embedding_error TEXT;"
fi

if has_index idx_voice_corpus_embedding_model; then
  echo "[migration 008] idx_voice_corpus_embedding_model exists - skip"
else
  echo "[migration 008] Creating idx_voice_corpus_embedding_model..."
  run_sql "CREATE INDEX idx_voice_corpus_embedding_model ON sarah_voice_corpus(embedding_model);"
fi

echo
echo "[migration 008] Verification:"
echo "  new columns present:"
run_sql "SELECT '    ' || name FROM pragma_table_info('sarah_voice_corpus')
         WHERE name IN ('embedding_model','embedded_at','embedding_error')
         ORDER BY name;"
echo "  embedding_status x embedding_model:"
run_sql "SELECT '    ' || embedding_status || ' / ' || COALESCE(embedding_model,'NULL') || ': ' || COUNT(*)
         FROM sarah_voice_corpus
         GROUP BY embedding_status, embedding_model
         ORDER BY embedding_status, embedding_model;"

echo "[migration 008] done"
