#!/bin/bash
# Helper to ping Healthchecks.io. Usage:
#   healthcheck-ping.sh <check-name>        # success ping
#   healthcheck-ping.sh <check-name> fail   # failure ping
# Reads URLs from SOCIALSOL_SECRETS_DIR/healthchecks.json.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-${REPO_ROOT}/secrets}"
SECRETS="$SECRETS_DIR/healthchecks.json"
CHECK_NAME="$1"
RESULT="${2:-}"

if [ ! -f "$SECRETS" ]; then
  echo "healthcheck-ping: $SECRETS not found, skipping ping for $CHECK_NAME" >&2
  exit 0  # don't fail the calling script just because the secret is missing
fi

BASE=$(jq -r '.base_url' "$SECRETS")
UUID=$(jq -r ".checks[\"$CHECK_NAME\"]" "$SECRETS")

if [ -z "$UUID" ] || [ "$UUID" = "null" ]; then
  echo "healthcheck-ping: no UUID for $CHECK_NAME in $SECRETS" >&2
  exit 0
fi

URL="$BASE/$UUID"
[ "$RESULT" = "fail" ] && URL="$URL/fail"

curl -fsS -m 10 --retry 3 -o /dev/null "$URL" || true
