#!/usr/bin/env bash
# Migration 013 wrapper: idempotent CREATE for Gmail reply forwarder dedupe table.
# Mirrors 012_sarah_coach_thread_log.sh.
#
# Adds processed_gmail_replies — keyed by Gmail internal message ID — so
# crm/scripts/gmail-reply-forwarder.js never re-POSTs the same reply to
# /webhook/resend-reply across its 5-minute LaunchAgent ticks.
#
# Safe to re-run: each CREATE (TABLE / INDEX) is guarded by sqlite_master.

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

echo "[migration 013] DB: $DB_PATH"

# ── processed_gmail_replies table ────────────────────────────────────────
if has_table processed_gmail_replies; then
  echo "[migration 013] processed_gmail_replies exists — skip"
else
  echo "[migration 013] Creating processed_gmail_replies…"
  run_sql "
    CREATE TABLE processed_gmail_replies (
      message_id   TEXT PRIMARY KEY,
      forwarded_at TEXT NOT NULL,
      send_id      INTEGER,
      matched      INTEGER NOT NULL DEFAULT 0
    );
  "
fi

if has_index idx_pgr_forwarded_at; then
  echo "[migration 013] idx_pgr_forwarded_at exists — skip"
else
  echo "[migration 013] Creating idx_pgr_forwarded_at…"
  run_sql "CREATE INDEX idx_pgr_forwarded_at ON processed_gmail_replies(forwarded_at);"
fi

echo
echo "[migration 013] Verification:"
echo "  processed_gmail_replies columns (expect 4):"
run_sql "SELECT '    ' || name FROM pragma_table_info('processed_gmail_replies') ORDER BY cid;"
echo "  processed_gmail_replies indexes (expect 1):"
run_sql "SELECT '    ' || name FROM sqlite_master
         WHERE type='index' AND tbl_name='processed_gmail_replies'
         AND name NOT LIKE 'sqlite_autoindex_%'
         ORDER BY name;"

echo "[migration 013] done"
