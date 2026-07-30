#!/usr/bin/env bash
# Migration 004 wrapper: idempotent ALTER TABLE / CREATE TABLE for SQLite.
# Mirrors 003_first_send_at.sh — checks pragma_table_info before each ALTER.
#
# This wrapper splits the SQL into per-column / per-table checks so re-running
# is always safe. Plain `sqlite3 < 004_step_3_2_columns.sql` would error on the
# second run (duplicate column).

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

has_table() {
  local table="$1"
  local n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';")
  [[ "$n" == "1" ]]
}

has_index() {
  local index="$1"
  local n
  n=$(run_sql "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${index}';")
  [[ "$n" == "1" ]]
}

# ── outreach_campaigns ───────────────────────────────────────────────────
for col in slug persona_brief_path description created_by; do
  if has_column outreach_campaigns "$col"; then
    echo "[migration 004] outreach_campaigns.${col} exists — skip"
  else
    echo "[migration 004] Adding outreach_campaigns.${col}…"
    run_sql "ALTER TABLE outreach_campaigns ADD COLUMN ${col} TEXT;"
  fi
done

# Backfill slug from name for any pre-existing rows.
echo "[migration 004] Backfilling outreach_campaigns.slug from name where NULL…"
run_sql "UPDATE outreach_campaigns SET slug = name WHERE slug IS NULL;"

# Unique index on slug (SQLite trick — can't ALTER COLUMN to add UNIQUE).
if has_index idx_campaigns_slug; then
  echo "[migration 004] idx_campaigns_slug exists — skip"
else
  echo "[migration 004] Creating idx_campaigns_slug…"
  run_sql "CREATE UNIQUE INDEX idx_campaigns_slug ON outreach_campaigns(slug);"
fi

# ── campaign_contacts table ──────────────────────────────────────────────
if has_table campaign_contacts; then
  echo "[migration 004] campaign_contacts exists — skip"
else
  echo "[migration 004] Creating campaign_contacts…"
  run_sql "
    CREATE TABLE campaign_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES outreach_campaigns(id),
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      attached_at TEXT NOT NULL DEFAULT (datetime('now')),
      attached_by TEXT,
      UNIQUE(campaign_id, contact_id)
    );
    CREATE INDEX idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
    CREATE INDEX idx_campaign_contacts_contact ON campaign_contacts(contact_id);
  "
fi

# ── outreach_sends ───────────────────────────────────────────────────────
declare -a SEND_COLS=(
  "hook_angle TEXT"
  "composer_inputs TEXT"
  "slack_message_ts TEXT"
  "slack_channel_id TEXT"
  "posted_at TEXT"
  "rejected_reason TEXT"
  "rejected_by TEXT"
  "edited_by TEXT"
  "edited_at TEXT"
  "edit_history TEXT"
)
for spec in "${SEND_COLS[@]}"; do
  col="${spec%% *}"
  if has_column outreach_sends "$col"; then
    echo "[migration 004] outreach_sends.${col} exists — skip"
  else
    echo "[migration 004] Adding outreach_sends.${col}…"
    run_sql "ALTER TABLE outreach_sends ADD COLUMN ${spec};"
  fi
done

# ── contacts.lead_quality ────────────────────────────────────────────────
if has_column contacts lead_quality; then
  echo "[migration 004] contacts.lead_quality exists — skip"
else
  echo "[migration 004] Adding contacts.lead_quality…"
  run_sql "ALTER TABLE contacts ADD COLUMN lead_quality TEXT;"
fi

# ── compliance_failures.source ───────────────────────────────────────────
if has_column compliance_failures source; then
  echo "[migration 004] compliance_failures.source exists — skip"
else
  echo "[migration 004] Adding compliance_failures.source (default 'send_pipeline')…"
  run_sql "ALTER TABLE compliance_failures ADD COLUMN source TEXT DEFAULT 'send_pipeline';"
fi

echo
echo "[migration 004] Verification:"
echo "  outreach_campaigns:"
run_sql "SELECT '    ' || id || ' | name=' || COALESCE(name,'') || ' | slug=' || COALESCE(slug,'') FROM outreach_campaigns;"
echo "  campaign_contacts row count:"
run_sql "SELECT '    ' || COUNT(*) FROM campaign_contacts;"
echo "  outreach_sends columns added:"
run_sql "SELECT '    ' || name FROM pragma_table_info('outreach_sends') WHERE name IN ('hook_angle','composer_inputs','slack_message_ts','slack_channel_id','posted_at','rejected_reason','rejected_by','edited_by','edited_at','edit_history');"

echo "[migration 004] done"
