#!/bin/bash
# media-corpus-indexer wrapper. Mirrors index-voice-corpus.sh.
# Invoked daily by com.lapuestadelsolresort.media-corpus-indexer.plist
# (RunAtLoad + 08:20 PT).

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-$REPO_ROOT/secrets}"
HC_PING="$REPO_ROOT/crm/scripts/healthcheck-ping.sh"
INDEXER="$REPO_ROOT/media/scripts/index-media-corpus.js"
OPENAI_SECRET="$SECRETS_DIR/openai.json"
ENV_FILE="${SOCIALSOL_ENV_FILE:-$REPO_ROOT/.env}"

trap '"$HC_PING" media-corpus-indexer fail 2>/dev/null || true; exit 1' ERR

if [[ -z "${OPENAI_API_KEY:-}" && -f "$OPENAI_SECRET" ]]; then
  OPENAI_API_KEY=$(jq -r '.api_key // empty' "$OPENAI_SECRET")
  export OPENAI_API_KEY
fi
if [[ -z "${OPENAI_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  OPENAI_API_KEY=$(awk -F= '/^OPENAI_API_KEY=/ { sub(/^OPENAI_API_KEY=/, ""); print; exit }' "$ENV_FILE")
  export OPENAI_API_KEY
fi
if [[ -z "${OPENAI_API_KEY:-}" || "${OPENAI_API_KEY:-}" == *"not needed"* ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: OPENAI_API_KEY missing or placeholder." >&2
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] media-corpus-indexer starting (args: $*)"
node "$INDEXER" "$@"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] media-corpus-indexer done"
"$HC_PING" media-corpus-indexer 2>/dev/null || true
