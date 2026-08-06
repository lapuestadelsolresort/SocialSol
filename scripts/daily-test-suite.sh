#!/bin/bash
# daily-test-suite.sh — Run the full CRM test suite and post results to Slack.
# LaunchAgent: com.lapuestadelsolresort.daily-tests (daily at 6:30am PT)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANNEL="REDACTED_SLACK_CHANNEL"
SLACK_ACCOUNT="ig-drafts"
OPENCLAW="/opt/homebrew/bin/openclaw"
LOG="$ROOT/logs/daily-tests.log"

cd "$ROOT/crm"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Running test suite" >> "$LOG"

# Run all tests, capture output
TEST_OUTPUT=$(node --test test/*.test.js tests/*.test.js 2>&1) || true
EXIT_CODE=${PIPESTATUS[0]:-$?}

# Extract summary line
SUMMARY=$(echo "$TEST_OUTPUT" | grep -E "^ℹ (tests|pass|fail)" | head -4)
PASS=$(echo "$SUMMARY" | grep "pass" | awk '{print $NF}')
FAIL=$(echo "$SUMMARY" | grep "fail" | awk '{print $NF}')
TOTAL=$(echo "$SUMMARY" | grep "tests" | awk '{print $NF}')

# Also run LP builds to catch markup issues
BUILD_OUTPUT=$(cd "$ROOT" && npm run build:landing 2>&1) || true
BUILD_EXIT=${PIPESTATUS[0]:-$?}

NOW=$(date '+%Y-%m-%d')

if [ "${FAIL:-0}" = "0" ] && [ "${BUILD_EXIT:-0}" = "0" ]; then
  MSG="✅ *Daily test suite — ${NOW}*
${TOTAL} tests passed. LP builds OK."
else
  # Collect failing test names
  FAILURES=$(echo "$TEST_OUTPUT" | grep -E "^✖|ERR_ASSERTION" | head -10)
  MSG="❌ *Daily test suite — ${NOW}*
${PASS:-?}/${TOTAL:-?} passed, *${FAIL:-?} failed*"

  if [ "${BUILD_EXIT:-0}" != "0" ]; then
    MSG="${MSG}
LP build failed."
  fi

  MSG="${MSG}

*Failures:*
\`\`\`
${FAILURES}
\`\`\`"
fi

echo "$TEST_OUTPUT" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') — Done: ${PASS:-?}/${TOTAL:-?} pass, ${FAIL:-?} fail" >> "$LOG"

"$OPENCLAW" message send \
  --account "$SLACK_ACCOUNT" \
  --channel slack \
  --target "channel:${CHANNEL}" \
  --message "$MSG" \
  --json 2>>"$LOG" || echo "Slack post failed" >> "$LOG"
