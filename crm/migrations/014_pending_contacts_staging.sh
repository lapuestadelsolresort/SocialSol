#!/usr/bin/env bash
# Migration 014 wrapper: idempotent CREATE for direct-email importer staging table.
# Mirrors 013_gmail_reply_forwarder.sh.
#
# Adds pending_contacts_staging — one row per Gmail thread the
# import-direct-email-contacts.js script has classified. Holds the candidate
# until a human approves it via !staging-approve, after which
# apply-staging-approvals.js writes it through to the live contacts table.
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

echo "[migration 014] DB: $DB_PATH"

if has_table pending_contacts_staging; then
  echo "[migration 014] pending_contacts_staging exists — skip"
else
  echo "[migration 014] creating pending_contacts_staging"
  run_sql "
    CREATE TABLE pending_contacts_staging (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id           TEXT NOT NULL UNIQUE,
      extracted_email     TEXT NOT NULL,
      extracted_name      TEXT,
      thread_subject      TEXT,
      thread_snippet      TEXT,
      first_message_at    TEXT,
      last_message_at     TEXT,
      message_count       INTEGER,
      llm_classification  TEXT,
      llm_category        TEXT,
      llm_confidence      REAL,
      llm_reasoning       TEXT,
      existing_contact_id INTEGER,
      suggested_action    TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      batch_id            TEXT NOT NULL,
      reviewed_at         TEXT,
      reviewed_by         TEXT,
      applied_at          TEXT,
      applied_contact_id  INTEGER,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
fi

for idx_def in \
  "idx_pcs_status:CREATE INDEX idx_pcs_status ON pending_contacts_staging(status);" \
  "idx_pcs_batch:CREATE INDEX idx_pcs_batch ON pending_contacts_staging(batch_id);" \
  "idx_pcs_email:CREATE INDEX idx_pcs_email ON pending_contacts_staging(extracted_email);"
do
  idx_name="${idx_def%%:*}"
  idx_sql="${idx_def#*:}"
  if has_index "$idx_name"; then
    echo "[migration 014] $idx_name exists — skip"
  else
    echo "[migration 014] creating $idx_name"
    run_sql "$idx_sql"
  fi
done

echo "[migration 014] done"
