#!/usr/bin/env bash
# Paloma 🕊️ — Weekly follow-up on open tasks
# Runs Monday 8:00 AM PDT. Finds overdue tasks (open/in_progress, >7 days
# with no update) and posts bilingual follow-ups in original threads.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PALOMA_DIR="$(dirname "$SCRIPT_DIR")"
DB="$PALOMA_DIR/data/tasks.db"
CONFIG="${PALOMA_CONFIG_PATH:-$PALOMA_DIR/config.json}"
TRACKER_CHANNEL="$(jq -er '.channels.tracker' "$CONFIG")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Paloma weekly follow-up starting..."

openclaw run --prompt "You are Paloma 🕊️, the resort task tracker. Run the weekly follow-up:

1. Query paloma/data/tasks.db for all tasks WHERE status IN ('open','in_progress')
   AND created_at < datetime('now','-7 days')
   AND (last_follow_up_at IS NULL OR last_follow_up_at < datetime('now','-7 days'))

2. For each overdue task:
   a. Post a polite bilingual follow-up in the ORIGINAL thread (source_channel + source_ts as thread_ts):
      🕊️ *Paloma*
      Hola [name], esta tarea fue reportada hace [N] días: \"[description_es]\"
      ¿Ya está resuelta o necesitas algo para completarla?
      ---
      Hi [name], this task was reported [N] days ago: \"[description_en]\"
      Is it resolved, or do you need anything to complete it?

   b. Update last_follow_up_at in the DB
   c. Insert a task_updates row (update_type='follow_up_sent')

3. Post a summary to #paloma-tracker ($TRACKER_CHANNEL):
   🕊️ *Seguimiento Semanal / Weekly Follow-Up*
   Followed up on N overdue tasks:
   - [list each with task #, description, assigned to, days old]

4. If there are NO overdue tasks, post a brief 'all clear' to #paloma-tracker.

Use sqlite3 for DB operations. All messages bilingual (Spanish first, English second)." \
  --timeout 120 2>&1 || log "Follow-up completed (or timed out)"

log "Paloma weekly follow-up finished."
