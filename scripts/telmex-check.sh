#!/bin/bash
# telmex-check.sh — Monthly Telmex bill checker
# Fetches the Telmex payment portal and posts to #utility-payments if balance is due.
# Called by LaunchAgent com.lapuestadelsolresort.telmex-check

set -euo pipefail

TELMEX_URL="https://transactconfig2.telmex.com/OP/iniCM?t=3276882655"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PALOMA_CONFIG="${PALOMA_CONFIG_PATH:-$ROOT/paloma/config.json}"
CHANNEL="${RESORT_UTILITY_PAYMENTS_CHANNEL:-$(jq -er '.channels.utility_payments' "$PALOMA_CONFIG")}"
MAYELA_ID="${MAYELA_SLACK_USER_ID:-$(jq -er '.users.mayela' "$PALOMA_CONFIG")}"

# Fetch the payment page
PAGE=$(curl -sL --max-time 30 "$TELMEX_URL" 2>/dev/null || echo "FETCH_ERROR")

if [[ "$PAGE" == "FETCH_ERROR" ]]; then
  echo "$(date): Failed to fetch Telmex page" >&2
  exit 1
fi

# Extract balance amount (look for peso amount pattern)
# The page shows "$ XXXX.XX" for the balance
BALANCE=$(echo "$PAGE" | grep -oP '\$\s*[\d,]+\.\d{2}' | head -1 | tr -d '$ ,' || echo "")

# Extract due date
DUE_DATE=$(echo "$PAGE" | grep -oP 'Fecha límite de pago:\s*\K[\d/]+' | head -1 || echo "")

if [[ -z "$BALANCE" || "$BALANCE" == "0.00" ]]; then
  echo "$(date): No balance due or could not parse. Skipping notification."
  exit 0
fi

echo "$(date): Telmex balance detected: \$$BALANCE, due: $DUE_DATE"
echo "Posting to #utility-payments..."

# Use openclaw CLI to send the notification
openclaw send --account "${OPENCLAW_SLACK_ACCOUNT:?OPENCLAW_SLACK_ACCOUNT is required}" --channel slack --target "channel:$CHANNEL" \
  "☎️ *Telmex Payment Due*

<@$MAYELA_ID> — the monthly Telmex bill is ready:

• *Amount:* \$$BALANCE MXN
• *Due date:* $DUE_DATE
• *Payment link:* $TELMEX_URL

Please make the payment before the due date. 🙏"

echo "$(date): Notification sent."
