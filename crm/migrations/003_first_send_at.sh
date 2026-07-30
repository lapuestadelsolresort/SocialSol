#!/usr/bin/env bash
# Migration 003 wrapper: idempotent ALTER TABLE for SQLite.
# Mirrors 002_suppression_source.sh — checks pragma_table_info before applying.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DB_PATH="${DB_PATH:-${REPO_ROOT}/crm/data/crm.db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

HAS_COL=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM pragma_table_info('outreach_campaigns') WHERE name='first_send_at';")

if [[ "$HAS_COL" == "0" ]]; then
  echo "[migration 003] Adding first_send_at column to outreach_campaigns…"
  sqlite3 "$DB_PATH" < "$HERE/003_first_send_at.sql"
else
  echo "[migration 003] first_send_at column already exists — no-op"
  sqlite3 "$DB_PATH" "SELECT id, name, first_send_at FROM outreach_campaigns;"
fi

echo "[migration 003] done"
