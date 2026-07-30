#!/bin/bash
# Prospector Paulina — daily stale-draft sweep.
#
# Wired to ~/Library/LaunchAgents/com.lapuestadelsolresort.stale-draft-sweep.plist,
# fires once daily at 09:00 PT. Calls the CRM's POST /api/drafts/sweep-stale,
# which auto-cancels every pending_approval draft whose posted_at is older
# than 7 days. Posts a one-line summary to #prospector-paulina iff N>0 (no
# channel noise on quiet days). Healthcheck ping on success matches the
# existing pattern from warmup-daily.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOCIALSOL_ROOT="${SOCIALSOL_ROOT:-$REPO_ROOT}"
PROSPECTOR_DIR="$SOCIALSOL_ROOT/prospector"
CONFIG="$PROSPECTOR_DIR/config.json"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-$SOCIALSOL_ROOT/secrets}"
HEALTHCHECK_KEYS="$SECRETS_DIR/healthchecks.json"
LOG_DIR="$PROSPECTOR_DIR/logs"
OPENCLAW="${OPENCLAW_BIN:-/opt/homebrew/bin/openclaw}"
mkdir -p "$LOG_DIR"

CRM_BASE="${CRM_BASE_URL:-http://localhost:3456}"
CHANNEL_ID=$(jq -r '.channel_id' "$CONFIG")

# Hit the sweep endpoint.
RESPONSE=$(curl -s -X POST "$CRM_BASE/api/drafts/sweep-stale" \
  -H 'Content-Type: application/json' -d '{}')

OK=$(echo "$RESPONSE" | jq -r '.ok')
N=$(echo "$RESPONSE" | jq -r '.cancelled // 0')
IDS=$(echo "$RESPONSE" | jq -r '.ids | join(",")')

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] sweep-stale: ok=$OK cancelled=$N ids=[$IDS]"

if [ "$OK" != "true" ]; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] FAILED: $RESPONSE"
  exit 1
fi

if [ "$N" -gt 0 ]; then
  MSG="🧹 Auto-rejected $N stale draft(s) (>7d unreviewed). IDs: $IDS"
  "$OPENCLAW" message send \
    --channel slack \
    --account "${OPENCLAW_SLACK_ACCOUNT:?Set OPENCLAW_SLACK_ACCOUNT}" \
    --target "$CHANNEL_ID" \
    --message "$MSG" --json >/dev/null 2>&1 || \
    echo "[sweep-stale] Slack post failed (non-fatal)"
fi

# Healthcheck ping (optional)
if [ -f "$HEALTHCHECK_KEYS" ]; then
  HC_URL=$(jq -r '.stale_draft_sweep // empty' "$HEALTHCHECK_KEYS")
  if [ -n "$HC_URL" ]; then
    curl -fsS -m 10 --retry 3 "$HC_URL" >/dev/null 2>&1 || true
  fi
fi
