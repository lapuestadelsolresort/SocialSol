#!/bin/bash
# Verifies the Cloudflare tunnel is reachable end-to-end and pings Healthchecks.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
TUNNEL_URL_FILE="${TUNNEL_URL_FILE:-${REPO_ROOT}/crm/data/tunnel-url.txt}"
PING="$SCRIPT_DIR/healthcheck-ping.sh"

if [ ! -f "$TUNNEL_URL_FILE" ]; then
  "$PING" cloudflare-tunnel fail
  exit 1
fi

TUNNEL_URL=$(cat "$TUNNEL_URL_FILE")
if [ -z "$TUNNEL_URL" ]; then
  "$PING" cloudflare-tunnel fail
  exit 1
fi

if curl -fsS -m 10 -o /dev/null "${TUNNEL_URL}/healthz"; then
  "$PING" cloudflare-tunnel
else
  "$PING" cloudflare-tunnel fail
fi
