#!/bin/bash
# Long-running Chroma server. Invoked by com.lapuestadelsolresort.chroma.plist
# under launchd KeepAlive supervision.
#
# Recovery procedure if /chroma-data is corrupted or empty:
#   1. Stop this LaunchAgent: launchctl unload ~/Library/LaunchAgents/com.lapuestadelsolresort.chroma.plist
#   2. Move or remove the configured Chroma data directory
#   3. Reload: launchctl load ~/Library/LaunchAgents/com.lapuestadelsolresort.chroma.plist
#   4. Re-run indexer: bash crm/scripts/index-voice-corpus.sh
#   The corpus is rebuildable from sarah_voice_corpus in SQLite for ~$0.003.
#
# `exec` so launchd sees the real Chroma PID for KeepAlive supervision (not bash's PID).

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
CHROMA_VENV="${CHROMA_VENV:-${REPO_ROOT}/chroma-venv}"
CHROMA_DATA="${CHROMA_DATA:-${REPO_ROOT}/chroma-data}"
HOST="${CHROMA_HOST:-127.0.0.1}"
PORT="${CHROMA_PORT:-8000}"

if [[ ! -x "$CHROMA_VENV/bin/chroma" ]]; then
  echo "[chroma-server] FATAL: $CHROMA_VENV/bin/chroma missing - run: python3 -m venv $CHROMA_VENV && $CHROMA_VENV/bin/pip install chromadb" >&2
  exit 1
fi

mkdir -p "$CHROMA_DATA"

echo "[chroma-server] $(date '+%Y-%m-%d %H:%M:%S') starting chroma on ${HOST}:${PORT}, path=${CHROMA_DATA}"
exec "$CHROMA_VENV/bin/chroma" run \
  --host "$HOST" \
  --port "$PORT" \
  --path "$CHROMA_DATA"
