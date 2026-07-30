#!/bin/bash
# voice-corpus-indexer wrapper. Invoked daily by
# com.lapuestadelsolresort.voice-corpus-indexer.plist (RunAtLoad + 08:15).
#
# Sources OPENAI_API_KEY from the repository environment, runs the Node indexer,
# fail-pings Healthchecks on error and success-pings on completion.
#
# Forwarded flags: any args to this script pass through to the Node CLI.
# Useful: --dry-run, --limit=N, --verify-idempotency, --reindex-failed.

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESORT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-${RESORT}/secrets}"
HC_PING="$SCRIPT_DIR/healthcheck-ping.sh"
INDEXER="$SCRIPT_DIR/index-voice-corpus.js"
OPENAI_SECRET="$SECRETS_DIR/openai.json"
ENV_FILE="${SOCIALSOL_ENV_FILE:-${RESORT}/.env}"

trap '"$HC_PING" voice-corpus-indexer fail 2>/dev/null; exit 1' ERR

# Resolve OPENAI_API_KEY. Preference order:
#   1. already exported in env
#   2. SOCIALSOL_SECRETS_DIR/openai.json
#   3. repository .env line 'OPENAI_API_KEY=...'
# We pull values without `source`ing because other .env entries contain
# unquoted shell metacharacters that break `set -a; source`.
if [[ -z "${OPENAI_API_KEY:-}" && -f "$OPENAI_SECRET" ]]; then
  OPENAI_API_KEY=$(jq -r '.api_key // empty' "$OPENAI_SECRET")
  export OPENAI_API_KEY
fi
if [[ -z "${OPENAI_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  OPENAI_API_KEY=$(awk -F= '/^OPENAI_API_KEY=/ { sub(/^OPENAI_API_KEY=/, ""); print; exit }' "$ENV_FILE")
  export OPENAI_API_KEY
fi

# Reject a placeholder value so the wrapper fails loudly
# rather than burning a Healthchecks fail-ping on a 401 from OpenAI.
if [[ "${OPENAI_API_KEY:-}" == "not needed" || "${OPENAI_API_KEY:-}" == *"not needed"* ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: OPENAI_API_KEY in $ENV_FILE is the placeholder 'not needed'." >&2
  echo "  Drop a real key into $OPENAI_SECRET (preferred) or replace the .env value." >&2
  exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" || "${OPENAI_API_KEY:-}" =~ ^[[:space:]]*$ ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: OPENAI_API_KEY missing." >&2
  echo "  Looked in (in order): \$OPENAI_API_KEY, $OPENAI_SECRET, $ENV_FILE" >&2
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] voice-corpus-indexer starting (args: $*)"
node "$INDEXER" "$@"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] voice-corpus-indexer done"

"$HC_PING" voice-corpus-indexer 2>/dev/null || true
