# MEMORY.md - Sol's Long-Term Memory

## Identity
- **Name:** Sol ☀️
- **Role:** Orchestrator agent for La Puesta del Sol Resort's AI operations platform
- **System map:** `README.md` is the canonical infrastructure reference (agents, integrations, automations)
- **Scope:** Marketing & guest conversion, property operations, finance & admin support
- **Channels:**
  - `#prospector-paulina` (`C0B16LEC19B`) — outbound prospecting (Paulina), warmup, new lead generation, `!` commands
  - `#reengager-regina` — past-guest re-engagement (Regina), fully agent-driven auto-send via Resend (R8, 2026-07-30)
  - `#business-intel` (`C0B384L2TNC`) — ops summaries, Spanish translation, Meta ad approvals, business monitoring
  - `#social-sol` (`C0AF8A8R4H2`) — Instagram content + paid Meta ads + WhatsApp DM bridge
  - `#sarah-coach` — inbound reply drafting in Sarah's voice
  - `#accounting` (`C05UMKNHEDC`) — QuickBooks Online integration, expense tracking, financial data
  - `#george-expenses` (`C0BNH8AJJMT`) — George Starkey out-of-pocket expenses → auto-post to QBO liability account
  - All channels share the same CRM (`crm/data/crm.db`)
- **Lead status rule:** When Jason asks about leads, query the CRM directly first. Never make him ask twice.
- **HARD RULE — No "want me to look into it?" on broken data:** When any metric looks broken (0% rates, missing events, ratio anomalies, zero conversions with real traffic), investigate IMMEDIATELY and report findings. Do not ask permission to check the obvious. Jason should never have to tell you to do what's clearly the next step. Act first, report what you found.
- **QC channel:** `#qc-infra` (`C0B1JA6BDRP`) — infrastructure integrity tests, tracking health checks, weekly audits. All automated QC results post here.

## Active Warm Leads (updated 2026-05-20)
- **Tara Ashby** (tara@thecharterco.com) — The Charter Co, B2B investor retreat inquiry. Call scheduled Tue May 26 9am PDT. High priority.
- **Liang Wang** (liang.wang@disney.com) — Disney, 40th birthday group booking June 23-27 2027. Contract sent. Close to confirmed.
- **Mohab Kellini + Nicole Rizkala** (mbzak26@gmail.com / nicolerizkala@gmail.com) — Full resort wedding via Airbnb. Deep in planning with Sarah & Daniel + wedding coordinator Siomara. Close to booking.
- **Jessa Ray** (jessaraymuse@gmail.com) — Wellness/fitness retreat via Airbnb. Dates being held. Active conversation.
- **Colton Black** (colton.black63@gmail.com) — Past guest, post-stay follow-up resolved. Potential repeat.

## Meta Ads (Facebook/Instagram) — UPDATED 2026-04-30, supersedes prior entries

**THE WORKING AD ACCOUNT IS NOW:** `act_923535223486497` ("La Puesta Del Sol", in Business Portfolio `2960110810855584` "La Puesta Del Sol Resort").

⚠️ **IGNORE the old `1985761868670101` ad account.** Earlier MEMORY entries called it "the working one" — that was wrong. It lives in a different abandoned Business Portfolio that Jason no longer admins, and is unreachable via API. Any prior campaign IDs/spend/insights tied to it are now historical only. Do NOT try to query, manage, or report on it. Don't try the legacy `1444885340338467` either.

⚠️ **The "info@lapuestadelsolresort.com" login does not exist as an FB account.** Earlier MEMORY claimed Sol drove Ads Manager via that login. That was wrong (no FB account is registered to that email). Browser automation for Meta Ads is no longer used at all.

**Current setup (verified 2026-04-30):**
- App: "La Puesta Marketing Automation" (`1216643303435689`), Live mode
- Business Portfolio: `2960110810855584` "La Puesta Del Sol Resort" (admin: Jason Starkey personal FB)
- Ad account: `act_923535223486497` "La Puesta Del Sol", USD, America/Los_Angeles, payment VISA *9881 on file
- Page: `979219358611745` "La Puesta Del Sol Resort", connected to IG `@lapuestadelsolresort` (full control)
- Token: long-lived **System User** token (System User "Sol Api", `61589007004091`, Admin role) — never expires
- Credentials file: `~/.openclaw/workspace/secrets/meta.json` (mode 600). Has all 34 scopes for ads + Pages + IG Graph API.

**Ad creation method:** Direct Marketing API via the System User token. See `workspace-resort/TOOLS.md` for curl recipes. Do NOT use browser automation — the openclaw browser profile is no longer load-bearing for paid ads.

**Hard rule before any LIVE paid spend:** post the proposed campaign (budget + targeting + creative + objective) to `#social-sol` for Jason's approval. Only flip status from PAUSED → ACTIVE after he confirms. Never publish unconfirmed paid spend.

## Instagram Organic (Postiz)
- Integration ID: cmlo3f2rm00auqf0y46u0ojn9
- Helper script: ~/.openclaw/workspace/postiz-helper.sh
- Free tier: 30 posts/month

## Media Library — added 2026-07-25, originals now LOCAL
- The entire Oct 28 2025 property shoot is indexed and searchable: 223 assets (drone, A-cam, B-cam, wedding photos) with vision captions + embeddings, served at `localhost:3456/api/media/search`. **This is the preferred source for IG campaign media** — full workflow in `TOOLS.md` ("IG campaign workflow").
- **The 4K originals live on this Mac mini** at `media/originals/2025-10-28-property/` (migrated + checksum-verified 2026-07-25). The external "Sarah" drive is unplugged and kept as offline backup — nothing operational needs it.
- Verticals for IG: `media/scripts/render-vertical.js` renders 9:16/1:1 from the 4K originals; served at `/api/media/rendition/<id>/<aspect>`.
- New footage dropped into the originals tree (same A_CAM/B_CAM/DRONE/AUDIO layout) is picked up by a weekly Monday 07:45 rescan (`media/scripts/rescan-sarah.sh` LaunchAgent); embeddings land via the daily 08:20 indexer. Renamed files are auto-reconciled by size match.
- 5 DJI-named drone clips were excluded per Jason (status='excluded', not searchable, only on the backup drive). The 11 descriptive-named drone clips (adventure_experience, dining, hammock, …) are the curated set.
- ~38 B/A-cam night clips are underexposed junk — their captions say so, search ranks them low. Audio (23 RØDE interview WAVs) is transcribed but not searchable by design.
- The `auto-organic-ig-post` Google Drive rotation is separate and unchanged.

## Google Drive Photo Folders
- Main: 1yqIlyLBE1O2cm9-1lXNY5jmvyrC-kWP7
- Extra Stuff: 14-f7MY38HSioMgndPjLZIOcJThVT9mbj
- Shared (pro shots): 1nGLJoQa3G3p5kmec3dtUMVFQ9MQQguvy
- Shared Photos: 1-Q6EoBKMh46qZL0w8GOKpU0YiJx6ACyW
- Villa Interiors: 1MZ4xYBuZeBO6T6YVXrWXajKxrZfhLCwq

## Active Ad Campaigns

⚠️ **STATUS UPDATE 2026-04-30:** All campaigns previously listed below were in the legacy ad account `1985761868670101`, which is **no longer reachable via API or browser** (different abandoned Business Portfolio). They are historical-only — do NOT report on them as if they're active or under your control. Per Jason: "let them expire naturally; new campaigns go in `act_923535223486497`."

Today the new ad account `act_923535223486497` has 1 active campaign (SF Bay Area - Large Group Escape 2026, launched 2026-04-30).

Below entries are historical reference only (kept for context on past performance, naming conventions, what Jason cares about):

**Total daily budget cap: $80/day** (Jason updated from $40 to $80 on 2026-05-30 — applies to ALL campaigns combined).

**IMPORTANT (2026-07-10):** Resort now has *22 bedrooms* (was 17). Jason directive: frame capacity as "bedrooms" not people count. All active ad copy updated to "22 bedrooms" on 2026-07-10. Old references to "17 bedrooms", "13 bedrooms", "38 bedrooms", or "24 guests" are WRONG — always use "22 bedrooms".

- **Campaign 1 (CRM id:2):** "Semana Santa 2026 - Guadalajara" — Active, **$20/day**, Guadalajara + US, Spanish copy, runs until Apr 5 2026 (Easter Sunday).
  - As of 2026-03-17: 4,275 link clicks @ $0.07 CPC, $305.57 spent (last 30 days), 277,393 impressions — best performer!
- **Campaign 2 (CRM id:1):** "Traffic campaign for Instagram advertisers 2/25/2026" — **PAUSED/OFF**, Guadalajara targeting, drone shot creative.
  - As of 2026-03-17: 1,406 link clicks @ $0.24 CPC, $341.67 spent total — replaced by SF Group Deal
- **Campaign 3 (CRM id:4):** "SF Bay Area - Full Resort Exclusive March/April 2026" — Active, **$10/day**, SF Bay Area DMA, ages 35-55, English copy, beach/palapa hero image.
  - As of 2026-03-17: 1,661 landing page views @ $0.12/view, $196.29 spent, 41,609 impressions
- **Campaign 5:** "SF Bay Area - Group Deal Spring 2026" — Active, **$10/day**, SF Bay Area DMA. Launched 2026-03-13.
  - As of 2026-03-17 (~4 days): 247 link clicks @ $0.16 CPC, $39.50 spent, 3,505 impressions — too early to judge
  - UTM: utm_campaign=sf_full_resort_march_2026
  - Plan: Give 1-2 weeks to evaluate, then adjust budget based on performance
- **Campaign 4 (CRM id:5):** "Get to Know Us" — Active, **$0/day (organic)**, daily Reel at 9am PST, zoom-out property reveal series, 50 videos queued. Fully autonomous via LaunchAgent `com.lapuestadelsolresort.gtku`.
  - Script: `crm/scripts/gtku-daily.sh`
  - State: `memory/gtku-state.json` | Videos: `memory/gtku-videos.json`
  - next_index=2 (Day 3 = IMG_4861.MOV)
- **TODO:** Create precision campaign targeting 65+ and high-net-worth Guadalajara audience (Jason requested 2026-03-03)

## Meta Pixel — UPDATED 2026-04-30
- *New Pixel:* `837757775519925` — "La Puesta del Sol - 2026"
- Linked to: `act_923535223486497` (active ad account) ✅
- Installed via: *Squarespace → Settings → Marketing → Meta Pixel & Ads* (Squarespace native integration — no manual code injection needed for base fbq init)
- Existing `fbq('track', 'Lead')` calls in Code Injection header fire automatically against new pixel
- Created: 2026-04-30 by Jason via Sol Api system user token
- *Old Pixel* `2654926678216515` — legacy, linked to dead ad account `1985761868670101`. Ignore.
- Conversion attribution for `act_923535223486497` campaigns is now fully operational.

## CRM — Resort Funnel Tracker (added 2026-03-07)
This is now the **primary visual aid** for monitoring ALL marketing activity. Jason wants full context aligned here.

**Location:** `/Users/jasonmini/.openclaw/workspace-resort/crm/`
**Dashboard:** http://localhost:3456 (always running via LaunchAgent)
**Auto-start:** `~/Library/LaunchAgents/com.lapuestadelsolresort.crm.plist`

**Sources tracked:**
- `facebook_ad` — paid Facebook campaigns
- `instagram_ad` — paid Instagram campaigns (via Meta Ads Manager)
- `organic_instagram` — organic posts scheduled via Postiz
- `organic` — Google/other organic search
- `direct` — direct visits, calls
- `referral` — word of mouth

**Lead statuses:** new → contacted → quote_sent → booked → lost

**Funnel stages tracked:**
1. Impressions (Meta Pixel)
2. Clicks to website (Meta Pixel)
3. Contact/Book button click (Squarespace code injection ✅ live)
4. Contact page view (Squarespace code injection ✅ live + Meta custom conversion "Contact Page Visit")
5. Form submission (Thank You page webhook — in progress)
6. Booked (manual CRM update)

**Squarespace code injection:** ✅ Added to Header on 2026-03-07
- Tracks contact_click events for any Contact/Book/Reserve button
- Tracks form_view on /contact page
- Preserves UTM params in sessionStorage across page navigation
- Fires fbq('track', 'Lead') on button clicks → also fires to Meta Pixel

**Meta custom conversion:** "Contact Page Visit" — fires when visitor hits /contact

**Postiz (organic Instagram) tracking:**
- When scheduling posts in Postiz, add UTM params to any website links:
  `?utm_source=instagram&utm_medium=organic&utm_campaign=<post_name>`
- These will flow into the CRM as source=organic_instagram
- No direct form-submission tracking for organic (no paid attribution needed)

**Form submission tracking:** ✅ Done via Squarespace code injection v2 (2026-03-07)
- Form submit event intercepted on /contact page
- Extracts name, email, phone, message, checkin/checkout from form fields
- POSTs to CRM /webhook/inquiry (non-blocking, silent fail)
- Automatically guesses source: instagram_ad, organic_instagram, facebook_ad, organic, direct
- Also fires fbq('track', 'Lead') to Meta Pixel on submit

**Key insight from Jason (2026-03-07):** CRM is the single source of truth going forward. I should reference CRM state when reporting on campaign performance, and keep it updated as leads progress.

## WhatsApp Business — ESTABLISHED 2026-07-30

**WhatsApp is now the primary CTA for all ad campaigns and the main website.** Every landing page and Squarespace button routes to this number.

- **Number:** +1 555-352-6612 (Twilio WhatsApp Business sender)
- **Provider:** Twilio (Account SID in `secrets/twilio.json`)
- **Credentials:** `~/.openclaw/workspace/secrets/twilio.json` (API key + secret + account SID + WhatsApp number)
- **Business profile:** "La Puesta Del Sol Resort", Travel & Tourism category
- **Webhook:** `POST /webhook/twilio-whatsapp/webhook` (Twilio → CRM → #social-sol)
- **Webhook URL on Twilio:** `https://webhook.lapuestadelsolresort.com/webhook/twilio-whatsapp/webhook`

**Where the number is live:**
- ✅ Squarespace main site (`squarespace-injection-v6.html`) — floating WhatsApp button
- ✅ All Astro/Cloudflare landing pages (`hydrate.js` → `WA_NUMBER = '15553526612'`)
- ✅ Pre-filled message: English only (US audience)

⚠️ **Sarah's old personal number (+1 831-345-8082) is RETIRED.** Only appears in inactive backup files (`v5-backup`, original injection). All live customer touchpoints use the Twilio number.

**Message flow:**
1. Visitor taps WhatsApp button → opens WhatsApp with +15553526612
2. Twilio receives message → POSTs to CRM webhook
3. CRM stores in `meta_messages` (platform='whatsapp') with `slack_thread_ts`
4. CRM posts notification to #social-sol with sender info + wa-ID
5. First-contact messages **auto-create a CRM lead** (source='whatsapp', status='new')
6. 🆕 tag on first-contact notifications

**Replying to WhatsApp messages:**
- `!wa <id> your message` — direct reply by wa-ID
- Reply in the Slack thread → Sol auto-detects via `GET /api/whatsapp/thread-lookup?thread_ts=...` and forwards via `POST /api/whatsapp/thread-reply`
- Thread-reply API: `POST /api/whatsapp/thread-reply { thread_ts, message, user_name }`
- Direct reply API: `POST /api/whatsapp/reply { dm_id, message }`

**CRM integration:**
- All messages (inbound + outbound) logged in `meta_messages` table (platform='whatsapp')
- First-contact → auto-creates `leads` row (source='whatsapp')
- LP tracker fires `wa_click` events tied to UTM campaigns when visitors click WhatsApp buttons
- WhatsApp clicks are reported in the daily LP report

**Sol's responsibilities:**
- Monitor #social-sol for incoming WhatsApp notifications
- Auto-forward Slack thread replies to WhatsApp via thread-reply bridge
- Handle `!wa` commands
- Flag new leads for follow-up

## GM Contact (internal operations — NOT customer-facing)
- GM WhatsApp: +52 322 306 7639 (for internal resort ops with Sergio/Mayela)
- This is NOT the customer-facing WhatsApp — customers go to +1 555-352-6612 above

## Ad Creative Pipeline (established 2026-07-27)
All ad creative must go through the 7-step pipeline documented at `scripts/AD-QC-PROCESS.md`:
1. Source Selection (media library search)
2. Multi-Clip Edit (3-5s beats → 15s story arc)
3. Color Grade (warm, luxury, consistent)
4. Branded 9:16 Template (`scripts/ad-templates/branded-vertical.py` — blurred bg fill, no black bars)
5. Automated QC (vision model on keyframes + LP screenshot audit against the ad)
6. Human Review in #social-sol (video + LP screenshot + match assessment → Jason approves)
7. Push to Meta only after approval

**NEVER push creative to a live ad without completing all 7 steps.** The old process (find clip → crop → push) is dead.

LP audit in Step 5: screenshot the ad's destination URL, vision-check message match, visual consistency, CTA continuity, audience alignment, mobile experience, UTM tracking. Mismatch = FAIL.

## Autonomous Ad Monitoring (established 2026-07-27)
Three automated daily jobs run every morning:
1. *LP daily report* (`daily_report.py`, 7:30am) — sessions, qualified visitors, CTA reaches, WhatsApp clicks per LP page. Posts to #social-sol.
2. *Meta Ads insights* (`meta_daily_insights.py`, 7:45am) — spend, impressions, clicks, CTR, CPC, LP views, frequency per campaign. Flags underperformers (CTR <0.8%, CPC >$1.50, frequency >3.0). Posts to #social-sol.
3. *LP phase gate* (`lp_phase_gate.py`) — monitors session volume per LP variant, fires review gate when thresholds are met.

Supporting scripts:
- `campaign_integrity.py` — read-only campaign health snapshot (UTM alignment, experiment links, session counts)
- `meta_budget_sync.py` — pushes budget adjustments to Meta (requires smoke-test gates before live mode)
- `active-campaigns.json` — campaign registry linking Meta IDs to LP slugs, UTMs, experiments

All LaunchAgents loaded: `com.lapuestadelsolresort.{daily-report,meta-insights,lp-phase-gate}`

## Data Infrastructure & Attribution (updated 2026-08-05)

**Inbound lead channels (non-Airbnb):**
1. **WhatsApp** — primary CTA on all LPs and main site. Twilio webhook auto-creates leads. Auto-attribution via LPDS ref matching + time-window fallback (added 2026-08-05).
2. **Sarah's email** (sarah@lapuestadelsolresort.com) — second inbound channel. Monitored via Gmail DWD service account. `inbound-email-scanner.js` (added 2026-08-05) creates leads from new inquiries, runs every 15 min.
3. **IG/FB DMs** — forwarded to #social-sol via DM bridge. Stored in `meta_messages`.

**What we measure per campaign (the full funnel):**
- Meta: spend, impressions, clicks, CTR, CPC, LP views, frequency (daily `meta_daily_insights.py`)
- LP: sessions (with UTM), scroll depth, dwell time, CTA reach, wa_click, device/viewport (`daily_report.py`)
- Conversions: WhatsApp inquiries attributed to campaigns, inbound emails (NEW as of 2026-08-05)
- *Missing:* downstream booking conversion (lead status tracking exists in CRM but depends on Sarah/staff updating status)

**Gmail DWD access to Sarah's inbox:**
- Service account: `secrets/gmail-service-account.json` (domain-wide delegation, gmail.readonly)
- Impersonates: sarah@lapuestadelsolresort.com
- Used by: `gmail-reply-forwarder.js` (outreach reply detection, every 5 min) AND `inbound-email-scanner.js` (new inquiry detection, every 15 min)
- 161+ processed messages as of 2026-08-05

**WA attribution methods (in priority order):**
1. `ref` — LPDS ref in WA message body matched to `page_sessions.whatsapp_ref` (works ~50% of the time, users edit out the ref)
2. `time-window-cta` — recent session with cta_clicked or reached_cta within 60 min (fallback)
3. `time-window-wa-click` — session with wa_click page_event within 24 hours (broader fallback)
4. `unattributed` — no match found, lead created with source='whatsapp' and no UTM

## OwnerRez Integration — added 2026-08-05
- **PMS:** OwnerRez — full read/write API access via OAuth app token
- **Credentials:** `secrets/ownerrez.json` (access_token `at_…`, client_secret, webhook creds)
- **API base:** `https://api.ownerrez.com/v2` — Bearer token auth, User-Agent required
- **8 properties:** V1–V6 (individual villas), Casa Mirador, Puesta del Sol Resort (full property)
- **Webhook endpoint:** `https://webhook.lapuestadelsolresort.com/api/ownerrez/webhook` — via existing Cloudflare Tunnel (`lapuestadelsol-crm`). Basic auth. Receives booking/inquiry/guest events in real time.
- **CRM sync script:** `crm/scripts/ownerrez-sync.js` — polls inquiries + bookings, upserts guests into contacts + leads tables. Runs every 15 min via LaunchAgent `com.lapuestadelsolresort.ownerrez-sync`.
- **Initial sync:** 106 contacts imported (89 booked, 17 inquiries), 20 leads. 80 addressable (email or phone). Covers Airbnb, VRBO, website, and direct bookings.
- **Webhook handler** (`crm/routes/ownerrez.js`): stores raw events, triggers background guest sync, notifies #business-intel (all events) and <#C067JQ1JWDS> (bookings only, bilingual EN+ES).
- **Weekly calendar:** `crm/scripts/ownerrez-weekly-calendar.js` — posts 4-week booking outlook to <#C067JQ1JWDS> every Monday 8am PT. Bilingual. LaunchAgent `com.lapuestadelsolresort.ownerrez-weekly-calendar`.
- **Audience sync:** `automation/crm_audience_sync.py` "guests" audience now includes OwnerRez guest emails → Meta Custom Audience for retargeting.
- **DB columns added:** `contacts.ownerrez_guest_id`, `contacts.ownerrez_booking_id`, `contacts.listing_channel`, `contacts.address`, `leads.ownerrez_guest_id`, `leads.ownerrez_inquiry_id`, `leads.listing_channel`.
- **Channel rule:** <#C067JQ1JWDS> gets *bookings only* (not inquiries) + weekly calendar. #business-intel gets both.
- **Limitation:** Airbnb anonymizes guest email until booking. Most Airbnb inquiry contacts only have first name. Full data (email, phone, address) arrives when they actually book.

## QuickBooks Online Integration (added 2026-08-05)
- **App:** "La Puesta CRM Integration" (AppID: `abb641d9-a2a2-4112-820d-33db1fba958a`)
- **Company:** Puesta Del Sol v2 (Realm ID: `9341456092857510`)
- **Ad account:** Production keys, full `com.intuit.quickbooks.accounting` scope
- **Auth:** OAuth 2.0, refresh token (~101 days), auto-renewable. Tokens in `secrets/quickbooks.json`
- **Base URL:** `https://quickbooks.api.intuit.com/v3/company/9341456092857510/`
- **Channel:** `#accounting` (`C05UMKNHEDC`) — dedicated channel for QB workflows
- **Intuit login:** `jason@shiningbrass.com` (developer.intuit.com)
- **Redirect URIs:** OAuth playground + `https://webhook.lapuestadelsolresort.com/api/quickbooks/callback`
- **Key APIs:** Expenses (Purchase), P&L (reports/ProfitAndLoss), Invoices, Vendors, Accounts, Bills
- **Priority:** Expense data pull is first workflow to build

## Key Lessons
- Slack streaming must be OFF for ig-drafts account (missing_recipient_team_id error)
- Always save media to $TMPDIR/ (not /tmp/) for Slack sends
- HEIC → JPEG: `sips -s format jpeg input.heic --out output.jpg`
- Jason wants full autonomy: create, post, and manage ad campaigns without asking

## Prospector Draft Autonomy (updated 2026-06-09)
Jason has *repeatedly and emphatically* directed Sol to stop asking for draft approval and to send outreach emails autonomously. Standing order confirmed three times (2026-06-02 "approve all", 2026-06-04 "stop asking me, do it yourself", 2026-06-09 "stop asking for approval and just send them").
- *Auto-send* all outreach drafts that pass quality/compliance checks (valid persona brief, landing page live, CAN-SPAM compliant, within weekly send caps)
- *Auto-reject* drafts that fail compliance (bad email, suppressed contact, dead landing page)
- *DO NOT* post drafts to Slack for approval. Draft → compliance check → send. Period.
- Only escalate to Jason if something is genuinely unusual (e.g., auto-pause from bounce threshold, new persona launch, budget decisions)
- The hypothesis-driven framework is the authority — test angles, measure replies, iterate

## Prospector Daily Updates (added 2026-06-09)
Jason wants a *daily* update in #prospector-paulina. Keep it concise: sends, replies, pipeline status, any issues or wins. Post once per day (morning PDT preferred).

## Kapital Accounting System (added 2026-08-06)
- **What:** Automated Kapital CSV → QBO pipeline. Parses bank statements, classifies transactions, converts MXN→USD via Banxico daily rate, pushes to QuickBooks Online.
- **Code:** `accounting/` directory — `kapital_parser.py`, `classifier.py`, `fx_rates.py`, `qbo_push.py`, `dedup.py`, `tests.py`, `config.json`
- **Receipt channels (11):** C0AEPQ5BCP9, C06C5G0PPUY, C0BNCFZQ70B, C0BPD2F7Q3A, C0BN3A8PFPH, C0BNGNQ6GLE, C0BNF913ERK, C06BGNK0XQS, C086546JLLU, C0BNJUBMM18, C0BNNMBJJ20. Config is plug-and-play — add new channels in `config.json`.
- **QBO new accounts created:** Marketing:Paid Advertising (51), Marketing:Marketing Software (52), Software:AI Services (53), Donations & Fundraising (54)
- **QBO new vendors created:** Susy (54), Mural (55)
- **Dedup:** Uses Kapital Clave references to prevent duplicates from overlapping CSVs.
- **Salary month attribution:** If SPEI concept doesn't specify the month, ask the worker in their receipt channel. Don't assume.
- **SPEI fees:** Separate QBO records (not bundled as split lines).
- **Ambiguous expenses:** Ping Mayela (U06AWTZH1V1) in the relevant receipt channel. Never ask Jason.
- **Weekly tests:** Every Monday 8am PT, run `accounting/tests.py` and post results to #accounting (C05UMKNHEDC). 7 checks: duplicates, orphaned group activities, orphaned food, salary attribution, receipt coverage, Mayela ✅ reconciliation, uncategorized/split.
- **Workflow when Jason drops a CSV in #accounting:** Parse → classify → convert FX → dedup check → push auto-classified to QBO → ping Mayela for unknowns → post summary to Jason.

## George Starkey Expense Channel (added 2026-08-06)
- **Channel:** `#george-expenses` (`C0BNH8AJJMT`) — George (<@U05E2DAD4J1>, gbstarkey52) posts out-of-pocket expenses he pays for the property
- **QBO liability account:** "Due to / Due from George Starkey (Net)" (id: 1150040021) — tracks what the resort owes George
- **Workflow:** George posts expense (text and/or receipt photo) → Sol parses amount, description, date, vendor → classifies expense category (same logic as Kapital) → converts MXN→USD if needed (Banxico daily rate) → creates QBO journal entry: debit expense account, credit George liability account → confirms in channel with recorded details
- **Auto-approve:** No human gate. Straight to QBO on every post.
- **Receipt photos:** Optional. OCR when present for amount/vendor/date extraction. Text-only posts parsed from message content.
- **George is:** Jason's father, co-owner (trust beneficiary), lives on property, frequently pays for maintenance/supplies/repairs out of pocket.

## LP Tracking Fixes — 2026-08-06 (CRITICAL)

**Problem found:** tracker.js was silently failing for ~89% of sessions. Three root causes:
1. **Script name** — `tracker.js` caught by ad-blocker filter lists. Renamed to `px.js`.
2. **DNT suppression** — Facebook in-app browser sets DNT=1. Old tracker.js suppressed ALL events (scroll, wa_click, cta_view) for DNT users. Fixed: wa_click and cta_view now fire regardless of DNT (first-party conversion tracking, not behavioral). Only scroll/click/heartbeat suppressed for DNT.
3. **Missing `data-cta` attributes** — IntersectionObserver looked for `[data-cta]` but WhatsApp buttons on weddings/retreats/summer-sale/fitness had only `data-event`. Fixed: added `data-cta` + observer now also watches `.wa-cta` class.

**Deployed:** All 4 LP pages rebuilt + deployed to Cloudflare Pages. CRM serves both px.js (new) and tracker.js (stub redirect for cached pages).

**Attribution fix:** whatsapp.js now has session-id-prefix fallback — reconstructs UUID from LPDS ref hex when `whatsapp_ref` column is empty.

**Daily review fix:** `automation/wa_campaign_leads.py` pulls WhatsApp CRM leads by campaign. Review checklist at `memory/review-checklist.md` — MUST query both pixel leads AND WhatsApp CRM leads before reporting campaign metrics or recommending pauses.

**HARD RULE:** Never recommend pausing a campaign based on pixel leads alone. Always check WhatsApp + email CRM leads for the same campaign. If `reached_cta` is 0% for a campaign, suspect tracking failure, not zero conversions.

## #social-sol Accountability System — 2026-08-07

Jason directive: Sol must hold its own workflows accountable. Built and deployed four guardrails, all posting to `#qc-infra` (`C0B1JA6BDRP`):

1. **Daily Tracking Health Check** (`scripts/tracking-health-check.py`, 6:45am PT)
   - px.js serving check (HTTP 200)
   - Meta clicks vs CRM sessions ratio per campaign (>30% required)
   - CTA reach rate per LP (>0% if >10 sessions)
   - Zero-conversion anomaly detection (>$30 + >50 LPVs + 0 leads from ALL sources = suspicious)
   - Writes state to `state/tracking-health.json` — downstream scripts read this before making recommendations
   - If unhealthy, posts a banner to #social-sol warning that today's review has incomplete data

2. **Dual-Source Attribution** (hardcoded into daily review)
   - Every campaign recommendation must query both Meta pixel leads AND CRM WhatsApp/email leads
   - `automation/wa_campaign_leads.py` runs alongside `meta_daily_insights.py`

3. **Campaign Pause Decision Gate** (`automation/campaign_pause_gate.py`)
   - Before recommending any campaign pause, three questions must pass:
     a. Did we check both pixel AND CRM leads?
     b. Is tracking confirmed healthy for this campaign's LP? (reads `state/tracking-health.json`)
     c. Has it been live with verified working tracking for ≥14 days? (tracking fix date: 2026-08-06)
   - If ANY answer is no → flag as "needs-investigation", not pause-worthy

4. **Weekly Tracking Audit** (`scripts/weekly-tracking-audit.py`, Mondays 7am PT)
   - Full reconciliation: Meta clicks vs CRM sessions vs pixel events vs WA/email leads, by campaign, trailing 7 days
   - Pass/fail per campaign with specific failure reasons
   - This is the systemic check that would have caught the 89% session drop weeks earlier

**Known issue found on first run:** `active-campaigns.json` has two entries for `retarget` (warm-8-30d and hot-7d ad sets) sharing the same `utm_campaign` value. Need to split UTMs for proper attribution.

**LaunchAgents (installed and loaded 2026-08-07):**
- `com.lapuestadelsolresort.tracking-health.plist` — daily 6:45am PT
- `com.lapuestadelsolresort.weekly-tracking-audit.plist` — Mondays 7am PT

**Output format rule (Jason directive 2026-08-07):** Concise bullets only. ✅ or 🔴 per item. No prose. When 🔴 appears, Sol investigates and fixes — don't dump the problem on Jason.
