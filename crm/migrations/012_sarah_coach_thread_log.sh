#!/usr/bin/env bash
# Migration 012 wrapper: idempotent CREATE / ALTER for R7 sarah-coach.
# Mirrors 010_regina_send_outcomes.sh.
#
# Adds the sarah_coach_thread_log table (thread_ts → voice_drafts_log_id
# mapping for !sent / !edit handlers) and a sent_text column on
# voice_drafts_log so the R3 feedback loop captures the edited text for
# one-shot inbounds (regina stores this on outreach_sends.sent_text;
# sarah-coach has no outreach_sends row, so it lives on voice_drafts_log).
#
# Safe to re-run: each ALTER is guarded by pragma_table_info, each CREATE
# (TABLE / INDEX) is guarded by sqlite_master lookup.

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

has_table() {
  local table="$1" n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';")
  [[ "$n" == "1" ]]
}

has_index() {
  local index="$1" n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${index}';")
  [[ "$n" == "1" ]]
}

echo "[migration 012] DB: $DB_PATH"

# ── sarah_coach_thread_log table ─────────────────────────────────────────
if has_table sarah_coach_thread_log; then
  echo "[migration 012] sarah_coach_thread_log exists — skip"
else
  echo "[migration 012] Creating sarah_coach_thread_log…"
  run_sql "
    CREATE TABLE sarah_coach_thread_log (
      thread_ts TEXT PRIMARY KEY,
      voice_drafts_log_id INTEGER NOT NULL REFERENCES voice_drafts_log(id),
      posted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  "
fi

if has_index idx_sarah_coach_thread_log_log_id; then
  echo "[migration 012] idx_sarah_coach_thread_log_log_id exists — skip"
else
  echo "[migration 012] Creating idx_sarah_coach_thread_log_log_id…"
  run_sql "CREATE INDEX idx_sarah_coach_thread_log_log_id ON sarah_coach_thread_log(voice_drafts_log_id);"
fi

# ── voice_drafts_log.sent_text column ────────────────────────────────────
if has_column voice_drafts_log sent_text; then
  echo "[migration 012] voice_drafts_log.sent_text exists — skip"
else
  echo "[migration 012] Adding voice_drafts_log.sent_text…"
  run_sql "ALTER TABLE voice_drafts_log ADD COLUMN sent_text TEXT;"
fi

echo
echo "[migration 012] Verification:"
echo "  sarah_coach_thread_log columns (expect 3):"
run_sql "SELECT '    ' || name FROM pragma_table_info('sarah_coach_thread_log') ORDER BY cid;"
echo "  sarah_coach_thread_log indexes (expect 1):"
run_sql "SELECT '    ' || name FROM sqlite_master
         WHERE type='index' AND tbl_name='sarah_coach_thread_log'
         AND name NOT LIKE 'sqlite_autoindex_%'
         ORDER BY name;"
echo "  voice_drafts_log.sent_text:"
run_sql "SELECT '    ' || name FROM pragma_table_info('voice_drafts_log')
         WHERE name = 'sent_text';"

echo "[migration 012] done"
