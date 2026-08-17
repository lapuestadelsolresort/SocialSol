#!/bin/bash
# Weekly Kapital accounting integrity control.
# LaunchAgent: com.lapuestadelsolresort.kapital-tests (Mondays 08:00 PT)
#
# The Python control posts its own report to the accounting channel, writes a
# durable run record, and reports to job_health, so this wrapper only has to
# resolve the channel and pass the exit code through untouched — launchd must
# see a real failure as a failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The channel-policy require below is CWD-relative; never depend on the
# caller's WorkingDirectory for it.
cd "$ROOT"

if [ -z "${RESORT_ACCOUNTING_CHANNEL:-}" ]; then
  RESORT_ACCOUNTING_CHANNEL="$(node -e "const {loadPolicy}=require('./crm/lib/channel-policy');const row=Object.entries(loadPolicy().channels).find(([,v])=>v.name==='accounting');if(!row)process.exit(1);process.stdout.write(row[0])")"
  export RESORT_ACCOUNTING_CHANNEL
fi
: "${RESORT_ACCOUNTING_CHANNEL:?accounting channel is not configured}"
: "${OPENCLAW_SLACK_ACCOUNT:?OPENCLAW_SLACK_ACCOUNT is required}"

exec python3 accounting/tests.py "${1:-3}"
