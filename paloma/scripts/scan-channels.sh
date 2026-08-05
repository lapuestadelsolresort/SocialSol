#!/usr/bin/env bash
# Paloma 🕊️ — Channel task scanner
# Scans #mantenimiento and #limpieza for new tasks since last scan.
# Intended to run every 4 hours via LaunchAgent.
#
# This script reads new messages, sends them to the OpenClaw agent for
# AI-powered task detection, and logs genuine tasks to the SQLite DB.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PALOMA_DIR="$(dirname "$SCRIPT_DIR")"
DB="$PALOMA_DIR/data/tasks.db"

# Channels to monitor
MAINT_CHANNEL="REDACTED_SLACK_CHANNEL"   # #mantenimiento (repairs)
CLEAN_CHANNEL="REDACTED_SLACK_CHANNEL"   # #limpieza (Daniel's daily tasks)
TRACKER_CHANNEL="REDACTED_SLACK_CHANNEL" # #paloma-tracker (summaries)

# People
SERGIO="REDACTED_SLACK_USER"
DANIEL="REDACTED_SLACK_USER"
MAYELA="REDACTED_SLACK_USER"
JASON="REDACTED_SLACK_USER"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Initialize scan state if needed
for ch in "$MAINT_CHANNEL" "$CLEAN_CHANNEL"; do
  exists=$(sqlite3 "$DB" "SELECT COUNT(*) FROM scan_state WHERE channel_id='$ch';")
  if [ "$exists" -eq 0 ]; then
    # Start scanning from now (don't backfill the entire history on first run)
    sqlite3 "$DB" "INSERT INTO scan_state (channel_id, last_scanned_ts) VALUES ('$ch', '$(date -u +%Y-%m-%dT%H:%M:%SZ)');"
    log "Initialized scan state for $ch"
  fi
done

log "Paloma task scan starting..."

# The actual task detection is delegated to the OpenClaw agent via
# the paloma-scan automation prompt. This script is the LaunchAgent
# entry point that triggers it.

# Send scan trigger to the OpenClaw agent
openclaw run --prompt "You are Paloma 🕊️, the resort task tracker. Run a task scan now:

1. Read the last 20 messages from channel REDACTED_SLACK_CHANNEL (#mantenimiento)
2. Read the last 20 messages from channel REDACTED_SLACK_CHANNEL (#limpieza)
3. For each message, determine if it's a TASK (something broken, needs repair, cleaning job, or action item)
4. For genuine tasks: check if source_ts already exists in paloma/data/tasks.db — skip if so
5. For NEW tasks: insert into the tasks table with description_es (original Spanish), description_en (English translation), source_channel, source_ts, assigned_to (Sergio for maintenance, Daniel for cleaning), reporter info, status
6. Post a bilingual acknowledgment in the original message thread
7. Log what you found to #paloma-tracker (REDACTED_SLACK_CHANNEL)

Use sqlite3 ~/paloma/data/tasks.db for database operations.
All posts must be bilingual (Spanish first, then English).
Be selective — only log genuine action items, not casual chat." \
  --timeout 120 2>&1 || log "Scan completed (or timed out)"

log "Paloma task scan finished."
