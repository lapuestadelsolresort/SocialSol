#!/usr/bin/env bash
# Paloma 🕊️ — Weekly summary digest
# Runs Monday 9:00 AM PDT (after follow-ups). Posts a categorized
# bilingual summary to #paloma-tracker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PALOMA_DIR="$(dirname "$SCRIPT_DIR")"
DB="$PALOMA_DIR/data/tasks.db"

TRACKER_CHANNEL="C0BN440C2BA"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Paloma weekly summary starting..."

openclaw run --prompt "You are Paloma 🕊️, the resort task tracker. Generate the weekly summary:

1. Query paloma/data/tasks.db and build a categorized report:

   ✅ *Completadas esta semana / Completed this week*
   Tasks where status='completed' AND completed_at >= datetime('now','-7 days')

   🔄 *En progreso / In progress*
   Tasks where status='in_progress'

   ⚠️ *Vencidas / Overdue* (open > 7 days)
   Tasks where status='open' AND created_at < datetime('now','-7 days')

   📋 *Nuevas esta semana / New this week*
   Tasks where created_at >= datetime('now','-7 days')

2. Format each task as:
   #[id] — [description_es] / [description_en]
   Asignado a / Assigned to: [name] | Reportado / Reported: [date]

3. Post the full summary to #paloma-tracker (C0BN440C2BA)

4. Include totals at the bottom:
   Total: N tareas / tasks | ✅ N | 🔄 N | ⚠️ N | 📋 N

Use sqlite3 for DB. Bilingual throughout." \
  --timeout 120 2>&1 || log "Summary completed (or timed out)"

log "Paloma weekly summary finished."
