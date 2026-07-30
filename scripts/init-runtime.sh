#!/usr/bin/env bash
set -euo pipefail

ROOT="${SOCIALSOL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

for directory in \
  "$ROOT/backups/resort-crm" \
  "$ROOT/crm/data" \
  "$ROOT/crm/logs" \
  "$ROOT/logs" \
  "$ROOT/prospector/logs" \
  "$ROOT/prospector/research/cache/pages" \
  "$ROOT/prospector/research/runs" \
  "$ROOT/regina/logs" \
  "$ROOT/secrets" \
  "$ROOT/warmup/logs"; do
  mkdir -p "$directory"
done

chmod 700 "$ROOT/secrets" "$ROOT/backups/resort-crm"
echo "Runtime directories initialized under $ROOT"
