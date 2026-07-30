#!/usr/bin/env python3
"""
branded-vertical.py — Compose a branded 9:16 vertical ad from any 16:9 clip.

Creates a 1080x1920 video with:
  - Dark branded canvas
  - Headline + subline text (top)
  - Video window preserving full 16:9 (no crop)
  - Gold accent divider
  - Logo + CTA (bottom)
  - Optional warm color grade

Usage:
  python3 branded-vertical.py \
    --input <video> \
    --headline "Your headline" \
    [--subline "Subline text"] \
    [--cta "lapuestadelsolresort.com"] \
    [--warm] [--duration 15] \
    [--output <path>]
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("ERROR: Pillow required. pip3 install Pillow", file=sys.stderr)
    sys.exit(1)

# --- CONSTANTS ---
CANVAS_W, CANVAS_H = 1080, 1920
VIDEO_W, VIDEO_H = 1080, 608  # 16:9 at 1080 wide (proper ratio)
VIDEO_Y = 440  # Vertically centered-ish, leaving room for headline above and CTA below

BG_COLOR = (13, 13, 13)  # near-black
ACCENT_COLOR = (212, 168, 83)  # warm gold
TEXT_COLOR = (255, 255, 255)
TEXT_DIM = (255, 255, 255, 178)  # 70% opacity white

LOGO_PATH = Path(__file__).parent.parent.parent / "media" / "brand" / "lpds-logo.png"
SCRIPT_DIR = Path(__file__).parent

def find_font(size, bold=False):
    """Find a good system font on macOS."""
    candidates = [
        "/System/Library/Fonts/Supplemental/Avenir Next.ttc",
        "/System/Library/Fonts/Supplemental/AvenirNext-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText.ttf",
    ]
    if bold:
        candidates = [
            "/System/Library/Fonts/Supplemental/Avenir Next Bold.ttf",
            "/System/Library/Fonts/Supplemental/AvenirNext-Bold.ttf",
        ] + candidates

    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

def create_overlay(headline, subline="", cta="lapuestadelsolresort.com", logo_path=None):
    """Create the branded overlay PNG with transparent video window."""
    # Transparent canvas — the blurred video shows through
    img = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Semi-transparent dark scrims for text legibility (top and bottom)
    # Lighter scrims so blur shows through more
    # Top scrim: gradient from semi-dark to transparent
    for y in range(VIDEO_Y):
        alpha = int(140 * (1 - (y / VIDEO_Y) ** 0.6))  # Softer curve, lower max
        draw.rectangle([(0, y), (CANVAS_W, y + 1)], fill=(0, 0, 0, alpha))
    # Bottom scrim: gradient from transparent to semi-dark
    bottom_start = VIDEO_Y + VIDEO_H
    bottom_range = CANVAS_H - bottom_start
    for y in range(bottom_start, CANVAS_H):
        progress = (y - bottom_start) / bottom_range
        alpha = int(140 * (progress ** 0.6))  # Softer curve, matching top
        draw.rectangle([(0, y), (CANVAS_W, y + 1)], fill=(0, 0, 0, alpha))

    # --- HEADLINE ---
    font_headline = find_font(52, bold=True)
    font_subline = find_font(28)
    font_cta = find_font(26)

    # Center headline — positioned tight above video
    bbox = draw.textbbox((0, 0), headline, font=font_headline)
    tw = bbox[2] - bbox[0]
    headline_y = 60

    # Handle long headlines - wrap if needed
    if tw > CANVAS_W - 80:
        words = headline.split()
        lines = []
        current = ""
        for word in words:
            test = f"{current} {word}".strip()
            bbox_test = draw.textbbox((0, 0), test, font=font_headline)
            if bbox_test[2] - bbox_test[0] > CANVAS_W - 80:
                if current:
                    lines.append(current)
                current = word
            else:
                current = test
        if current:
            lines.append(current)

        y_pos = headline_y
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font_headline)
            tw = bbox[2] - bbox[0]
            draw.text(((CANVAS_W - tw) // 2, y_pos), line, fill=TEXT_COLOR, font=font_headline)
            y_pos += 62
    else:
        draw.text(((CANVAS_W - tw) // 2, headline_y), headline, fill=TEXT_COLOR, font=font_headline)

    # --- SUBLINE ---
    if subline:
        bbox = draw.textbbox((0, 0), subline, font=font_subline)
        tw = bbox[2] - bbox[0]
        draw.text(((CANVAS_W - tw) // 2, 160), subline, fill=TEXT_DIM, font=font_subline)

    # Video window area is already transparent (no need to cut out)

    # --- ACCENT LINE ---
    accent_y = VIDEO_Y + VIDEO_H + 6
    draw.rectangle([(0, accent_y), (CANVAS_W, accent_y + 3)], fill=(*ACCENT_COLOR, 255))

    # --- LOGO --- (positioned above Meta safe zone; bottom 250px is UI chrome)
    if logo_path and os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        # Scale logo to ~280px wide
        ratio = 280 / logo.width
        logo = logo.resize((280, int(logo.height * ratio)), Image.LANCZOS)
        logo_x = (CANVAS_W - logo.width) // 2
        logo_y = accent_y + 80
        img.paste(logo, (logo_x, logo_y), logo)

    # --- CTA BUTTON ---
    cta_font = find_font(30, bold=True)
    bbox = draw.textbbox((0, 0), cta, font=cta_font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    btn_w = tw + 80
    btn_h = th + 30
    btn_x = (CANVAS_W - btn_w) // 2
    btn_y = accent_y + 170
    # Draw button outline
    draw.rounded_rectangle([(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
                          radius=8, outline=(*ACCENT_COLOR, 255), width=2)
    draw.text(((CANVAS_W - tw) // 2, btn_y + 12), cta, fill=(*ACCENT_COLOR, 255), font=cta_font)

    # --- URL below button ---
    url_font = find_font(22)
    url = "lapuestadelsolresort.com"
    bbox = draw.textbbox((0, 0), url, font=url_font)
    tw = bbox[2] - bbox[0]
    draw.text(((CANVAS_W - tw) // 2, btn_y + btn_h + 20), url, fill=TEXT_DIM, font=url_font)

    return img


def build_video(input_path, overlay_path, output_path, warm=False, duration=None):
    """Composite the video into the branded template using ffmpeg.

    Approach: blurred background fill + sharp center video + overlay.
    The source video is used twice:
      1. Scaled up to fill 9:16, heavily blurred + darkened (background)
      2. Scaled to 1080x608 (sharp, centered)
    Then the branded text/logo overlay goes on top.
    """

    # Color grade chain
    grade = ""
    if warm:
        grade = "eq=saturation=1.3:contrast=1.06:brightness=0.03:gamma=1.08,"

    # Complex filter:
    # [0:v] split → bg (blurred fill) + fg (sharp center)
    # [1:v] = overlay PNG with text/logo
    filter_complex = (
        # Split input into two streams
        f"[0:v]split=2[bg_src][fg_src];"
        # Background: scale height to fill 1920, then crop width to 1080. Blur + darken.
        f"[bg_src]{grade}scale=-1:{CANVAS_H}:force_original_aspect_ratio=increase,"
        f"crop={CANVAS_W}:{CANVAS_H}:(iw-{CANVAS_W})/2:0,"
        f"gblur=sigma=40,"
        f"eq=brightness=-0.2:contrast=0.75[bg];"
        # Foreground: sharp video at proper 16:9 (1080x608), with color grade
        f"[fg_src]{grade}scale={VIDEO_W}:{VIDEO_H}:force_original_aspect_ratio=decrease,"
        f"setsar=1[vid];"
        # Composite: bg → sharp vid centered → text/logo overlay
        f"[bg][vid]overlay=({CANVAS_W}-w)/2:{VIDEO_Y}[withvid];"
        f"[1:v]scale={CANVAS_W}:{CANVAS_H}[ovr];"
        f"[withvid][ovr]overlay=0:0:format=auto[out]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-i", overlay_path,
        "-filter_complex", filter_complex,
        "-map", "[out]", "-map", "0:a?",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
    ]

    if duration:
        cmd.extend(["-t", str(duration)])

    cmd.append(output_path)

    print(f"[render] Compositing branded vertical...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR: ffmpeg failed:\n{result.stderr[-500:]}", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"[render] → {output_path} ({size_mb:.1f} MB)")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Create branded 9:16 vertical ad")
    parser.add_argument("--input", required=True, help="Source video path")
    parser.add_argument("--headline", required=True, help="Headline text")
    parser.add_argument("--subline", default="", help="Subline text")
    parser.add_argument("--cta", default="lapuestadelsolresort.com", help="CTA text")
    parser.add_argument("--output", default="", help="Output path")
    parser.add_argument("--logo", default=str(LOGO_PATH), help="Logo PNG path")
    parser.add_argument("--warm", action="store_true", help="Apply warm color grade")
    parser.add_argument("--duration", type=int, default=None, help="Max duration (seconds)")

    args = parser.parse_args()

    if not args.output:
        basename = Path(args.input).stem
        args.output = str(Path(__file__).parent.parent.parent / "media" / "renditions" / "branded" / f"{basename}-branded-9x16.mp4")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    # Step 1: Create overlay
    print(f"[template] Creating branded overlay...")
    overlay = create_overlay(args.headline, args.subline, args.cta, args.logo)

    overlay_path = os.path.join(tempfile.gettempdir(), "lpds-overlay.png")
    overlay.save(overlay_path)
    print(f"[template] Overlay saved: {overlay_path}")

    # Step 2: Composite
    build_video(args.input, overlay_path, args.output, warm=args.warm, duration=args.duration)

    print(f"\n✅ Done: {args.output}")


if __name__ == "__main__":
    main()
