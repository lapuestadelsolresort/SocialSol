#!/usr/bin/env bash
# ad-creative-qc.sh — QC gate for ad creative before pushing to Meta
set -euo pipefail

INPUT="${1:?Usage: ad-creative-qc.sh <video_or_image_path> <output_dir>}"
OUTDIR="${2:?Usage: ad-creative-qc.sh <video_or_image_path> <output_dir>}"

mkdir -p "$OUTDIR"

MIME=$(file --brief --mime-type "$INPUT")

if [[ "$MIME" == video/* ]]; then
    DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT" | cut -d. -f1)
    INTERVAL=$((DURATION / 6))
    for i in 1 2 3 4 5; do
        TS=$((INTERVAL * i))
        ffmpeg -y -ss "$TS" -i "$INPUT" -frames:v 1 "$OUTDIR/qc-frame-${i}-${TS}s.jpg" 2>/dev/null
    done
    ffmpeg -y -ss 0.5 -i "$INPUT" -frames:v 1 "$OUTDIR/qc-frame-first.jpg" 2>/dev/null
    ffmpeg -y -sseof -1 -i "$INPUT" -frames:v 1 "$OUTDIR/qc-frame-last.jpg" 2>/dev/null
    echo "QC_TYPE=video"
    echo "QC_DURATION=${DURATION}s"
elif [[ "$MIME" == image/* ]]; then
    cp "$INPUT" "$OUTDIR/qc-frame-hero.jpg"
    echo "QC_TYPE=image"
else
    echo "ERROR: Unsupported MIME type: $MIME" >&2
    exit 1
fi

echo "QC_FRAMES=$OUTDIR/qc-frame-*.jpg"
echo "QC_STATUS=ready_for_review"
