#!/bin/bash
# QBO Token Keepalive — refreshes the access token weekly so the refresh token never expires (101-day TTL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="${SOCIALSOL_SECRETS_DIR:-$ROOT/secrets}/quickbooks.json"
CLIENT_ID=$(jq -r '.production.client_id' "$SECRETS")
CLIENT_SECRET=$(jq -r '.production.client_secret' "$SECRETS")
REFRESH_TOKEN=$(jq -r '.tokens.refresh_token' "$SECRETS")
REALM=$(jq -r '.realm_id' "$SECRETS")

RESP=$(curl -s -X POST "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}")

NEW_AT=$(echo "$RESP" | jq -r '.access_token')
NEW_RT=$(echo "$RESP" | jq -r '.refresh_token')
ERROR=$(echo "$RESP" | jq -r '.error // empty')

if [ -n "$ERROR" ]; then
  echo "ERROR: QBO token refresh failed: $ERROR — $(echo "$RESP" | jq -r '.error_description // empty')"
  exit 1
fi

if [ ${#NEW_AT} -lt 50 ]; then
  echo "ERROR: QBO token refresh returned invalid access token (length ${#NEW_AT})"
  exit 1
fi

jq --arg at "$NEW_AT" --arg rt "$NEW_RT" \
  '.tokens.access_token=$at | .tokens.refresh_token=$rt' \
  "$SECRETS" > "${SECRETS}.tmp" && mv "${SECRETS}.tmp" "$SECRETS" && chmod 600 "$SECRETS"

# Quick validation — query company info
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $NEW_AT" -H "Accept: application/json" \
  "https://quickbooks.api.intuit.com/v3/company/$REALM/companyinfo/$REALM")

if [ "$HTTP_CODE" = "200" ]; then
  echo "OK: QBO token refreshed and validated (HTTP $HTTP_CODE)"
else
  echo "WARN: Token refreshed but validation returned HTTP $HTTP_CODE"
fi
