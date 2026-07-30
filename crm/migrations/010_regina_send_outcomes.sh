#!/usr/bin/env bash
# Migration 010 wrapper: idempotent ALTER / CREATE for Regina's R5 columns.
# Mirrors 006_reactivation_and_voice.sh.
#
# Safe to re-run: each ALTER is guarded by pragma_table_info, each CREATE
# INDEX is guarded by sqlite_master lookup.

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

has_index() {
  local index="$1" n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${index}';")
  [[ "$n" == "1" ]]
}

echo "[migration 010] DB: $DB_PATH"

# ── outreach_sends extensions ────────────────────────────────────────────
declare -a SEND_COLS=(
  "defer_until TEXT"
  "skip_reason TEXT"
  "reminder_count INTEGER NOT NULL DEFAULT 0"
  "last_reminded_at TEXT"
  "slack_body_ts TEXT"
  "voice_drafts_log_id INTEGER REFERENCES voice_drafts_log(id)"
)
for spec in "${SEND_COLS[@]}"; do
  col="${spec%% *}"
  if has_column outreach_sends "$col"; then
    echo "[migration 010] outreach_sends.${col} exists — skip"
  else
    echo "[migration 010] Adding outreach_sends.${col}…"
    run_sql "ALTER TABLE outreach_sends ADD COLUMN ${spec};"
  fi
done

# ── indexes ──────────────────────────────────────────────────────────────
create_index_if_missing() {
  local idx_name="$1"
  local ddl="$2"
  if has_index "${idx_name}"; then
    echo "[migration 010] ${idx_name} exists — skip"
  else
    echo "[migration 010] Creating ${idx_name}…"
    run_sql "${ddl}"
  fi
}

create_index_if_missing idx_outreach_sends_defer_until \
  "CREATE INDEX idx_outreach_sends_defer_until ON outreach_sends(defer_until) WHERE defer_until IS NOT NULL;"

create_index_if_missing idx_outreach_sends_status_reminder \
  "CREATE INDEX idx_outreach_sends_status_reminder ON outreach_sends(status, last_reminded_at) WHERE status = 'drafted';"

create_index_if_missing idx_outreach_sends_slack_thread_ts \
  "CREATE INDEX idx_outreach_sends_slack_thread_ts ON outreach_sends(slack_thread_ts) WHERE slack_thread_ts IS NOT NULL;"

create_index_if_missing idx_outreach_sends_voice_drafts_log_id \
  "CREATE INDEX idx_outreach_sends_voice_drafts_log_id ON outreach_sends(voice_drafts_log_id) WHERE voice_drafts_log_id IS NOT NULL;"

echo
echo "[migration 010] Verification:"
echo "  outreach_sends new columns (expect 6):"
run_sql "SELECT '    ' || name FROM pragma_table_info('outreach_sends')
         WHERE name IN ('defer_until','skip_reason','reminder_count',
                        'last_reminded_at','slack_body_ts','voice_drafts_log_id')
         ORDER BY name;"
echo "  new indexes (expect 4):"
run_sql "SELECT '    ' || name FROM sqlite_master
         WHERE type='index' AND name IN
           ('idx_outreach_sends_defer_until',
            'idx_outreach_sends_status_reminder',
            'idx_outreach_sends_slack_thread_ts',
            'idx_outreach_sends_voice_drafts_log_id')
         ORDER BY name;"

echo "[migration 010] done"
