#!/usr/bin/env bash
# ─── Prospector Paulina — Daily Autonomous Prospecting ──────────────────────
#
# Runs every weekday at 8:30am PT.
# 1. Engagement analysis + hypothesis (posts to Slack)
# 2. Research: finds new leads (rotating persona)
# 3. Compose 5 drafts → auto-approve → orchestrator sends them
#
# No human approval required. Jason sees daily report in #prospector-paulina.
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOCIALSOL_ROOT="${SOCIALSOL_ROOT:-$REPO_ROOT}"
PROSPECTOR="$SOCIALSOL_ROOT/prospector"
CRM_DB="${DB_PATH:-$SOCIALSOL_ROOT/crm/data/crm.db}"
SCRIPTS_DIR="$PROSPECTOR/scripts"
LOG="$PROSPECTOR/logs/daily-prospecting.log"
OPENCLAW="${OPENCLAW_BIN:-/opt/homebrew/bin/openclaw}"
SLACK_CHANNEL="${PROSPECTOR_SLACK_CHANNEL:?Set PROSPECTOR_SLACK_CHANNEL}"
SLACK_ACCOUNT="${OPENCLAW_SLACK_ACCOUNT:?Set OPENCLAW_SLACK_ACCOUNT}"

mkdir -p "$PROSPECTOR/logs"

log() { echo "[daily-prospecting] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }

# ── 0. Skip weekends ────────────────────────────────────────────────────────
DOW=$(date +%u)  # 1=Mon … 7=Sun
if [[ "$DOW" -ge 6 ]]; then
  log "Weekend — skipping"
  exit 0
fi

log "===== Daily prospecting run starting (DOW=$DOW) ====="

# ── 1. Engagement analysis + hypothesis ─────────────────────────────────────
log "Running engagement analysis"
cd "$SCRIPTS_DIR"
node engagement-analysis.js 2>>"$LOG" || log "WARN: Engagement analysis had errors (check log)"

sleep 5

# ── 2. Research: rotating persona (Mon=wedding Wed=houston Thu=corporate Fri=luxury)
PERSONAS=("wedding_planner" "houston_wedding_planner" "corporate_retreat" "luxury_travel_advisor" "family_retreat")
PERSONA_IDX=$(( (DOW - 1) % ${#PERSONAS[@]} ))
TODAY_PERSONA="${PERSONAS[$PERSONA_IDX]}"

log "Running research for persona: $TODAY_PERSONA"
cd "$PROSPECTOR/research"
node scripts/run-research.js --persona "$TODAY_PERSONA" 2>>"$LOG" || log "WARN: Research run had errors"

sleep 5

# ── 3. Compose batch ─────────────────────────────────────────────────────────
log "Composing drafts for planner_outreach_v1"
cd "$PROSPECTOR"
COMPOSE_OUTPUT=$(node composer.js compose-batch planner_outreach_v1 5 2>>"$LOG")
log "Compose result: $COMPOSE_OUTPUT"

# Extract draft IDs from compose output (JSON array of {draft_id: N})
DRAFT_IDS=$(echo "$COMPOSE_OUTPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [str(c['draft_id']) for c in d.get('composed', [])]
print(','.join(ids))
" 2>/dev/null || echo "")

COMPOSED_COUNT=$(echo "$COMPOSE_OUTPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('composed', [])))
" 2>/dev/null || echo "0")

FAILED_COUNT=$(echo "$COMPOSE_OUTPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('failed', [])))
" 2>/dev/null || echo "0")

log "Composed: $COMPOSED_COUNT | Failed: $FAILED_COUNT | Draft IDs: $DRAFT_IDS"

# ── 4. Auto-approve all new drafts → orchestrator will send ─────────────────
if [[ -n "$DRAFT_IDS" && "$COMPOSED_COUNT" -gt 0 ]]; then
  log "Auto-approving $COMPOSED_COUNT drafts: $DRAFT_IDS"

  # Build SQL IN clause
  APPROVED=$(sqlite3 "$CRM_DB" "
    UPDATE outreach_sends
    SET
      status        = 'approved',
      approved_by   = 'sol_autopilot',
      approved_at   = datetime('now'),
      scheduled_at  = datetime('now')
    WHERE id IN ($DRAFT_IDS)
      AND status = 'pending_approval';
    SELECT changes();
  " 2>>"$LOG")

  log "Auto-approved rows: $APPROVED"
  "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
    --message "✅ *$COMPOSED_COUNT emails auto-approved and queued for send* — orchestrator will dispatch within minutes." \
    2>/dev/null || log "WARN: Slack post failed"
else
  # Check if we've exhausted the campaign
  ELIGIBLE=$(sqlite3 "$CRM_DB" "
    SELECT COUNT(*) FROM campaign_contacts cc
    WHERE NOT EXISTS (
      SELECT 1 FROM outreach_sends os
      WHERE os.contact_id=cc.contact_id AND os.campaign_id=cc.campaign_id AND os.status != 'cancelled'
    );
  " 2>/dev/null || echo "0")

  if [[ "$ELIGIBLE" -eq 0 ]]; then
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "ℹ️ Campaign queue exhausted — today's research results will be attached tomorrow. ${FAILED_COUNT} compose failures logged." \
      2>/dev/null || true
  else
    log "WARN: Composed 0 drafts despite $ELIGIBLE eligible contacts. Check composer logs."
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "⚠️ *Compose produced 0 drafts* today (${FAILED_COUNT} failures). Check \`prospector/logs/daily-prospecting.log\`." \
      2>/dev/null || true
  fi
fi

log "===== Daily prospecting run complete ====="
