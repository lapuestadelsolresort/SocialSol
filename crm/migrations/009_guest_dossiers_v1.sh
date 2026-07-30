#!/usr/bin/env bash
# Migration 009 wrapper: DROP + CREATE guest_dossiers v1.
#
# Re-run safety: idempotent on schema. The DROP discards all rows, so do NOT
# re-run after extraction has populated rows you want to keep — extraction
# is repeatable for ~$15 (re-run extract-guest-dossiers.js), but if you need
# to preserve human-reviewed rows (reviewed_by_human=1), back them up first:
#   sqlite3 "$DB_PATH" ".dump guest_dossiers" > /tmp/dossiers_backup.sql
#
# Schema rationale: 006's guest_dossiers stub was a placeholder. The actual
# extraction prompt produces per-field confidence + citations + extraction_status
# that 006 didn't anticipate. 009 replaces the table outright; 006 was never
# populated.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

run_sql() { sqlite3 "$DB_PATH" "$1"; }

has_table() {
  local table="$1" n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';")
  [[ "$n" == "1" ]]
}

column_count() {
  local table="$1"
  run_sql "SELECT COUNT(*) FROM pragma_table_info('${table}');"
}

echo "[migration 009] DB: $DB_PATH"

# Check for existing populated rows — abort if any reviewed_by_human=1 rows
# exist, since this migration drops them.
if has_table guest_dossiers; then
  reviewed=$(run_sql "SELECT COUNT(*) FROM guest_dossiers WHERE reviewed_by_human=1;" 2>/dev/null || echo "0")
  if [[ "$reviewed" != "0" && "$reviewed" != "" ]]; then
    echo "[migration 009] ABORT: ${reviewed} reviewed_by_human=1 rows in existing guest_dossiers." >&2
    echo "[migration 009] Back up first: sqlite3 \"\$DB_PATH\" \".dump guest_dossiers\" > /tmp/dossiers_backup.sql" >&2
    exit 1
  fi
fi

# v1 schema has 48 columns. If the live table already has 48 columns AND the
# new metadata columns exist, treat as already-applied and exit cleanly.
if has_table guest_dossiers; then
  cols=$(column_count guest_dossiers)
  has_status=$(run_sql "SELECT COUNT(*) FROM pragma_table_info('guest_dossiers') WHERE name='extraction_status';")
  has_last_err=$(run_sql "SELECT COUNT(*) FROM pragma_table_info('guest_dossiers') WHERE name='last_attempt_error';")
  has_thread_id=$(run_sql "SELECT COUNT(*) FROM pragma_table_info('guest_dossiers') WHERE name='airbnb_thread_id';")
  if [[ "$cols" == "48" && "$has_status" == "1" && "$has_last_err" == "1" && "$has_thread_id" == "1" ]]; then
    echo "[migration 009] guest_dossiers already at v1 (48 cols, extraction_status + last_attempt_error + airbnb_thread_id present) — skip"
    echo "[migration 009] done"
    exit 0
  fi
fi

echo "[migration 009] Dropping + recreating guest_dossiers (v0 stub had ${cols:-?} cols, replacing with 48-col v1)..."

run_sql "DROP TABLE IF EXISTS guest_dossiers;"
run_sql "DROP INDEX IF EXISTS idx_dossiers_status;"
run_sql "DROP INDEX IF EXISTS idx_dossiers_reviewed;"
run_sql "DROP INDEX IF EXISTS idx_dossiers_why_no_book;"

run_sql "$(cat <<'EOF'
CREATE TABLE guest_dossiers (
  airbnb_thread_id TEXT PRIMARY KEY,
  contact_ids TEXT NOT NULL,
  trip_purpose TEXT,
  trip_purpose_confidence REAL,
  trip_purpose_source_message_ids TEXT,
  why_no_book TEXT,
  why_no_book_confidence REAL,
  why_no_book_source_message_ids TEXT,
  decision_timeline TEXT,
  decision_timeline_confidence REAL,
  decision_timeline_source_message_ids TEXT,
  language TEXT,
  language_confidence REAL,
  language_source_message_ids TEXT,
  excitement_signals TEXT,
  excitement_signals_confidence REAL,
  excitement_signals_source_message_ids TEXT,
  objections TEXT,
  objections_confidence REAL,
  objections_source_message_ids TEXT,
  specific_features_mentioned TEXT,
  specific_features_mentioned_confidence REAL,
  specific_features_mentioned_source_message_ids TEXT,
  dates_targeted TEXT,
  dates_targeted_confidence REAL,
  dates_targeted_source_message_ids TEXT,
  group_dynamics TEXT,
  group_dynamics_confidence REAL,
  group_dynamics_source_message_ids TEXT,
  geographic_hints TEXT,
  geographic_hints_confidence REAL,
  geographic_hints_source_message_ids TEXT,
  communication_style TEXT,
  communication_style_confidence REAL,
  communication_style_source_message_ids TEXT,
  occasion_anniversary_date TEXT,
  occasion_anniversary_date_confidence REAL,
  occasion_anniversary_date_source_message_ids TEXT,
  notes_for_sarah TEXT,
  notes_for_sarah_confidence REAL,
  notes_for_sarah_source_message_ids TEXT,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN
    ('extracted','deferred_spanish','no_source','extraction_failed')),
  last_attempt_error TEXT,
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,
  extracted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  extraction_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_dossiers_status ON guest_dossiers(extraction_status);
CREATE INDEX idx_dossiers_reviewed ON guest_dossiers(reviewed_by_human);
CREATE INDEX idx_dossiers_why_no_book ON guest_dossiers(why_no_book);
EOF
)"

echo
echo "[migration 009] Verification:"
echo "  guest_dossiers column count (expect 48):"
run_sql "SELECT '    ' || COUNT(*) FROM pragma_table_info('guest_dossiers');"
echo "  extraction_status CHECK:"
run_sql "SELECT '    ' || sql FROM sqlite_master WHERE type='table' AND name='guest_dossiers';" | grep -o "CHECK[^)]*)" || echo "    (CHECK not found in dump)"
echo "  indexes:"
run_sql "SELECT '    ' || name FROM sqlite_master WHERE type='index' AND tbl_name='guest_dossiers' ORDER BY name;"

echo "[migration 009] done"
