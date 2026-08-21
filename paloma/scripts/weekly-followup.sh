#!/usr/bin/env bash
# Paloma 🕊️ — Weekly follow-up on open tasks
# Runs Monday 8:00 AM PT. Finds overdue tasks (open/in_progress, >7 days with no update) and posts bilingual follow-ups in original threads.
#
# F-066: this script used to invoke a CLI verb the deployed OpenClaw does not
# have and then swallowed the resulting error behind a log line, so it exited 0
# every Monday having done nothing. It now runs one gateway agent turn through
# the same `openclaw agent` entry point the reconciliation scan uses, lets any
# failure exit nonzero, and records its result for the job watchdog.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PALOMA_DIR="$(dirname "$SCRIPT_DIR")"
SOCIALSOL_ROOT="$(dirname "$PALOMA_DIR")"
DB="$PALOMA_DIR/data/tasks.db"
CONFIG="${PALOMA_CONFIG_PATH:-$PALOMA_DIR/config.json}"
PALOMA_JOB_NAME="resort-paloma-followup"
PALOMA_JOB_DETAIL="did not finish"
# shellcheck source=paloma/scripts/job-status.sh
source "$SCRIPT_DIR/job-status.sh"
paloma_job_status_trap

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

TRACKER_CHANNEL="$(jq -er '.channels.tracker' "$CONFIG")"
SLACK_ACCOUNT="${PALOMA_SLACK_ACCOUNT:-$(jq -er '.monitoring.slack_account' "$CONFIG")}"
AGENT_ID="${PALOMA_AGENT_ID:-$(jq -r '.monitoring.agent_id // "paloma"' "$CONFIG")}"
TIMEOUT_SECONDS="$(jq -r '.monitoring.timeout_seconds // 300' "$CONFIG")"
OPENCLAW="${OPENCLAW_BIN:-openclaw}"

log "Paloma weekly follow-up starting (agent=$AGENT_ID account=$SLACK_ACCOUNT)..."

read -r -d '' PROMPT <<EOF || true
You are Paloma 🕊️, the resort task tracker. Run the weekly follow-up. Work only with the commands and targets named here; do not improvise channels or accounts.

Database: $DB (use sqlite3). Slack account: $SLACK_ACCOUNT. Tracker channel: channel:$TRACKER_CHANNEL.

1. Query the overdue tasks:
   SELECT * FROM tasks WHERE status IN ('open','in_progress')
     AND created_at < datetime('now','-7 days')
     AND (last_follow_up_at IS NULL OR last_follow_up_at < datetime('now','-7 days'))

2. For each overdue task, post exactly one bilingual follow-up in the ORIGINAL thread:
   openclaw message send --channel slack --account $SLACK_ACCOUNT --target channel:<source_channel> --reply-to <source_ts> --message "<text>"
   Text:
      🕊️ *Paloma*
      Hola [name], esta tarea fue reportada hace [N] días: \"[description_es]\"
      ¿Ya está resuelta o necesitas algo para completarla?
      ---
      Hi [name], this task was reported [N] days ago: \"[description_en]\"
      Is it resolved, or do you need anything to complete it?
   Then UPDATE tasks SET last_follow_up_at=datetime('now') for that task and INSERT a task_updates row (update_type='follow_up_sent').

3. Post one summary to the tracker channel:
   openclaw message send --channel slack --account $SLACK_ACCOUNT --target channel:$TRACKER_CHANNEL --message "<summary>"
   🕊️ *Seguimiento Semanal / Weekly Follow-Up*
   Followed up on N overdue tasks:
   - [task #, description, assigned to, days old]

4. If there are NO overdue tasks, post a brief bilingual 'all clear' to the tracker channel instead.

All messages bilingual (Spanish first, English second). Finish with exactly NO_REPLY.
EOF

"$OPENCLAW" agent --agent "$AGENT_ID" --message "$PROMPT" --timeout "$TIMEOUT_SECONDS" --json
PALOMA_JOB_DETAIL="weekly follow-up agent turn completed"

log "Paloma weekly follow-up finished."
