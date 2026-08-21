#!/usr/bin/env bash
# Paloma 🕊️ — All-membership reconciliation scanner
# Real-time Slack delivery is the primary path. This manual/LaunchAgent entry
# point provides an independent reconciliation pass across every channel the
# Paloma Slack account has joined.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PALOMA_DIR="$(dirname "$SCRIPT_DIR")"
SOCIALSOL_ROOT="$(dirname "$PALOMA_DIR")"
PALOMA_JOB_NAME="resort-paloma-scan"
PALOMA_JOB_DETAIL="did not finish"
# shellcheck source=paloma/scripts/job-status.sh
source "$SCRIPT_DIR/job-status.sh"
paloma_job_status_trap

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Paloma all-channel reconciliation starting..."
node "$SCRIPT_DIR/run-channel-monitor.js"
PALOMA_JOB_DETAIL="reconciliation scan agent turn completed"
log "Paloma all-channel reconciliation finished."
