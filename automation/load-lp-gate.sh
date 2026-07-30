#!/bin/sh
# Installs the already-rendered LP phase-gate LaunchAgent.
set -e
LABEL="com.lapuestadelsolresort.lp-phase-gate"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${SOCIALSOL_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SRC="${SOCIALSOL_LAUNCHAGENTS_DIR:-$ROOT/deploy/launchagents/generated}/$LABEL.plist"
DST_DIR="$HOME/Library/LaunchAgents"
DST="$DST_DIR/$LABEL.plist"

if [ ! -f "$SRC" ]; then
  echo "Missing rendered LaunchAgent: $SRC" >&2
  echo "Run: npm run render:launchagents" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
cp "$SRC" "$DST"
# Reload cleanly if already loaded.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DST"

if launchctl list | grep -q "$LABEL"; then
  echo "✅ phase-gate loaded — runs daily at 8am, alerts #social-sol at 100 sessions."
else
  echo "⚠️  load reported no error but the job is not listed; check: launchctl list | grep lp-phase-gate"
fi
