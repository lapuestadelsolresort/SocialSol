#!/bin/bash
# Pings Healthchecks if the Chroma server heartbeat endpoint responds.
# Mirrors crm-heartbeat.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PING="$SCRIPT_DIR/healthcheck-ping.sh"

if curl -fsS -m 5 -o /dev/null http://127.0.0.1:8000/api/v2/heartbeat; then
  "$PING" chroma-server
else
  "$PING" chroma-server fail
fi
