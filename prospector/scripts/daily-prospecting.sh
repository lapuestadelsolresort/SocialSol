#!/usr/bin/env bash
# ─── Prospector Paulina — Daily Autonomous Prospecting ──────────────────────
#
# Runs every weekday at 8:30am PT.
# 1. Engagement analysis + hypothesis (posts to Slack)
# 2. Research: finds wedding/event planners only
# 3. Attach eligible planner contacts to the partner-program campaign
# 4. Calculate the staged daily capacity (10 → 15 → 20)
# 5. Pre-verify enough named mailboxes to keep a safe queue buffer
# 6. Compose that day's capacity → composer applies its approval policy
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

# ── 4. Calculate today's staged capacity ─────────────────────────────────────
CAPACITY_OUTPUT=$(node "$SCRIPTS_DIR/daily-capacity.js" "$CAMPAIGN_SLUG" 2>>"$LOG")
if ! jq -e '.ok == true and (.batch_size | type == "number")' <<<"$CAPACITY_OUTPUT" >/dev/null; then
  log "ERROR: capacity calculation returned invalid JSON: $CAPACITY_OUTPUT"
  exit 1
fi
BATCH_SIZE=$(jq -r '.batch_size' <<<"$CAPACITY_OUTPUT")
DAILY_TARGET=$(jq -r '.daily_target' <<<"$CAPACITY_OUTPUT")
WEEKLY_CAP=$(jq -r '.weekly_cap' <<<"$CAPACITY_OUTPUT")
CAMPAIGN_WEEK=$(jq -r '.campaign_week' <<<"$CAPACITY_OUTPUT")
log "Capacity: campaign week $CAMPAIGN_WEEK | daily target $DAILY_TARGET | weekly cap $WEEKLY_CAP | compose now $BATCH_SIZE"

if [[ "$BATCH_SIZE" -eq 0 ]]; then
  log "Daily or weekly capacity already committed — no new drafts needed"
  exit 0
fi

# ── 5. Pre-verify the queue before spending composer tokens ──────────────────
# Keep a two-day buffer of verified named mailboxes. Verification is fail-closed:
# role inboxes, catch-alls, invalid addresses, and verifier outages do not compose.
QUEUE_BUFFER_DAYS=$(jq -r '.email_verification.queue_buffer_days // 2' "$PROSPECTOR/config.json")
TARGET_VERIFIED=$((BATCH_SIZE * QUEUE_BUFFER_DAYS))
MAX_VERIFY=$(jq -r '.email_verification.max_per_daily_run // 25' "$PROSPECTOR/config.json")
log "Pre-verifying queue: target $TARGET_VERIFIED available (${QUEUE_BUFFER_DAYS}-day buffer), max $MAX_VERIFY checks"
VERIFY_OUTPUT=$(node "$SCRIPTS_DIR/preverify-queue.js" "$CAMPAIGN_SLUG" \
  --target-valid "$TARGET_VERIFIED" --max "$MAX_VERIFY" 2>>"$LOG")
if ! jq -e '.ok == true' <<<"$VERIFY_OUTPUT" >/dev/null; then
  log "ERROR: queue verification returned invalid JSON: $VERIFY_OUTPUT"
  exit 1
fi
VERIFIED_AVAILABLE=$(jq -r '.verified_available_after // .verified_available_before // 0' <<<"$VERIFY_OUTPUT")
CHECKED_COUNT=$(jq -r '.checked // 0' <<<"$VERIFY_OUTPUT")
RISKY_COUNT=$(jq -r '.risky // 0' <<<"$VERIFY_OUTPUT")
INVALID_COUNT=$(jq -r '.invalid // 0' <<<"$VERIFY_OUTPUT")
log "Verification: $CHECKED_COUNT checked | $VERIFIED_AVAILABLE verified available | $RISKY_COUNT risky | $INVALID_COUNT invalid"

# ── 6. Compose batch ─────────────────────────────────────────────────────────
log "Composing up to $BATCH_SIZE partner-program drafts for $CAMPAIGN_SLUG"
cd "$PROSPECTOR"
COMPOSE_OUTPUT=$(node composer.js compose-batch "$CAMPAIGN_SLUG" "$BATCH_SIZE" 2>>"$LOG")
if ! jq -e '.ok == true and (.composed | type == "array") and (.failed | type == "array")' <<<"$COMPOSE_OUTPUT" >/dev/null; then
  log "ERROR: composer returned invalid JSON: $COMPOSE_OUTPUT"
  exit 1
fi
log "Compose result: $COMPOSE_OUTPUT"

# Extract draft IDs from compose output (JSON array of {draft_id: N})
DRAFT_IDS=$(jq -r '[.composed[].draft_id | tostring] | join(",")' <<<"$COMPOSE_OUTPUT")
COMPOSED_COUNT=$(jq -r '.composed | length' <<<"$COMPOSE_OUTPUT")
FAILED_COUNT=$(jq -r '.failed | length' <<<"$COMPOSE_OUTPUT")

log "Composed: $COMPOSED_COUNT | Failed: $FAILED_COUNT | Draft IDs: $DRAFT_IDS"

# ── 7. Report the composer's approval result ─────────────────────────────────
if [[ -n "$DRAFT_IDS" && "$COMPOSED_COUNT" -gt 0 ]]; then
  AUTO_APPROVED_COUNT=$(jq -r '[.composed[] | select(.auto_approved == true)] | length' <<<"$COMPOSE_OUTPUT")
  log "Composer approval result: $AUTO_APPROVED_COUNT/$COMPOSED_COUNT auto-approved"
  if [[ "$AUTO_APPROVED_COUNT" -eq "$COMPOSED_COUNT" ]]; then
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "✅ *$COMPOSED_COUNT emails passed the configured autonomous approval gate* — orchestrator will dispatch them across the scheduled send window." \
      2>/dev/null || log "WARN: Slack post failed"
  else
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "ℹ️ *$COMPOSED_COUNT emails composed; $AUTO_APPROVED_COUNT auto-approved.* Remaining drafts stay pending under the configured policy." \
      2>/dev/null || log "WARN: Slack post failed"
  fi
else
  # Distinguish a truly exhausted queue from a queue that currently has no
  # safe pre-verified mailbox. The latter is a quality guardrail, not success.
  ELIGIBLE=$(sqlite3 "$CRM_DB" "
    SELECT COUNT(*) FROM campaign_contacts cc
    JOIN contacts c ON c.id=cc.contact_id
    WHERE cc.campaign_id=$CAMPAIGN_ID
      AND c.email_status='verified'
      AND
    NOT EXISTS (
      SELECT 1 FROM outreach_sends os
      WHERE os.contact_id=cc.contact_id AND os.campaign_id=cc.campaign_id AND os.status != 'cancelled'
    );
  " 2>/dev/null || echo "0")

  QUEUED_TOTAL=$(sqlite3 "$CRM_DB" "
    SELECT COUNT(*) FROM campaign_contacts cc
    JOIN contacts c ON c.id=cc.contact_id
    WHERE cc.campaign_id=$CAMPAIGN_ID
      AND COALESCE(c.do_not_contact, 0)=0
      AND NOT EXISTS (
        SELECT 1 FROM outreach_sends os
        WHERE os.contact_id=cc.contact_id AND os.campaign_id=cc.campaign_id AND os.status != 'cancelled'
      );
  " 2>/dev/null || echo "0")

  if [[ "$ELIGIBLE" -eq 0 && "$QUEUED_TOTAL" -gt 0 ]]; then
    log "Safety gate held composition: $QUEUED_TOTAL queued contacts but none pre-verified"
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "🛡️ *No email was composed because no safe pre-verified mailbox was available.* Verification checked $CHECKED_COUNT contacts; role, catch-all, invalid, and unknown results remain blocked." \
      2>/dev/null || true
  elif [[ "$ELIGIBLE" -eq 0 ]]; then
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "ℹ️ Campaign queue exhausted — today's research did not leave any new eligible planner contacts. ${FAILED_COUNT} compose failures logged." \
      2>/dev/null || true
  else
    log "WARN: Composed 0 drafts despite $ELIGIBLE eligible contacts. Check composer logs."
    "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" \
      --message "⚠️ *Compose produced 0 drafts* today (${FAILED_COUNT} failures). Check \`prospector/logs/daily-prospecting.log\`." \
      2>/dev/null || true
  fi
fi

log "===== Daily prospecting run complete ====="
