#!/usr/bin/env bash
# ─── Prospector Paulina — Daily Autonomous Prospecting ──────────────────────
#
# Runs every weekday at 8:30am PT.
# 1. Engagement analysis + hypothesis (posts to Slack)
# 2. Research: finds wedding/event planners only
# 3. Attach eligible planner contacts to the partner-program campaign
# 4. Compose 5 drafts → auto-approve → orchestrator sends them
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
STATE_PATH="$PROSPECTOR/state.json"
CAMPAIGN_SLUG="${PAULINA_CAMPAIGN_SLUG:-planner_partner_program_v1}"
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

# A pause blocks the whole autonomous loop. This prevents research and
# auto-approved drafts from piling up while the orchestrator is intentionally
# stopped for strategy, compliance, or deliverability review.
if [[ -f "$STATE_PATH" ]] && jq -e '.paused == true' "$STATE_PATH" >/dev/null 2>&1; then
  PAUSE_REASON=$(jq -r '.pause_reason // "unspecified"' "$STATE_PATH")
  log "Paulina is paused — skipping research and composition ($PAUSE_REASON)"
  exit 0
fi

log "===== Daily prospecting run starting (DOW=$DOW) ====="

# ── 1. Engagement analysis + hypothesis ─────────────────────────────────────
log "Running engagement analysis"
cd "$SCRIPTS_DIR"
node engagement-analysis.js 2>>"$LOG" || log "WARN: Engagement analysis had errors (check log)"

sleep 5

# ── 2. Research: planners only ───────────────────────────────────────────────
# Alternate the general destination-planner and Houston planner query banks.
# Both feed the same wedding-planner partner-program persona in the composer.
PERSONAS=("wedding_planner" "houston_wedding_planner")
PERSONA_IDX=$(( (DOW - 1) % ${#PERSONAS[@]} ))
TODAY_PERSONA="${PERSONAS[$PERSONA_IDX]}"

log "Running research for persona: $TODAY_PERSONA"
cd "$PROSPECTOR/research"
node scripts/run-research.js --persona "$TODAY_PERSONA" 2>>"$LOG" || log "WARN: Research run had errors"

sleep 5

# ── 3. Attach eligible planner contacts ──────────────────────────────────────
CAMPAIGN_ID=$(sqlite3 "$CRM_DB" "SELECT id FROM outreach_campaigns WHERE slug='$CAMPAIGN_SLUG' AND status='active' LIMIT 1;")
if [[ -z "$CAMPAIGN_ID" ]]; then
  log "ERROR: active campaign '$CAMPAIGN_SLUG' not found"
  exit 1
fi

ATTACHED=$(sqlite3 "$CRM_DB" "
  INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, attached_by)
  SELECT $CAMPAIGN_ID, c.id, 'daily-prospecting'
  FROM contacts c
  WHERE c.email IS NOT NULL AND trim(c.email) <> ''
    AND COALESCE(c.do_not_contact, 0) = 0
    AND COALESCE(c.status, 'new') NOT IN ('replied', 'converted', 'dead')
    AND (
      c.source_query LIKE '%_wedding_planner'
      OR c.source_query LIKE '%_houston_wedding_planner'
      OR EXISTS (
        SELECT 1
        FROM campaign_contacts old_cc
        JOIN outreach_campaigns old_oc ON old_oc.id = old_cc.campaign_id
        WHERE old_cc.contact_id = c.id AND old_oc.slug = 'planner_outreach_v1'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM suppressions s WHERE lower(s.email) = lower(c.email)
    );
  SELECT changes();
")
log "Attached $ATTACHED eligible planner contacts to $CAMPAIGN_SLUG"

# ── 4. Compose batch ─────────────────────────────────────────────────────────
log "Composing partner-program drafts for $CAMPAIGN_SLUG"
cd "$PROSPECTOR"
COMPOSE_OUTPUT=$(node composer.js compose-batch "$CAMPAIGN_SLUG" 5 2>>"$LOG")
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

# ── 5. Auto-approve all new drafts → orchestrator will send ─────────────────
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
    WHERE cc.campaign_id=$CAMPAIGN_ID
      AND
    NOT EXISTS (
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
