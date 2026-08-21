#!/usr/bin/env bash
# Paloma 🕊️ — Weekly summary digest
# Runs Monday 9:00 AM PT (after follow-ups). Posts a categorized bilingual summary to the tracker channel.
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
PALOMA_JOB_NAME="resort-paloma-summary"
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

log "Paloma weekly summary starting (agent=$AGENT_ID account=$SLACK_ACCOUNT)..."

read -r -d '' PROMPT <<EOF || true
You are Paloma 🕊️, the resort task tracker. Generate the weekly summary. Work only with the commands and targets named here; do not improvise channels or accounts.

Database: $DB (use sqlite3). Slack account: $SLACK_ACCOUNT. Tracker channel: channel:$TRACKER_CHANNEL.

1. Build a categorized report from the tasks table:
   ✅ *Completadas esta semana / Completed this week* — status='completed' AND completed_at >= datetime('now','-7 days')
   🔄 *En progreso / In progress* — status='in_progress'
   ⚠️ *Vencidas / Overdue* — status='open' AND created_at < datetime('now','-7 days')
   📋 *Nuevas esta semana / New this week* — created_at >= datetime('now','-7 days')

2. Format each task as:
   #[id] — [description_es] / [description_en]
   Asignado a / Assigned to: [name] | Reportado / Reported: [date]

3. Post the full summary once to the tracker channel:
   openclaw message send --channel slack --account $SLACK_ACCOUNT --target channel:$TRACKER_CHANNEL --message "<summary>"

4. Include totals at the bottom:
   Total: N tareas / tasks | ✅ N | 🔄 N | ⚠️ N | 📋 N

Bilingual throughout (Spanish first, English second). Finish with exactly NO_REPLY.
EOF

"$OPENCLAW" agent --agent "$AGENT_ID" --message "$PROMPT" --timeout "$TIMEOUT_SECONDS" --json
PALOMA_JOB_DETAIL="weekly summary agent turn completed"

log "Paloma weekly summary finished."
