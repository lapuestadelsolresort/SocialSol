#!/bin/bash
# Pings Healthchecks if the CRM /healthz endpoint responds.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PING="$SCRIPT_DIR/healthcheck-ping.sh"

if curl -fsS -m 5 -o /dev/null http://localhost:3456/healthz; then
  "$PING" crm-server
else
  "$PING" crm-server fail
fi
