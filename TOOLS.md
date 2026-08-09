# TOOLS.md - Local Notes

## ⚠️ Media Path Rules (IMPORTANT)

When sending images/files via the `message` tool, you MUST save them to `$TMPDIR/` (NOT `/tmp/`).
Your workspace path (`workspace-resort`) is blocked for outbound media by OpenClaw's security policy.

- ✅ `$TMPDIR/photo.jpg` — works
- ❌ `/tmp/photo.jpg` — blocked (macOS symlink issue)
- ❌ `/Users/jasonmini/.openclaw/workspace-resort/photo.jpg` — blocked (workspace- prefix policy)

Always use `$TMPDIR` for any file you need to send via Slack/message tool.

## Google Drive (gog)

**Setup:** OAuth configured with custom OpenClaw-Gdrive project
- Client: `openclaw`
- Account: `jason@lapuestadelsolresort.com`

**Photo Folders:**
- **Main:** `1yqIlyLBE1O2cm9-1lXNY5jmvyrC-kWP7` (IMG_*.jpeg, videos)
- **Extra Stuff:** `14-f7MY38HSioMgndPjLZIOcJThVT9mbj` (lots of .HEIC files)
- **Shared:** `1nGLJoQa3G3p5kmec3dtUMVFQ9MQQguvy` (HIGH QUALITY professional photos & drone shots!)
- **Shared Photos:** `1-Q6EoBKMh46qZL0w8GOKpU0YiJx6ACyW` (subfolder with more pro shots)
- **Villa Interiors:** `1MZ4xYBuZeBO6T6YVXrWXajKxrZfhLCwq` (room-by-room photos)
- **Food:** `15MS7V8UHLZtOqqMiVawgCPeGf4qOeb3y` (chef-prepared meals, food photos — for food content & SF campaign)
- **Get to Know Us Videos:** `12V5tjbPWkR6G3ZzgekI0oKhxK4MkFCGu` (daily organic series — zoom-out reveal videos of property details)
- **Always search all folders** for topic-based photo selection

**HEIC Support:**
- Automatic conversion: HEIC → JPEG for Instagram
- Command: `sips -s format jpeg input.heic --out output.jpg`

**Common Commands:**
```bash
gog drive ls --client openclaw -a jason@lapuestadelsolresort.com --parent <FOLDER_ID> --max 30
gog drive download <file_id> --client openclaw -a jason@lapuestadelsolresort.com --out $TMPDIR/photo.jpg
```

## Postiz (Instagram Posting)

- API URL: https://api.postiz.com
- Credentials: `~/.openclaw/workspace/secrets/postiz.json`
- Instagram Integration ID: `cmlo3f2rm00auqf0y46u0ojn9`
- Helper script: `~/.openclaw/workspace/postiz-helper.sh`
- See `instagram-post` skill for full workflow

## Meta Marketing API (Facebook/Instagram Paid Ads) — UPDATED 2026-04-30

**Working ad account:** `act_923535223486497` "La Puesta Del Sol" (Business Portfolio `2960110810855584` "La Puesta Del Sol Resort").

⚠️ **IGNORE the legacy `1985761868670101` ad account** — Sol's older MEMORY referenced it as the "working" account, but it actually lives in a different abandoned Business Portfolio that Jason no longer has admin on. Per Jason 2026-04-30: let any active legacy campaigns there expire; do not try to migrate. **All new work goes in `act_923535223486497`.**

**Credentials:** `~/.openclaw/workspace/secrets/meta.json` (mode 600).
- Long-lived System User token (never expires) for "Sol Api" (`61589007004091`)
- App: "La Puesta Marketing Automation" (`1216643303435689`), Live mode
- Page: `979219358611745` "La Puesta Del Sol Resort" (linked to `@lapuestadelsolresort` IG)
- Payment: VISA *9881 on file
- All scopes for ads + Pages + Instagram Graph API (publish, read, manage)

**Common operations:**
```bash
# Load creds
TOKEN=$(jq -r .access_token ~/.openclaw/workspace/secrets/meta.json)
ACT=$(jq -r .ad_account_act ~/.openclaw/workspace/secrets/meta.json)
PAGE=$(jq -r .page_id ~/.openclaw/workspace/secrets/meta.json)
G=https://graph.facebook.com/v21.0

# List campaigns
curl -s "$G/$ACT/campaigns?fields=id,name,status,daily_budget,objective&access_token=$TOKEN" | jq

# Create paused campaign
curl -s -X POST "$G/$ACT/campaigns" \
  -d "name=My Campaign" -d "objective=OUTCOME_TRAFFIC" -d "status=PAUSED" \
  -d "special_ad_categories=[]" -d "is_adset_budget_sharing_enabled=false" \
  -d "access_token=$TOKEN"

# Create creative referencing the Page
curl -s -X POST "$G/$ACT/adcreatives" \
  -d "name=My Creative" \
  -d "object_story_spec={\"page_id\":\"$PAGE\",\"link_data\":{\"link\":\"https://lapuestadelsolresort.com\",\"message\":\"Caption text\"}}" \
  -d "access_token=$TOKEN"

# Pull insights for an ad account (last 7 days)
curl -s "$G/$ACT/insights?fields=spend,impressions,clicks,ctr,cpc&date_preset=last_7d&access_token=$TOKEN" | jq

# Pause/delete a campaign
curl -s -X POST "$G/<CAMPAIGN_ID>" -d "status=PAUSED" -d "access_token=$TOKEN"
curl -s -X DELETE "$G/<CAMPAIGN_ID>?access_token=$TOKEN"
```

**Hard rule before any campaign goes LIVE:** use the brief-driven control path below. It creates the campaign paused, reads targeting back from Meta, and refuses activation until Jason's real Slack reply resolves in `#social-sol`. A hand-written approval block is not evidence.

```bash
# Preview and provision safely (campaign paused; children configured active)
PYTHONPATH=automation python3 automation/meta_campaign_control.py plan \
  --brief campaigns/<brief>.json
PYTHONPATH=automation python3 automation/meta_campaign_control.py provision \
  --brief campaigns/<brief>.json --apply

# Bind the posted request and then record Jason's thread reply
PYTHONPATH=automation python3 automation/campaign_approval.py bind-request \
  --brief-id <brief-id> --request-ts <request-ts> --apply
PYTHONPATH=automation python3 automation/campaign_approval.py record \
  --brief-id <brief-id> --slack-ts <reply-ts> --apply

# Re-resolves the Slack message, rechecks all live configuration, activates the
# replacement, and pauses the old campaign only after every child reads ACTIVE.
PYTHONPATH=automation python3 automation/meta_campaign_control.py activate \
  --brief campaigns/<brief>.json --apply
```

Run `automation/planner_audience_sync.py` for planner pixel-rule changes and
`automation/planner_audience_health.py` for the paid-session quarantine/readiness
report. All mutation commands require `--apply`; dry-run/read-back is the default.

**Meta CAPI boundary and recovery:** verified WhatsApp leads are eligible only
when their source, medium, and campaign resolve to a configured paid Meta UTM in
`campaigns/active-campaigns.json`. Paulina/email, organic, direct, unknown, and
unattributed leads are never sent to Meta.

```bash
# Inspect retryable failures without changing Meta or the CRM
node crm/scripts/retry-meta-capi.js --dry-run

# Replay one audited failure with its original id and event time
node crm/scripts/retry-meta-capi.js --event-id <twilio-event-id>
```

`com.lapuestadelsolresort.meta-capi-retry` retries recent failures every 15
minutes. `scripts/tracking-health-check.py` fails closed while a Meta CAPI
delivery is failed or has remained pending for more than 15 minutes.

**Browser automation for Meta is no longer needed.** Sol can do the full ad lifecycle (create/edit/pause/delete + read insights) via the API now.

## Channel Responsibilities (IMPORTANT)

All channels share the same CRM (`crm/data/crm.db`). Each has a distinct job:

| Channel | ID | Owns |
|---|---|---|
| #prospector-paulina | `C0B16LEC19B` | New lead generation, warmup, outbound sends, contact acquisition, `!` commands |
| #reengager-regina | (see Project_Status.md) | Past-guest re-engagement (Regina agent), dossier-based drafts, Sarah sends manually |
| #business-intel | `C0B384L2TNC` | Ops summaries, Spanish translation, ad approvals, business monitoring |
| #social-sol | `C0AF8A8R4H2` | Organic IG posts, paid Meta campaigns |
| #sarah-coach | (see Project_Status.md) | Inbound reply drafting in Sarah's voice |

Paulina's campaign pause state, send caps, email replies, and Slack workflow
cannot change Meta campaign status or budget. Paid campaign control lives only
in the brief/registry Meta automation. Shared CRM records are separated by
exact UTM values: Paulina uses `paulina/email`; paid Meta uses registered
Meta/Facebook/Instagram paid-source combinations.

**When Jason asks about lead status in either channel: query the CRM first. Give the answer directly. Do not say "let me dig deeper."**

## CRM Quick Reference

**DB:** `crm/data/crm.db`
**API:** `http://localhost:3456`
**Dashboard:** `http://localhost:3456` (always running)

**Key tables:**
- `contacts` — all people (status: new → queued → contacted → replied → converted → dead)
- `outreach_sends` — all outbound emails sent (links to contacts)
- `leads` — inquiry/booking leads from website/Airbnb
- `processed_gmail_replies` — inbound replies detected by gmail-reply-forwarder

**Useful queries:**
```bash
# Active warm leads (in conversation)
sqlite3 ~/crm/data/crm.db "SELECT name, email, company, status, notes FROM contacts WHERE status='contacted' ORDER BY updated_at DESC;"

# New inbound leads
sqlite3 ~/crm/data/crm.db "SELECT name, email, source, created_at, notes FROM leads WHERE status='new' ORDER BY created_at DESC LIMIT 20;"

# Reply activity
sqlite3 ~/crm/data/crm.db "SELECT c.name, c.email, os.reply_detected_at FROM outreach_sends os JOIN contacts c ON c.id=os.contact_id WHERE os.reply_detected_at IS NOT NULL ORDER BY os.reply_detected_at DESC;"
```

## Media Library — `/api/media/search`

Searchable index of Sarah-drive footage + Google Drive photos. Use this when you need a clip or still for a post, outreach, or campaign. **You call this directly** — natural-language query in, ranked JSON out. Same pattern as Voice Service. No `!`-command, no human in the loop.

**Endpoint:** `GET http://localhost:3456/api/media/search`

**Query params:**

| Param | Required | Notes |
|---|---|---|
| `q` | yes | Natural-language query, e.g. `"intimate sunset over the villa"` |
| `persona` | recommended | One of: `wedding_planner_outreach`, `corporate_retreat_outreach`, `past_guest_reactivation`, `organic_social_aspirational`, `paid_social_conversion`, `landing_page_hero`. Blends semantic score (0.7) with that persona's fit weight (0.3). |
| `kind` | optional | `video`, `audio`, `photo` |
| `setting` | optional | `villa`, `beach`, `pool`, `palapa`, `ceremony_arch`, `interior_room`, `kitchen`, `aerial`, `entrance`, `grounds`, `dining_setup`, `bar`, `sunset_view`, `pathway`, `garden` |
| `mood` | optional | `serene`, `celebratory`, `intimate`, `dramatic`, `casual`, `professional`, `golden_hour`, `night` |
| `source_role` | optional | `a_cam`, `b_cam`, `drone`, `audio_home`, `audio_host`, `gdrive_photo` (lowercase in the DB) |
| `min_duration_ms`, `max_duration_ms` | optional | Integers; useful for Reel-length clips (e.g. 3000–15000) |
| `limit` | optional | Default 10, max 50 |

**Example calls:**
```
GET /api/media/search?q=drone+reveal+at+sunset&persona=organic_social_aspirational&kind=video&min_duration_ms=3000&max_duration_ms=15000&limit=3
GET /api/media/search?q=wedding+ceremony+arch+golden+hour&persona=wedding_planner_outreach&limit=3
GET /api/media/search?q=intimate+couple+beach&persona=past_guest_reactivation&setting=beach&mood=intimate
```

**Response shape (array, ranked):**
```json
[{
  "asset_id": 142,
  "shoot": "2025-10-28-property",
  "kind": "video",
  "source_role": "drone",
  "filename": "DJI_0042.MP4",
  "duration_ms": 8400,
  "synopsis": "Slow aerial orbit revealing the villa from the south at golden hour…",
  "tags": { "setting": ["villa","aerial"], "mood": ["serene","golden_hour"], "camera_motion": ["aerial_orbit"] },
  "persona_fit": { "wedding_planner_outreach": 0.82, "organic_social_aspirational": 0.91, ... },
  "score": 0.8731, "semantic_score": 0.8412, "persona_score": 0.91,
  "proxy_url": "/api/media/proxy/142",
  "thumb_url": "/api/media/thumb/142/0",
  "waveform_url": null
}]
```

**To use an asset:**
- `GET /api/media/proxy/<asset_id>` — streams the 720p MP4 (or the photo itself for `kind=photo`). For Slack/IG, download to `$TMPDIR/clip.mp4` first (workspace path is blocked, see Media Path Rules at top).
- `GET /api/media/thumb/<asset_id>/0` — first keyframe JPEG (use for IG/Slack previews).
- `GET /api/media/asset/<asset_id>` — full record: every keyframe caption, transcript (if audio/video), persona_fit breakdown. Pull this before committing to an asset when you want detail.

**Health:** `GET /api/media/health` → counts by status, synopsis/transcript/caption totals. Run if a search returns empty unexpectedly.

**Browse/audit:** `GET /api/media/list?limit=500&offset=0[&kind=][&source_role=]` — flat paged listing of every asset (no semantic ranking). Use when you need the full inventory rather than a ranked answer.

**All endpoints localhost-only (403 otherwise).**

### IG-ready renditions (9:16 / 1:1)

Proxies are 720p **landscape** — never post them to IG directly. Render a vertical (Reels/Stories) or square (feed) cut from the 4K original first:

```bash
cd ~/.openclaw/workspace-resort/media
node scripts/render-vertical.js --asset-id=<id> [--aspect=9x16|1x1] [--crop-x=0..1]
```

- `--crop-x` positions the crop window horizontally (0=left, 0.5=center, 1=right). Check the keyframe thumb first; off-center subjects need an off-center crop.
- Renders from the 4K originals in `media/originals/` on this machine (no external drive needed).
- Output lands in `media/renditions/<shoot>/<id>-<aspect>.mp4` and is served at `GET /api/media/rendition/<asset_id>/<aspect>` (e.g. `/api/media/rendition/8/9x16`).
- Idempotent — re-running overwrites. Renditions are recorded in `media_assets.renditions_json` and appear in `/api/media/list` output.

### IG campaign workflow (media selection)

For any IG campaign brief in #social-sol, source media from the library — not just the Google Drive rotation folders above:

1. **Search** with the campaign's brief as `q`, plus `persona=organic_social_aspirational` (organic) or `paid_social_conversion` (paid). For Reels, constrain `kind=video&min_duration_ms=3000&max_duration_ms=30000`.
2. **Shortlist** 3–5 results into the channel: post each asset's thumb (download `GET /api/media/thumb/<id>/0` to `$TMPDIR/`) with its asset_id, one-line synopsis, and duration. Wait for Jason's pick before rendering/posting.
3. **Render** the pick vertically: `node scripts/render-vertical.js --asset-id=<id>` (see above).
4. **Stage + post**: copy the rendition (or the photo) to `$TMPDIR/`, then post via the same Postiz path the organic rotation uses.

The `auto-organic-ig-post` Google Drive rotation is unchanged and keeps running as the baseline cadence; this workflow is for campaign-specific content on top of it.

## Prospector Paulina (#prospector-paulina)

**Channel ID:** `C0B16LEC19B`

**Commands:** When you receive a message in `#prospector-paulina` starting with `!`, read `prospector/COMMANDS.md` and `prospector/config.json` for the full spec. Summary:

| Pattern | Effect |
|---|---|
| `!add-contact email; Name; Company; notes` | POST `/api/contacts` with source=manual_slack, context_source=manual_jason_pv_list |
| `!dnc email [reason]` | POST `/api/suppressions`, default reason=manual |
| `!pause` | Set `prospector/state.json` paused=true |
| `!resume` | Set `prospector/state.json` paused=false |

**Authorization:** Only Jason (`U05EVK2GV5X`) and Sarah (`U07QDFJUVA8`). Reject anyone else with "❌ Not authorized".

**Channel restriction:** These commands work ONLY in `#prospector-paulina`. Ignore `!` commands in other channels.

**Approval reactions:** When you post a draft outreach email in this channel, a ✅ reaction from an allowed approver means "send it." Any other reaction or no reaction means do not send. The approver list is the same: Jason and Sarah only.

**Config:** `prospector/config.json` has sender identity, physical address, daily send caps, and the allowed approver list.

**State:** `prospector/state.json` — check `paused` before any compose or send cycle. If true, skip and log.
