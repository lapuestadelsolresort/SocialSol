#!/usr/bin/env bash
# Migration 011 wrapper: idempotent ALTER / CREATE for Phase R6's vip +
# feedback_closure infrastructure. Mirrors 010_regina_send_outcomes.sh.
#
# Safe to re-run: each ALTER is guarded by pragma_table_info, each CREATE
# INDEX is guarded by sqlite_master lookup, and the addressable backfill
# converges on every run (deterministic over current column values).

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

echo "[migration 011] DB: $DB_PATH"

# ── contacts extensions ──────────────────────────────────────────────────
declare -a CONTACT_COLS=(
  "reservation_count INTEGER NOT NULL DEFAULT 0"
  "has_private_feedback INTEGER NOT NULL DEFAULT 0"
  "addressable INTEGER NOT NULL DEFAULT 0"
)
for spec in "${CONTACT_COLS[@]}"; do
  col="${spec%% *}"
  if has_column contacts "$col"; then
    echo "[migration 011] contacts.${col} exists — skip"
  else
    echo "[migration 011] Adding contacts.${col}…"
    run_sql "ALTER TABLE contacts ADD COLUMN ${spec};"
  fi
done

# ── indexes ──────────────────────────────────────────────────────────────
create_index_if_missing() {
  local idx_name="$1"
  local ddl="$2"
  if has_index "${idx_name}"; then
    echo "[migration 011] ${idx_name} exists — skip"
  else
    echo "[migration 011] Creating ${idx_name}…"
    run_sql "${ddl}"
  fi
}

create_index_if_missing idx_contacts_reservation_count \
  "CREATE INDEX idx_contacts_reservation_count ON contacts(reservation_count) WHERE reservation_count >= 2;"

create_index_if_missing idx_contacts_feedback_closure \
  "CREATE INDEX idx_contacts_feedback_closure ON contacts(has_private_feedback, addressable) WHERE has_private_feedback = 1 AND addressable = 1;"

# ── one-shot backfill: addressable ───────────────────────────────────────
# Derivable; safe to re-run. Sets addressable=1 for non-airbnb-thread-only
# contacts that have at least one direct channel (email or phone).
echo "[migration 011] Backfilling contacts.addressable…"
run_sql "UPDATE contacts SET addressable = CASE
           WHEN COALESCE(contact_provenance, '') != 'airbnb_thread_only'
                AND (email IS NOT NULL OR phone IS NOT NULL)
           THEN 1 ELSE 0 END;"

echo
echo "[migration 011] Verification:"
echo "  contacts new columns (expect 3):"
run_sql "SELECT '    ' || name FROM pragma_table_info('contacts')
         WHERE name IN ('reservation_count','has_private_feedback','addressable')
         ORDER BY name;"
echo "  new indexes (expect 2):"
run_sql "SELECT '    ' || name FROM sqlite_master
         WHERE type='index' AND name IN
           ('idx_contacts_reservation_count',
            'idx_contacts_feedback_closure')
         ORDER BY name;"
echo "  addressable distribution:"
run_sql "SELECT '    addressable=' || addressable || ': ' || COUNT(*)
         FROM contacts GROUP BY addressable ORDER BY addressable;"

echo "[migration 011] done"
