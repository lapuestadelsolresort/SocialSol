#!/bin/sh
# Loads the LP phase-gate launchd agent (daily 8am; posts to #social-sol at 100
# sessions). Safe to re-run from the repository root.
set -e
LABEL="com.lapuestadelsolresort.lp-phase-gate"
SRC="$HOME/.openclaw/launchagents/$LABEL.plist"
DST_DIR="$HOME/Library/LaunchAgents"
DST="$DST_DIR/$LABEL.plist"

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
