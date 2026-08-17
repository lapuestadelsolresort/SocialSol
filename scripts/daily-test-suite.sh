#!/bin/bash
# daily-test-suite.sh — Run the full CRM test suite and post results to Slack.
# LaunchAgent: com.lapuestadelsolresort.daily-tests (daily at 6:30am PT)
# Exits nonzero on any test/build/post failure and reports to job_health so the
# watchdog owns the alert path (F-015/F-017).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The channel-policy require below is CWD-relative; never depend on the
# caller's WorkingDirectory for it.
cd "$ROOT"
CHANNEL="${RESORT_ACCOUNTING_CHANNEL:-}"
if [ -z "$CHANNEL" ]; then
  CHANNEL="$(node -e "const {loadPolicy}=require('./crm/lib/channel-policy');const row=Object.entries(loadPolicy().channels).find(([,v])=>v.name==='accounting');if(!row)process.exit(1);process.stdout.write(row[0])")"
fi
: "${CHANNEL:?accounting channel is not configured}"
SLACK_ACCOUNT="${OPENCLAW_SLACK_ACCOUNT:?OPENCLAW_SLACK_ACCOUNT is required}"
OPENCLAW="${OPENCLAW_BIN:-/opt/homebrew/bin/openclaw}"
LOG="$ROOT/logs/daily-tests.log"

report_health() {
  PYTHONPATH="$ROOT/automation" python3 -c "
import sys
from job_health import record
record('resort-daily-tests', sys.argv[1] == 'ok', sys.argv[2] if len(sys.argv) > 2 else None)
" "$1" "${2:-}" || echo "job_health record failed" >> "$LOG"
}

cd "$ROOT/crm"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Running test suite" >> "$LOG"

# Run all tests, capture output and real exit status
TEST_EXIT=0
TEST_OUTPUT=$(node --test test/*.test.js tests/*.test.js 2>&1) || TEST_EXIT=$?

# Extract summary line
SUMMARY=$(echo "$TEST_OUTPUT" | grep -E "^ℹ (tests|pass|fail)" | head -4 || true)
PASS=$(echo "$SUMMARY" | grep "pass" | awk '{print $NF}' || true)
FAIL=$(echo "$SUMMARY" | grep "fail" | awk '{print $NF}' || true)
TOTAL=$(echo "$SUMMARY" | grep "tests" | awk '{print $NF}' || true)

# Also run LP builds to catch markup issues
BUILD_EXIT=0
BUILD_OUTPUT=$(cd "$ROOT" && npm run build:landing 2>&1) || BUILD_EXIT=$?

NOW=$(date '+%Y-%m-%d')

if [ "$TEST_EXIT" = "0" ] && [ "${FAIL:-0}" = "0" ] && [ "$BUILD_EXIT" = "0" ]; then
  SUITE_OK=1
  MSG="✅ *Daily test suite — ${NOW}*
${TOTAL} tests passed. LP builds OK."
else
  SUITE_OK=0
  # Collect failing test names
  FAILURES=$(echo "$TEST_OUTPUT" | grep -E "^✖|ERR_ASSERTION" | head -10 || true)
  MSG="❌ *Daily test suite — ${NOW}*
${PASS:-?}/${TOTAL:-?} passed, *${FAIL:-?} failed* (runner exit ${TEST_EXIT})"

  if [ "$BUILD_EXIT" != "0" ]; then
    MSG="${MSG}
LP build failed (exit ${BUILD_EXIT})."
  fi

  MSG="${MSG}

*Failures:*
\`\`\`
${FAILURES}
\`\`\`"
fi

echo "$TEST_OUTPUT" >> "$LOG"
if [ "$BUILD_EXIT" != "0" ]; then
  echo "$BUILD_OUTPUT" >> "$LOG"
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') — Done: ${PASS:-?}/${TOTAL:-?} pass, ${FAIL:-?} fail, test exit ${TEST_EXIT}, build exit ${BUILD_EXIT}" >> "$LOG"

POST_OK=1
"$OPENCLAW" message send \
  --account "$SLACK_ACCOUNT" \
  --channel slack \
  --target "channel:${CHANNEL}" \
  --message "$MSG" \
  --json 2>>"$LOG" || { POST_OK=0; echo "Slack post failed" >> "$LOG"; }

if [ "$SUITE_OK" = "1" ] && [ "$POST_OK" = "1" ]; then
  report_health ok "${TOTAL:-?} tests passed; LP builds OK"
  exit 0
fi
DETAIL="tests exit ${TEST_EXIT}, ${FAIL:-?} failed; build exit ${BUILD_EXIT}; slack post ok=${POST_OK}"
report_health fail "$DETAIL"
exit 1
