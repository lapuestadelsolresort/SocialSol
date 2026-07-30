#!/usr/bin/env bash
# branded-vertical.sh — Compose a branded 9:16 vertical ad from any 16:9 clip
#
# Usage:
#   ./scripts/ad-templates/branded-vertical.sh \
#     --input <video_path> \
#     --headline "Your headline here" \
#     [--subline "Optional subline"] \
#     [--cta "Book Now →"] \
#     [--output <output_path>] \
#     [--logo <logo_path>] \
#     [--bg-color "#1a1a1a"] \
#     [--accent-color "#d4a853"] \
#     [--warm] \
#     [--duration <seconds>]
#
# Creates a 1080x1920 (9:16) video with:
#   - Branded header area with headline text
#   - Video playing in a window (16:9 preserved, no crop loss)
#   - Logo + CTA in footer
#   - Optional warm color grade

set -euo pipefail

# Defaults
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
LOGO="${SOCIALSOL_LOGO:-${REPO_ROOT}/media/brand/lpds-logo.png}"
BG_COLOR="#0d0d0d"
ACCENT="#d4a853"
TEXT_COLOR="#ffffff"
HEADLINE=""
SUBLINE=""
CTA="lapuestadelsolresort.com"
INPUT=""
OUTPUT=""
WARM=false
DURATION=""
FONT="/System/Library/Fonts/Supplemental/Avenir Next.ttc"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --headline) HEADLINE="$2"; shift 2 ;;
    --subline) SUBLINE="$2"; shift 2 ;;
    --cta) CTA="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --logo) LOGO="$2"; shift 2 ;;
    --bg-color) BG_COLOR="$2"; shift 2 ;;
    --accent-color) ACCENT="$2"; shift 2 ;;
    --warm) WARM=true; shift ;;
    --duration) DURATION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$INPUT" ]]; then
  echo "ERROR: --input is required" >&2
  exit 1
fi

if [[ -z "$HEADLINE" ]]; then
  echo "ERROR: --headline is required" >&2
  exit 1
fi

# Auto-generate output path
if [[ -z "$OUTPUT" ]]; then
  BASENAME=$(basename "$INPUT" | sed 's/\.[^.]*$//')
  OUTPUT="${REPO_ROOT}/media/renditions/branded/${BASENAME}-branded-9x16.mp4"
fi

mkdir -p "$(dirname "$OUTPUT")"

# Canvas: 1080x1920
# Layout:
#   0-280:    Header (headline + subline)
#   280-888:  Video window (1080x608 = 16:9 at 1080 wide)
#   888-960:  Accent line
#   960-1680: Padding / secondary content area
#   1680-1920: Footer (logo + CTA)
#
# Adjusted layout for more visual impact:
#   0-100:    Top padding
#   100-320:  Headline area
#   320-928:  Video window (1080x608)
#   928-960:  Accent divider
#   960-1600: Breathing room
#   1600-1920: Logo + CTA footer

# Build the video filter chain
VF_CHAIN=""

# Optional warm grade on the input video
if [[ "$WARM" == "true" ]]; then
  VF_CHAIN="eq=saturation=1.2:contrast=1.05:brightness=0.02,colortemperature=temperature=4500,"
fi

# Scale input to fit 1080 wide, maintaining 16:9
VF_CHAIN="${VF_CHAIN}scale=1080:608:force_original_aspect_ratio=decrease,pad=1080:608:(ow-iw)/2:(oh-ih)/2:color=${BG_COLOR}"

# Duration flag
DUR_FLAG=""
if [[ -n "$DURATION" ]]; then
  DUR_FLAG="-t $DURATION"
fi

# Build the complex filter
# We need to:
# 1. Create the background canvas
# 2. Overlay the video
# 3. Add text (headline, subline, CTA)
# 4. Add logo
# 5. Add accent line

FILTER="
[0:v]${VF_CHAIN}[vid];
color=c=${BG_COLOR}:s=1080x1920:d=999[bg];
[bg][vid]overlay=0:320[withvid];
color=c=${ACCENT}:s=1080x3:d=999[line];
[withvid][line]overlay=0:930[withline];
[1:v]scale=280:-1[logo_scaled];
[withline][logo_scaled]overlay=(W-w)/2:1700[withlogo];
[withlogo]drawtext=text='${HEADLINE}':fontfile='${FONT}':fontsize=48:fontcolor=${TEXT_COLOR}:x=(w-text_w)/2:y=160:line_spacing=8"

# Add subline if provided
if [[ -n "$SUBLINE" ]]; then
  FILTER="${FILTER},drawtext=text='${SUBLINE}':fontfile='${FONT}':fontsize=28:fontcolor=${TEXT_COLOR}@0.7:x=(w-text_w)/2:y=230"
fi

# Add CTA
FILTER="${FILTER},drawtext=text='${CTA}':fontfile='${FONT}':fontsize=24:fontcolor=${ACCENT}:x=(w-text_w)/2:y=1870"

# Run ffmpeg
ffmpeg -y \
  -i "$INPUT" \
  -i "$LOGO" \
  -filter_complex "${FILTER}[out]" \
  -map "[out]" -map 0:a? \
  -c:v libx264 -crf 18 -preset medium \
  -c:a aac -b:a 128k \
  -pix_fmt yuv420p \
  -movflags +faststart \
  $DUR_FLAG \
  "$OUTPUT" 2>&1

echo ""
echo "=== OUTPUT ==="
echo "File: $OUTPUT"
echo "Size: $(du -h "$OUTPUT" | cut -f1)"
