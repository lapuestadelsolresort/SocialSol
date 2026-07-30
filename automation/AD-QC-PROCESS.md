# LPDS Ad Creative Pipeline

## Mandatory for ALL ad creative — no exceptions

Every piece of content (video, image, copy) that touches a live Meta ad MUST pass through all 7 steps. The old process ("find clip → crop → push live") is dead.

---

### Step 1 — Source Selection (Media Library)

Search the indexed media library (`GET /api/media/search`) with the ad brief as query. Use persona filters (`paid_social_conversion`, `organic_social_aspirational`, etc.) plus kind/setting/mood to narrow. Shortlist 3-5 candidates by score, synopsis, and duration.

### Step 2 — Multi-Clip Edit (Story Arc)

Don't use a single raw clip. Cut the best 3-5 second moments from multiple clips into a ~15s sequence:

| Beat | Duration | Purpose | Example |
|------|----------|---------|---------|
| Beat 1 | 3s | Establishing hook — drone/wide, scroll-stopper | Drone aerial of dining deck |
| Beat 2 | 4s | Lifestyle/aspiration — people enjoying | Guests laughing at oceanfront table |
| Beat 3 | 5s | Hero moment — the specific thing the ad sells | Food being placed on table |
| Beat 4 | 3s | Bookend/CTA backdrop — beautiful closer | Drone reveal over ocean |

Each beat: individually extracted, color-graded, concatenated via ffmpeg.

### Step 3 — Color Grade

Apply warm grade for consistency: saturation boost, contrast lift, warm color temperature. Adjust per-clip (drone = already bright; overcast/indoor = more lift). Goal: luxury, aspirational, appetizing.

### Step 4 — Branded 9:16 Template

Run graded sequence through `scripts/ad-templates/branded-vertical.py`:
- Blurred + darkened video fills full 9:16 canvas (NO black bars)
- Sharp 16:9 video centered on top
- Semi-transparent gradient scrims for text legibility
- Headline, subline, LPDS logo, CTA button overlaid
- Configurable per ad — just change text args

### Step 5 — Automated QC (Vision + LP Audit)

**5a. Creative QC** — Extract keyframes at each beat midpoint. Vision model checks:
- [ ] Sharp focus on hero subjects
- [ ] Good composition within crop
- [ ] Color grade consistent across beats
- [ ] Text/logo legible
- [ ] No production equipment, damage, or off-brand elements
- [ ] Coherent story across sequence
- [ ] Meta placement safe zones respected (bottom 250px clear)

**5b. Landing Page QC** — Fetch the ad's destination URL, screenshot it, vision-check:
- [ ] **Message match:** LP headline/copy reinforces what the ad promises
- [ ] **Visual consistency:** LP photos/colors/vibe match the ad creative
- [ ] **CTA continuity:** Next action is clear on LP (book, contact, etc.)
- [ ] **Audience alignment:** LP speaks to the same audience the ad targets
- [ ] **Mobile experience:** LP loads fast, looks good on mobile (90%+ of Meta traffic)
- [ ] **UTM tracking:** UTMs present and correct for CRM attribution

Mismatch = FAIL. Flag it and suggest: change LP destination OR adjust ad creative to match.

**Verdicts:** PASS proceeds to Step 6. FAIL goes back to Step 2/3. No exceptions.

### Step 6 — Human Review (Slack)

Post to #social-sol:
1. The finished video/image
2. Beat breakdown + timing
3. Creative QC verdict
4. **LP screenshot** — full-page capture of where the click lands
5. **LP match assessment** — does the LP deliver on the ad's promise?
6. Recommendation if mismatched (e.g., "link to /amenities instead of homepage")
7. Proposed ad copy + targeting

**Only push to Meta after Jason approves.** No creative touches a live ad without his go-ahead.

### Step 7 — Push to Meta

Upload approved creative via Marketing API → create ad creative → swap into ad → confirm in channel.

---

## Tools

| Tool | Path | Purpose |
|------|------|---------|
| Branded template | `scripts/ad-templates/branded-vertical.py` | 9:16 branded video from any 16:9 clip |
| QC frame extractor | `scripts/ad-creative-qc.sh` | Extract keyframes for vision QC |
| Media library | `GET /api/media/search` | Find source clips |
| Vertical renderer | `media/scripts/render-vertical.js` | 9:16 or 1:1 crops (use branded template instead for ads) |

## Applies To

Every clip in our 223-asset media library. The pipeline makes ALL footage usable for vertical ads — food, rooms, pool, basketball court, drone, wedding, everything.
