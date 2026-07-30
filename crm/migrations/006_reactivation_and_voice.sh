#!/usr/bin/env bash
# Migration 006 wrapper: idempotent ALTER / CREATE for SQLite.
# Mirrors 004_step_3_2_columns.sh.
#
# Safe to re-run: each ALTER is guarded by pragma_table_info, each CREATE TABLE
# uses IF NOT EXISTS, and indexes are guarded by sqlite_master lookup.

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

echo "[migration 006] DB: $DB_PATH"

# ── contacts extensions ──────────────────────────────────────────────────
declare -a CONTACT_COLS=(
  "relationship_type TEXT"
  "contact_provenance TEXT"
  "airbnb_account_id INTEGER"
  "airbnb_thread_id INTEGER"
  "trip_purpose TEXT"
  "last_stay_date TEXT"
  "review_rating INTEGER"
  "preferred_channel TEXT"
  "phone TEXT"
)
for spec in "${CONTACT_COLS[@]}"; do
  col="${spec%% *}"
  if has_column contacts "$col"; then
    echo "[migration 006] contacts.${col} exists — skip"
  else
    echo "[migration 006] Adding contacts.${col}…"
    run_sql "ALTER TABLE contacts ADD COLUMN ${spec};"
  fi
done

# Partial UNIQUE index on airbnb_account_id (SQLite cannot ALTER COLUMN to add UNIQUE)
if has_index idx_contacts_airbnb_account_id; then
  echo "[migration 006] idx_contacts_airbnb_account_id exists — skip"
else
  echo "[migration 006] Creating idx_contacts_airbnb_account_id (partial UNIQUE)…"
  run_sql "CREATE UNIQUE INDEX idx_contacts_airbnb_account_id
             ON contacts(airbnb_account_id)
             WHERE airbnb_account_id IS NOT NULL;"
fi

if has_index idx_contacts_relationship_type; then
  echo "[migration 006] idx_contacts_relationship_type exists — skip"
else
  echo "[migration 006] Creating idx_contacts_relationship_type…"
  run_sql "CREATE INDEX idx_contacts_relationship_type ON contacts(relationship_type);"
fi

if has_index idx_contacts_provenance; then
  echo "[migration 006] idx_contacts_provenance exists — skip"
else
  echo "[migration 006] Creating idx_contacts_provenance…"
  run_sql "CREATE INDEX idx_contacts_provenance ON contacts(contact_provenance);"
fi

# ── outreach_campaigns extensions ────────────────────────────────────────
for col in campaign_kind owning_agent; do
  if has_column outreach_campaigns "$col"; then
    echo "[migration 006] outreach_campaigns.${col} exists — skip"
  else
    echo "[migration 006] Adding outreach_campaigns.${col}…"
    run_sql "ALTER TABLE outreach_campaigns ADD COLUMN ${col} TEXT;"
  fi
done

# ── outreach_sends extensions ────────────────────────────────────────────
declare -a SEND_COLS=(
  "send_method TEXT"
  "draft_text TEXT"
  "sent_text TEXT"
  "edit_distance INTEGER"
  "slack_thread_ts TEXT"
  "sent_by_user_id TEXT"
)
for spec in "${SEND_COLS[@]}"; do
  col="${spec%% *}"
  if has_column outreach_sends "$col"; then
    echo "[migration 006] outreach_sends.${col} exists — skip"
  else
    echo "[migration 006] Adding outreach_sends.${col}…"
    run_sql "ALTER TABLE outreach_sends ADD COLUMN ${spec};"
  fi
done

# ── guest_dossiers ───────────────────────────────────────────────────────
if has_table guest_dossiers; then
  echo "[migration 006] guest_dossiers exists — skip"
else
  echo "[migration 006] Creating guest_dossiers…"
  run_sql "
    CREATE TABLE guest_dossiers (
      contact_id INTEGER PRIMARY KEY REFERENCES contacts(id),
      trip_purpose TEXT,
      why_no_book TEXT,
      why_no_book_confidence REAL,
      excitement_signals TEXT,
      objections TEXT,
      specific_features TEXT,
      dates_targeted TEXT,
      group_dynamics TEXT,
      decision_timeline TEXT,
      geographic_hints TEXT,
      language TEXT,
      communication_style TEXT,
      occasion_anniversary_date TEXT,
      notes_for_sarah TEXT,
      reviewed_by_human INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  "
fi

# ── sarah_voice_corpus ───────────────────────────────────────────────────
if has_table sarah_voice_corpus; then
  echo "[migration 006] sarah_voice_corpus exists — skip"
else
  echo "[migration 006] Creating sarah_voice_corpus…"
  run_sql "
    CREATE TABLE sarah_voice_corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      contact_id INTEGER REFERENCES contacts(id),
      direction TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      body TEXT NOT NULL,
      intent_tags TEXT,
      recipient_relationship TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      word_count INTEGER NOT NULL,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(source, source_id, message_id)
    );
    CREATE INDEX idx_voice_corpus_status ON sarah_voice_corpus(language, embedding_status);
    CREATE INDEX idx_voice_corpus_contact ON sarah_voice_corpus(contact_id);
  "
fi

# ── voice_drafts_log ─────────────────────────────────────────────────────
if has_table voice_drafts_log; then
  echo "[migration 006] voice_drafts_log exists — skip"
else
  echo "[migration 006] Creating voice_drafts_log…"
  run_sql "
    CREATE TABLE voice_drafts_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent TEXT NOT NULL,
      agent TEXT NOT NULL,
      contact_id INTEGER REFERENCES contacts(id),
      draft_text TEXT NOT NULL,
      retrieved_example_ids TEXT,
      cost_usd REAL,
      outcome TEXT NOT NULL DEFAULT 'pending',
      edit_distance INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX idx_voice_drafts_agent ON voice_drafts_log(agent);
    CREATE INDEX idx_voice_drafts_outcome ON voice_drafts_log(outcome);
  "
fi

echo
echo "[migration 006] Verification:"
echo "  contacts new columns:"
run_sql "SELECT '    ' || name FROM pragma_table_info('contacts')
         WHERE name IN ('relationship_type','contact_provenance','airbnb_account_id',
                        'airbnb_thread_id','trip_purpose','last_stay_date',
                        'review_rating','preferred_channel','phone')
         ORDER BY name;"
echo "  outreach_campaigns new columns:"
run_sql "SELECT '    ' || name FROM pragma_table_info('outreach_campaigns')
         WHERE name IN ('campaign_kind','owning_agent') ORDER BY name;"
echo "  outreach_sends new columns:"
run_sql "SELECT '    ' || name FROM pragma_table_info('outreach_sends')
         WHERE name IN ('send_method','draft_text','sent_text','edit_distance',
                        'slack_thread_ts','sent_by_user_id') ORDER BY name;"
echo "  new tables:"
run_sql "SELECT '    ' || name FROM sqlite_master
         WHERE type='table' AND name IN ('guest_dossiers','sarah_voice_corpus','voice_drafts_log')
         ORDER BY name;"

echo "[migration 006] done"
