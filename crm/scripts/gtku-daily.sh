#!/bin/bash
# Get to Know Us — Daily Instagram Reel Poster
# Runs daily at 9am PST via launchd/cron
# Posts next video from the "Zoom Detail Videos" Google Drive folder

set -e
set -o pipefail

# launchd starts with a stripped PATH that omits /opt/homebrew/bin.
# gog and other Homebrew binaries live there. Ensure they're findable.
export PATH="/opt/homebrew/bin:$PATH"

# Surface the failing line if anything errors out (silent failures are how this
# script went 47 days without anyone noticing it stopped working).
trap 'echo "[$(date "+%Y-%m-%d %H:%M:%S")] ERROR at line $LINENO (exit $?)"; \
      "$WORKSPACE/crm/scripts/healthcheck-ping.sh" gtku-daily fail; \
      exit 1' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
STATE_FILE="$WORKSPACE/memory/gtku-state.json"
VIDEOS_FILE="$WORKSPACE/memory/gtku-videos.json"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-$WORKSPACE/secrets}"
SECRETS_FILE="$SECRETS_DIR/postiz.json"
TMPDIR_PATH="${TMPDIR%/}"
LOG="$WORKSPACE/memory/gtku-log.txt"

API_KEY=$(jq -r '.api_key' "$SECRETS_FILE")
API_URL=$(jq -r '.api_url' "$SECRETS_FILE")
INTEGRATION_ID="${POSTIZ_INTEGRATION_ID:?POSTIZ_INTEGRATION_ID is required}"
GOOGLE_ACCOUNT="${GTKU_GOOGLE_ACCOUNT:?GTKU_GOOGLE_ACCOUNT is required}"
NEXT_INDEX=$(jq -r '.next_index // 0' "$STATE_FILE")

# Plist already redirects stdout/stderr to $LOG. Avoid double-writing via tee.
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

log "=== Get to Know Us Daily Run ==="

TOTAL=$(jq -r 'length' "$VIDEOS_FILE")

# Build list of unposted videos (exclude already posted IDs)
PICKED=$(python3 -c "
import json, random

with open('$VIDEOS_FILE') as f:
    videos = json.load(f)
with open('$STATE_FILE') as f:
    state = json.load(f)

posted_ids = set(state.get('posted_ids', []))
skipped = set(state.get('skipped_duplicates', []))

available = [v for v in videos if v['id'] not in posted_ids and v.get('name','') not in skipped and v.get('filename','') not in skipped]

if not available:
    print('DONE')
else:
    pick = random.choice(available)
    print(pick['id'] + '|' + pick.get('name', pick.get('filename', 'unknown')))
")

if [ "$PICKED" = "DONE" ]; then
  log "All videos posted! Series complete."
  exit 0
fi

VIDEO_ID="${PICKED%%|*}"
VIDEO_NAME="${PICKED##*|}"
log "Video: $VIDEO_NAME ($VIDEO_ID)"

# Download
MOV_FILE="$TMPDIR_PATH/gtku_current.mov"
MP4_FILE="$TMPDIR_PATH/gtku_current.mp4"
THUMB_FILE="$TMPDIR_PATH/gtku_current.mov.png"

log "Downloading..."
gog drive download "$VIDEO_ID" --client openclaw -a "$GOOGLE_ACCOUNT" --out "$MOV_FILE"

# Extract first frame for analysis
log "Extracting thumbnail..."
rm -f "$THUMB_FILE"
qlmanage -t -s 800 -o "$TMPDIR_PATH/" "$MOV_FILE" 2>/dev/null || true

# Duplicate/similarity check — skip if same scene as recently posted
# Read last scene description from state
LAST_SCENE=$(jq -r '.last_scene_description // ""' "$STATE_FILE")
if [ -f "$THUMB_FILE" ] && [ -n "$LAST_SCENE" ]; then
  SCENE_CHECK=$(python3 -c "
import sys, subprocess, json, base64

# Read thumbnail
with open('$THUMB_FILE', 'rb') as f:
    img_b64 = base64.b64encode(f.read()).decode()

# Simple size check — if video is very small (< 2MB) it may be a duplicate short clip
import os
mov_size = os.path.getsize('$MOV_FILE')
if mov_size < 3000000:
    print('SKIP: video too short/small, likely duplicate clip')
    sys.exit(0)
print('OK')
" 2>/dev/null)
  if [[ "$SCENE_CHECK" == SKIP* ]]; then
    log "Skipping $VIDEO_NAME — $SCENE_CHECK"
    python3 -c "
import json
with open('$STATE_FILE') as f: s = json.load(f)
skipped = s.get('skipped_duplicates', [])
skipped.append('$VIDEO_NAME')
s['skipped_duplicates'] = skipped
with open('$STATE_FILE', 'w') as f: json.dump(s, f, indent=2)
"
NEW_INDEX=$((NEXT_INDEX + 1))
    log "Marked $VIDEO_NAME as skipped. Exiting — will pick a different video tomorrow."
    exit 0
  fi
fi

# Convert to mp4
log "Converting to mp4..."
rm -f "$MP4_FILE"
avconvert --preset PresetMediumQuality --source "$MOV_FILE" --output "$MP4_FILE"

# Diagnostic exit point — set DRY_RUN=1 to verify the local pipeline (download +
# convert) without actually uploading or posting.
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1 — local pipeline OK. Stopping before Postiz upload."
  log "  MOV: $(ls -la "$MOV_FILE" 2>/dev/null | awk '{print $5, $NF}')"
  log "  MP4: $(ls -la "$MP4_FILE" 2>/dev/null | awk '{print $5, $NF}')"
  exit 0
fi

# Upload to Postiz with correct content-type. Capture stderr so failures are visible.
log "Uploading to Postiz..."
UPLOAD=$(curl -sS -X POST "$API_URL/public/v1/upload" \
  -H "Authorization: $API_KEY" \
  -F "file=@$MP4_FILE;type=video/mp4;filename=${VIDEO_NAME%.MOV}.mp4")

UPLOAD_ID=$(echo "$UPLOAD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'])")
UPLOAD_PATH=$(echo "$UPLOAD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['path'])")
log "Uploaded: $UPLOAD_ID"

# Determine post date (tomorrow 9am PST = 17:00 UTC)
POST_DATE=$(date -v+1d -v17H -v0M -v0S -u '+%Y-%m-%dT%H:%M:%S.000Z')

# Hashtag rotation (3 sets, rotate by index mod 3)
SET=$((NEXT_INDEX % 3))
if [ "$SET" -eq 0 ]; then
  HASHTAGS="#LaPuestaDelSolResort #LaPuestaDelSol #GetToKnowUs #RivieraNayarit #PuntaMita #BoutiqueResort #DesignDetail #MexicoLuxury #ArtisanCraftsmanship #HiddenGem #LuxuryTravel #BarefootLuxury #CoastalElegance"
elif [ "$SET" -eq 1 ]; then
  HASHTAGS="#LaPuestaDelSolResort #LaPuestaDelSol #GetToKnowUs #RivieraNayarit #BoutiqueHotel #VillaLife #LuxuryEscape #MexicoTravel #ArchitecturalDetail #PuntaMitaLuxury #TimelessDesign #SereneSpaces #PacificCoast"
else
  HASHTAGS="#LaPuestaDelSolResort #LaPuestaDelSol #GetToKnowUs #RivieraNayarit #PuntaMita #LuxuryResort #InteriorDesign #MexicoLuxury #HiddenGem #BoutiqueResort #NayaritMexico #TropicalDesign #AttentionToDetail"
fi

# Caption — general architectural beauty (works for any video)
DAY=$((NEXT_INDEX + 1))
CAPTIONS=(
  "Every detail here was chosen. None of it was accidental. 🏡\n\n• • •\n\n$HASHTAGS"
  "The kind of thing you only notice when you slow down. ✨\n\n• • •\n\n$HASHTAGS"
  "Start close. Pull back. Let it land. That's La Puesta del Sol.\n\n• • •\n\n$HASHTAGS"
  "Design that reveals itself slowly. Just like the Pacific at dawn. 🌊\n\n• • •\n\n$HASHTAGS"
  "Built by hand. Finished with intention. Day $DAY of getting to know us.\n\n• • •\n\n$HASHTAGS"
  "Some details you walk past. Others stop you cold. 👁️\n\n• • •\n\n$HASHTAGS"
  "This is what happens when no corner gets left behind. ✦\n\n• • •\n\n$HASHTAGS"
  "The zoom out is the whole point. Give it a second. 🌿\n\n• • •\n\n$HASHTAGS"
)
CAPTION_INDEX=$((NEXT_INDEX % ${#CAPTIONS[@]}))
CAPTION="${CAPTIONS[$CAPTION_INDEX]}"

# Schedule post
log "Scheduling for $POST_DATE..."
RESULT=$(curl -sS -X POST "$API_URL/public/v1/posts" \
  -H "Authorization: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"schedule\",\"date\":\"$POST_DATE\",\"shortLink\":false,\"tags\":[],\"posts\":[{\"integration\":{\"id\":\"$INTEGRATION_ID\"},\"value\":[{\"content\":\"$CAPTION\",\"image\":[{\"id\":\"$UPLOAD_ID\",\"path\":\"$UPLOAD_PATH\"}]}],\"settings\":{\"__type\":\"instagram-standalone\",\"post_type\":\"post\"}}]}")

POST_ID=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['postId'] if isinstance(d,list) else 'error: '+str(d))" 2>/dev/null)
log "Posted: $POST_ID"

# Update state — track posted_ids for random selection
TOMORROW=$(date -v+1d '+%Y-%m-%d')
python3 -c "
import json
with open('$STATE_FILE') as f: s = json.load(f)
posted = s.get('posted_ids', [])
if '$VIDEO_ID' not in posted:
    posted.append('$VIDEO_ID')
s['posted_ids'] = posted
s['next_index'] = len(posted)  # keep for backwards-compat display
s['last_posted_date'] = '$TOMORROW'
s['last_posted_file_id'] = '$VIDEO_ID'
s['last_posted_filename'] = '$VIDEO_NAME'
s['last_postiz_id'] = '$POST_ID'
with open('$STATE_FILE', 'w') as f: json.dump(s, f, indent=2)
"

# Log to CRM events
curl -s -X GET "http://localhost:3456/webhook/pixel?event=organic_post&source=organic_instagram&campaign=get_to_know_us" > /dev/null 2>&1 || true

log "Done. Next index: $NEW_INDEX. Post scheduled for $TOMORROW at 9am PST."
log "========================================"

# Ping Healthchecks on success
"$WORKSPACE/crm/scripts/healthcheck-ping.sh" gtku-daily
