#!/bin/bash
# rescan-sarah.sh — detect drift and ingest new footage in the local
# originals tree. Invoke it from a scheduler or run it manually after
# dropping new files into the originals tree. Idempotent:
# quiet no-op when nothing changed.
#
# New footage goes into $SOURCE/{A_CAM,B_CAM,DRONE,AUDIO/HOME,AUDIO/HOST}
# following the same layout the drive had (probe-and-register classifies
# by top folder). A brand-new shoot gets its own directory + a manual
# probe-and-register run with a new slug — see PIPELINE.md.
#
# Stages:
#   1. Rename reconciliation: an asset whose source_path vanished is
#      re-pointed at a same-directory file with an identical byte size
#      (unique match only). Keeps captions/embeddings; costs nothing.
#   2. probe-and-register for genuinely new files, then the local + paid
#      pipeline stages for whatever was registered.
#      Embedding happens via the daily 08:20 media-corpus-indexer.

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESORT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
MEDIA="$RESORT/media"
SHOOT_SLUG="${MEDIA_SHOOT_SLUG:?MEDIA_SHOOT_SLUG is required}"
SOURCE="${MEDIA_SOURCE_DIR:-$MEDIA/originals/$SHOOT_SLUG}"
DB_PATH="${DB_PATH:-$RESORT/crm/data/crm.db}"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-$RESORT/secrets}"
OPENAI_SECRET="$SECRETS_DIR/openai.json"
ENV_FILE="${SOCIALSOL_ENV_FILE:-$RESORT/.env}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

if [[ ! -d "$SOURCE" ]]; then
  log "media-rescan: $SOURCE missing — skipping"
  exit 0
fi

log "media-rescan starting ($SOURCE)"

# ── Stage 1: rename reconciliation ──────────────────────────────────────
reconciled=0
while IFS='|' read -r id size src; do
  [[ -n "$id" ]] || continue
  [[ -f "$src" ]] && continue
  dir="$(dirname "$src")"
  [[ -d "$dir" ]] || continue
  match=""
  matches=0
  while IFS= read -r cand; do
    base="$(basename "$cand")"
    [[ "$base" == ._* ]] && continue
    in_db=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM media_assets WHERE source_path='$dir/$base';")
    [[ "$in_db" == "0" ]] || continue
    cand_size=$(stat -f '%z' "$cand" 2>/dev/null || echo 0)
    if [[ "$cand_size" == "$size" ]]; then
      match="$base"
      matches=$((matches + 1))
    fi
  done < <(find "$dir" -maxdepth 1 -type f 2>/dev/null)
  if [[ $matches -eq 1 ]]; then
    log "reconcile: asset #$id $(basename "$src") → $match (size match $size)"
    sqlite3 "$DB_PATH" "UPDATE media_assets SET filename='$match', source_path='$dir/$match' WHERE id=$id;"
    reconciled=$((reconciled + 1))
  elif [[ $matches -gt 1 ]]; then
    log "reconcile: asset #$id $(basename "$src") — $matches same-size candidates, leaving for manual review"
  else
    log "reconcile: asset #$id $(basename "$src") — source gone, no size match (deleted or re-trimmed?)"
  fi
done < <(sqlite3 "$DB_PATH" "SELECT id, size_bytes, source_path FROM media_assets WHERE source_path LIKE '$SOURCE/%' AND status != 'excluded';")
log "reconcile: $reconciled asset(s) re-pointed"

# ── Stage 2: register + process new files ───────────────────────────────
cd "$MEDIA"

probe_out=$(node scripts/probe-and-register.js --shoot-slug="$SHOOT_SLUG" --source-root="$SOURCE" 2>&1)
echo "$probe_out"
new_count=$(echo "$probe_out" | sed -n 's/.*done\. registered=\([0-9]*\).*/\1/p')
new_count="${new_count:-0}"

if [[ "$new_count" == "0" ]]; then
  log "media-rescan done — no new files"
  exit 0
fi

log "media-rescan: $new_count new asset(s) — running pipeline"

# transcribe.js needs OPENAI_API_KEY (Whisper); caption/synthesize pull the
# Anthropic key themselves via crm/lib/anthropic-key.
if [[ -z "${OPENAI_API_KEY:-}" && -f "$OPENAI_SECRET" ]]; then
  OPENAI_API_KEY=$(jq -r '.api_key // empty' "$OPENAI_SECRET")
  export OPENAI_API_KEY
fi
if [[ -z "${OPENAI_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  OPENAI_API_KEY=$(awk -F= '/^OPENAI_API_KEY=/ { sub(/^OPENAI_API_KEY=/, ""); print; exit }' "$ENV_FILE")
  export OPENAI_API_KEY
fi

set -e
node scripts/generate-proxies.js --concurrency=2
node scripts/generate-waveforms.js
node scripts/transcribe.js --concurrency=1
node scripts/caption-keyframes.js --concurrency=3
node scripts/synthesize-clip.js --concurrency=2
set +e

log "media-rescan done — $new_count new asset(s) processed; embeddings land via the daily 08:20 media-corpus-indexer"
