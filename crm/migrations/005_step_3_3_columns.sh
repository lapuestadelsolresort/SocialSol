#!/usr/bin/env bash
# Migration 005 wrapper: idempotent for SQLite.
# Mirrors 004_step_3_2_columns.sh — checks pragma_table_info before ALTER.
#
# 3.3's add is small: one column (outreach_sends.send_attempted_at) plus a
# one-shot value rename in compliance_failures.source ('send_pipeline' →
# 'send_time' to align with spec §6 enum). The rename is naturally idempotent
# (re-running matches zero rows since the value is already gone).
#
# IMPORTANT: outreach_sends.send_after is intentionally NOT touched. See the
# leading comment in 005_step_3_3_columns.sql for why — orchestrator queues on
# scheduled_at only; send_after remains the unused vestigial column from 001.

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
  local table="$1"
  local column="$2"
  local n
  n=$(run_sql "SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name='${column}';")
  [[ "$n" == "1" ]]
}

# ── outreach_sends.send_attempted_at ─────────────────────────────────────
if has_column outreach_sends send_attempted_at; then
  echo "[migration 005] outreach_sends.send_attempted_at exists — skip"
else
  echo "[migration 005] Adding outreach_sends.send_attempted_at…"
  run_sql "ALTER TABLE outreach_sends ADD COLUMN send_attempted_at TEXT;"
fi

# ── compliance_failures source value rename ──────────────────────────────
# Idempotent: matches zero rows once already-renamed.
RENAMED=$(run_sql "SELECT COUNT(*) FROM compliance_failures WHERE source='send_pipeline';")
if [[ "$RENAMED" == "0" ]]; then
  echo "[migration 005] compliance_failures.source already aligned with spec enum — skip"
else
  echo "[migration 005] Renaming compliance_failures.source 'send_pipeline' → 'send_time' (${RENAMED} row(s))…"
  run_sql "UPDATE compliance_failures SET source='send_time' WHERE source='send_pipeline';"
fi

echo
echo "[migration 005] Verification:"
echo "  outreach_sends.send_attempted_at:"
run_sql "SELECT '    ' || name || ' (' || type || ')' FROM pragma_table_info('outreach_sends') WHERE name='send_attempted_at';"
echo "  compliance_failures.source distribution:"
run_sql "SELECT '    ' || COALESCE(source, '<null>') || ' = ' || COUNT(*) FROM compliance_failures GROUP BY source ORDER BY COUNT(*) DESC;"

echo "[migration 005] done"
