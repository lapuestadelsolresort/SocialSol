#!/usr/bin/env python3
"""Build the 4:5 planner-partner retargeting ad creative — v2 with QC fixes."""

from PIL import Image, ImageDraw, ImageFont
import os

# --- Config ---
OUT_W, OUT_H = 1080, 1350  # 4:5 at 1080px wide
HERO_PATH = os.path.join(os.path.dirname(__file__), "planner-hero-245.jpg")
OUT_PATH = os.path.join(os.environ.get("TMPDIR", "/tmp"), "planner-partner-ad-v2.png")

# Colors
CREAM = (250, 245, 235)
DARK_GREEN = (30, 45, 35)
WARM_GOLD = (210, 175, 100)
BRIGHT_GOLD = (225, 190, 115)
AMBER_CTA = (215, 178, 85)
CTA_TEXT = (30, 25, 15)
WHITE = (255, 255, 255)

# Fonts
FONT_DIR = "/System/Library/Fonts/Supplemental"
font_headline = ImageFont.truetype(f"{FONT_DIR}/Georgia Bold.ttf", 54)
font_eyebrow = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 15)
font_body = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 19)
font_cta = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
font_logo = ImageFont.truetype(f"{FONT_DIR}/Georgia Bold.ttf", 17)
font_bullets = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
font_badge = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)

# --- Load & crop hero to 4:5 ---
hero = Image.open(HERO_PATH).convert("RGBA")
hw, hh = hero.size
target_ratio = OUT_W / OUT_H

hero_ratio = hw / hh
if hero_ratio > target_ratio:
    new_w = int(hh * target_ratio)
    left = (hw - new_w) // 2
    hero = hero.crop((left, 0, left + new_w, hh))
else:
    new_h = int(hw / target_ratio)
    top = (hh - new_h) // 2
    hero = hero.crop((0, top, hw, top + new_h))

hero = hero.resize((OUT_W, OUT_H), Image.LANCZOS)

# --- Create canvas ---
canvas = hero.copy()

# --- STRONGER top gradient overlay (taller, more opaque) ---
top_gradient = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
tg_draw = ImageDraw.Draw(top_gradient)
for y in range(350):
    alpha = int(200 * (1 - y / 350) ** 1.3)
    tg_draw.rectangle([(0, y), (OUT_W, y + 1)], fill=(20, 30, 25, alpha))
canvas = Image.alpha_composite(canvas, top_gradient)

# --- MUCH STRONGER bottom gradient (covers bottom 55% for text legibility) ---
bot_overlay = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
bg_draw = ImageDraw.Draw(bot_overlay)
grad_height = 740
grad_start = OUT_H - grad_height
for y in range(grad_height):
    progress = y / grad_height
    alpha = int(230 * progress ** 1.5)
    yy = grad_start + y
    bg_draw.rectangle([(0, yy), (OUT_W, yy + 1)], fill=(18, 30, 24, alpha))
canvas = Image.alpha_composite(canvas, bot_overlay)

draw = ImageDraw.Draw(canvas)

# --- Top: Logo wordmark with subtle backing plate ---
logo_text = "LA PUESTA DEL SOL"
logo_bbox = draw.textbbox((0, 0), logo_text, font=font_logo)
logo_w = logo_bbox[2] - logo_bbox[0]
logo_x = (OUT_W - logo_w) // 2
logo_y = 38
# Subtle dark plate behind logo
draw.rounded_rectangle(
    [(logo_x - 16, logo_y - 6), (logo_x + logo_w + 16, logo_y + 24)],
    radius=4,
    fill=(15, 25, 18, 100),
)
draw.text((logo_x, logo_y), logo_text, fill=BRIGHT_GOLD, font=font_logo)

# --- Eyebrow with backing plate ---
eyebrow_text = "FOR DESTINATION WEDDING & EVENT PLANNERS"
eb_bbox = draw.textbbox((0, 0), eyebrow_text, font=font_eyebrow)
eb_w = eb_bbox[2] - eb_bbox[0]
eb_x = (OUT_W - eb_w) // 2
eb_y = 72
draw.rounded_rectangle(
    [(eb_x - 12, eb_y - 4), (eb_x + eb_w + 12, eb_y + 18)],
    radius=3,
    fill=(15, 25, 18, 80),
)
draw.text((eb_x, eb_y), eyebrow_text, fill=(210, 205, 195), font=font_eyebrow)

# --- Decorative gold line ---
line_y = 102
draw.line([(OUT_W // 2 - 50, line_y), (OUT_W // 2 + 50, line_y)], fill=WARM_GOLD, width=1)

# --- "PARTNER PROGRAM" badge in top-right to signal B2B ---
badge_text = "PARTNER PROGRAM"
bd_bbox = draw.textbbox((0, 0), badge_text, font=font_badge)
bd_w = bd_bbox[2] - bd_bbox[0]
bd_x = OUT_W - bd_w - 40
bd_y = 42
draw.rounded_rectangle(
    [(bd_x - 10, bd_y - 4), (bd_x + bd_w + 10, bd_y + 16)],
    radius=10,
    fill=WARM_GOLD,
)
draw.text((bd_x, bd_y), badge_text, fill=CTA_TEXT, font=font_badge)

# --- Main headline (in the gradient zone) ---
headline_lines = ["A venue partnership", "built around", "your couples."]
y_start = 810
line_spacing = 64

for i, line in enumerate(headline_lines):
    bbox = draw.textbbox((0, 0), line, font=font_headline)
    tw = bbox[2] - bbox[0]
    x = (OUT_W - tw) // 2
    y = y_start + i * line_spacing
    # Text shadow for depth
    draw.text((x + 2, y + 2), line, fill=(0, 0, 0, 120), font=font_headline)
    draw.text((x, y), line, fill=CREAM, font=font_headline)

# --- Proof points with scrim for legibility ---
bullets = [
    "\u2022  10% documented referral commission",
    "\u2022  Hosted site visits & co-marketing support",
    "\u2022  22 bedrooms  \u00b7  Events up to 85 guests",
]

# Semi-transparent scrim behind bullets
scrim_y_start = 1005
scrim_h = 105
scrim = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
scrim_draw = ImageDraw.Draw(scrim)
scrim_draw.rounded_rectangle(
    [(80, scrim_y_start), (OUT_W - 80, scrim_y_start + scrim_h)],
    radius=12,
    fill=(15, 25, 18, 145),  # Increased opacity for stronger legibility
)
canvas = Image.alpha_composite(canvas, scrim)
draw = ImageDraw.Draw(canvas)

bullet_y = 1015
for bullet in bullets:
    bbox = draw.textbbox((0, 0), bullet, font=font_bullets)
    bw = bbox[2] - bbox[0]
    x = (OUT_W - bw) // 2
    draw.text((x + 1, bullet_y + 1), bullet, fill=(0, 0, 0, 80), font=font_bullets)
    draw.text((x, bullet_y), bullet, fill=(235, 230, 220), font=font_bullets)
    bullet_y += 30

# --- CTA Button (larger, more padding) ---
cta_text = "Review the Partner Program"
cta_bbox = draw.textbbox((0, 0), cta_text, font=font_cta)
cta_tw = cta_bbox[2] - cta_bbox[0]
cta_th = cta_bbox[3] - cta_bbox[1]

btn_w = cta_tw + 80
btn_h = cta_th + 36
btn_x = (OUT_W - btn_w) // 2
btn_y = 1070  # Bottom edge at ~1128 = 222px from bottom, safe zone clear

# Button shadow
draw.rounded_rectangle(
    [(btn_x + 2, btn_y + 3), (btn_x + btn_w + 2, btn_y + btn_h + 3)],
    radius=26,
    fill=(0, 0, 0, 60),
)
# Button
draw.rounded_rectangle(
    [(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
    radius=26,
    fill=AMBER_CTA,
)
# Center the text in the button
text_x = btn_x + (btn_w - cta_tw) // 2
text_y = btn_y + (btn_h - cta_th) // 2 - 2
draw.text((text_x, text_y), cta_text, fill=CTA_TEXT, font=font_cta)

# --- NO redundant URL (Meta shows it) ---
# CTA bottom edge is at ~1120 + 58 = 1178. That's 172px from bottom — safe zone clear ✓

# --- Save ---
canvas = canvas.convert("RGB")
canvas.save(OUT_PATH, "PNG", quality=95)
print(f"✅ Saved: {OUT_PATH}")
print(f"   Size: {canvas.size}")
