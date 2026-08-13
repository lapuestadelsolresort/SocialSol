#!/usr/bin/env bash
# Paloma 🕊️ — All-membership reconciliation scanner
# Real-time Slack delivery is the primary path. This manual/LaunchAgent entry
# point provides an independent reconciliation pass across every channel the
# Paloma Slack account has joined.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Paloma all-channel reconciliation starting..."
node "$SCRIPT_DIR/run-channel-monitor.js"
log "Paloma all-channel reconciliation finished."
