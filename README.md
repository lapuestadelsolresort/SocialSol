# SocialSol

AI operations platform for La Puesta del Sol Resort (Riviera Nayarit, Mexico).

What began as a marketing stack now runs three domains of the business:
**marketing & guest conversion**, **property operations**, and **finance &
admin support**. It runs on a single Mac mini via OpenClaw, with humans
approving anything outbound. Slack is the human interface; every agent has a
channel.

Sol is also the resort's **AI business consultant** — continuously optimizing
for cost efficiencies and revenue growth across all three domains. Every
integration, automation, and workflow should be evaluated through the lens of
operational savings, margin improvement, and scalable processes.

## The one-paragraph version

The resort makes ~2× more per buyout on direct bookings than on Airbnb.
This system exists to generate direct demand (weddings, corporate retreats,
returning guests), convert it through landing pages and WhatsApp, keep the
property's operational and financial back-office from falling through the
cracks, and document all of it well enough that the system transfers with the
business at sale.

---

## Agents

| Agent | Domain | What it does | Slack channel |
|---|---|---|---|
| **Social Sol** | Marketing | Daily organic Instagram + paid Meta campaigns → landing pages → WhatsApp funnel | `#social-sol` |
| **Prospector Paulina** | Marketing | Verified B2B email outreach to named wedding planners and retreat coordinators, with staged send-volume and deliverability gates; separate from paid Meta delivery | `#prospector-paulina` |
| **Reengager Regina** | Marketing | Past-guest and stale-inquiry reactivation campaigns | `#reengager-regina` |
| **Sarah Coach** | Guest comms | Drafts replies to inbound guest messages in Sarah's voice; she edits and sends | `#sarah-coach` |
| **Paloma** 🕊️ | Operations | Monitors maintenance/housekeeping channels, logs tasks, bilingual follow-ups and weekly digests | `#paloma-tracker` |
| **Corporate Intelligence** | Finance/legal | Analysis of Mexican corporate docs, tax filings, and property trusts (see "Not in this repo") | `#corporate` |
| **QuickBooks Integration** | Finance | Automated expense tracking via Slack receipt channels → Kapital CSV → QBO pipeline. Full read/write API. | `#accounting` |

### Supporting automations

| Automation | Schedule | Channel |
|---|---|---|
| OwnerRez booking/guest sync | Every 15 min + real-time webhooks | `#business-intel` |
| OwnerRez weekly booking calendar | Monday 8am PT | `#reservations` |
| OwnerRez message → voice corpus ingestion | Daily 6:30am + real-time on webhook | — |
| CRM → Meta Custom Audience retargeting sync | Daily | `#social-sol` |
| Inbound email scanner (Gmail) | Every 15 min | `#social-sol` |
| Telmex bill reminder | Monthly | `#utility-payments` |
| Daily campaign report | Daily | `#business-intel` |
| Budget guardrails check | Continuous | `#business-intel` |
| Sender-domain warmup | Scheduled batches | `#prospector-paulina` |
| Encrypted backups + Healthchecks monitoring | Daily | `#ops-alerts` |
| Accounting weekly tests (7 checks) | Monday 8am PT | `#accounting` |

### Shared infrastructure

- **Voice Service** (`POST /api/voice/draft`) — drafts outbound copy in
  Sarah's authentic voice. Trained on a **1,251-message corpus** (1,204
  original Airbnb messages + 47 OwnerRez thread messages) embedded in Chroma
  via OpenAI `text-embedding-3-small`. Powers Paulina, Regina, and Sarah Coach.
- **CRM** (`http://localhost:3456`) — Express + SQLite backend shared by every
  agent. Contacts, leads, outreach sends, suppressions, multi-touch
  attribution, voice draft logs, and media assets.
- **Paid-channel boundary** — Paulina email and Meta paid acquisition share
  landing pages and CRM storage, but use separate UTM namespaces, campaign
  controls, and reports. Only verified WhatsApp leads carrying a configured
  paid-Meta UTM are sent to Meta CAPI; email, organic, direct, and unattributed
  leads remain CRM-only.
- **Media Library** (`/api/media/search`) — 223 indexed assets from the
  Oct 2025 property shoot (drone, A-cam, B-cam, wedding photos). Vision-
  captioned, embedding-searchable, persona-weighted ranking. Vertical render
  pipeline for Instagram Reels (`media/scripts/render-vertical.js`). 4K
  originals stored locally on the Mac mini.

---

## Human gates (load-bearing, not decorative)

- **No outbound email sends without human approval.** Sarah reviews copy;
  approval happens in Slack. *(Exception: Prospector Paulina runs fully
  autonomous per standing directive — see `MEMORY.md`.)*
- **Guests talk to people.** WhatsApp is handled by a live person. AI drafts;
  humans send.
- **Ad budgets are capped in code.** Live budget changes require explicit mode
  and total-budget guardrails. Campaign activation requires Jason's approval.
- **Completion claims require verification artifacts.** Agent summaries are
  unverified until confirmed against real terminal output, DB queries, or API
  responses.

---

## Repository layout

```
crm/                   Express CRM server, SQLite migrations, tests
├── routes/            Webhook handlers (Twilio, Meta, Resend, Cal.com, OwnerRez)
├── scripts/           Sync jobs (OwnerRez sync, message ingest, weekly calendar,
│                      voice corpus indexer, inbound email scanner)
├── lib/               Shared libraries (API auth, Gmail client, voice retrieval,
│                      Chroma connect, suppressions, webhook verification)
└── data/              SQLite databases (never committed)

landing/apps/          Astro landing pages (weddings, retreats, fitness, planner
                       partners) deployed to Cloudflare Pages

accounting/            Kapital → QBO expense pipeline: CSV parser, 3-tier
                       classifier, FX conversion, dedup, QBO push, weekly tests

automation/            Daily reports, campaign integrity, budget guardrails,
                       CRM audience sync, backups, watchdogs

prospector/            Paulina: research, composition, compliance, send
├── library/           Persona definitions, example templates, CTA variants
├── scripts/           Daily prospecting, engagement analysis
└── config.json        Sender identity, send caps, approver list (not committed)

regina/                Reengager: campaign engine, dossier-based drafting
sarah-coach/           Inbound reply drafting and outcome capture
paloma/                Task tracker: channel scanner, weekly follow-up/summary

media/                 Media library pipeline
├── originals/         4K source files from property shoots (local, not committed)
├── renditions/        Rendered verticals for Instagram (local, not committed)
└── scripts/           render-vertical.js, rescan, indexer

scripts/               Standalone jobs (Telmex bill check, etc.)
warmup/                Sender warmup templates and driver
lp/variants/           Versioned landing-page copy
campaigns/             Sanitized configuration templates
launchagents/          Portable LaunchAgent plist templates
memory/                Sync state files (not committed)
```

---

## Not in this repo

- **Corporate & Legal Intelligence** runs from the OpenClaw workspace, not this
  codebase. It has Google Drive access to the shared corporate folder (trust
  documents, entity tax returns, VAT withholdings, notarial deeds) and handles
  translation/analysis of Spanish legal and tax PDFs, entity and filing-status
  tracking, fideicomiso fee tracking, document retrieval on demand, and SAT
  compliance alerts. There is deliberately no corporate code or data here.

- **Kapital Accounting System** (`accounting/` directory) — Automated
  pipeline: Kapital Bank CSV → transaction classification → MXN→USD conversion
  (Banxico daily rate) → QuickBooks Online push. Three-tier classifier
  (auto/guess/unknown) maps SPEI transfers, payroll, utilities, and vendor
  payments to QBO categories. Deduplication via Kapital Clave references.
  11 dedicated Slack receipt channels (`#receipts`, `#mayela-receipts`,
  `#property-receipts`, `#cleaning-receipts`, `#sergio-receipts`,
  `#group-expenses`, `#temo-receipts`, `#daniel-invoices`,
  `#sergio-mayela-invoices`, `#misc-receipts`, `#new-receipts`) where the
  team posts expense receipts, SPEI confirmations, and salary invoices.
  Sol cross-references these with bank statement transactions for
  classification context. Unknown transactions are escalated to Mayela.
  Weekly automated tests (7 checks) run Monday 8am PT and post to
  `#accounting`. See `accounting/README.md` for the full spec.

- Live databases, credentials, customer records, prospect lists, Slack
  identifiers, campaign state, logs, generated media, and agent
  identity/memory files. See `ARCHITECTURE.md` for the full boundary list.

---

## Key integrations

| Service | Purpose |
|---|---|
| **OwnerRez** | PMS of record. Full read/write API + 24 webhook subscriptions (booking, guest, property, message, quote, inquiry, surcharge, discount × create/update/delete). 15-min CRM sync + real-time webhook handler. Message thread ingestion into voice corpus. Weekly booking calendar to ops team. |
| **Meta Marketing API** | Paid campaigns, custom audience sync, Pixel/CAPI attribution, Instagram Graph API for organic posting and DM bridge |
| **Google Drive** | Resort photo library (6 folders), corporate document storage, HEIC→JPEG conversion pipeline |
| **Twilio** | WhatsApp webhook bridge for guest conversations |
| **Resend** | Outbound email delivery (outreach subdomain), webhook signature verification |
| **Postiz** | Instagram post/Reel scheduling via API |
| **Cloudflare** | Pages hosting for landing pages + named tunnel (`lapuestadelsol-crm`) exposing CRM webhooks at `webhook.lapuestadelsolresort.com` |
| **Chroma** | Vector store for voice corpus (sarah_voice_corpus) and media library (media_corpus) |
| **Cal.com** | Booking-call scheduling webhooks |
| **Healthchecks.io** | Job monitoring → `#ops-alerts` |
| **OpenAI** | Embeddings (`text-embedding-3-small`) for voice corpus and media search |
| **ElevenLabs** | Voice catalog for video ad projects |
| **QuickBooks Online** | Accounting system of record. Full read/write API via OAuth 2.0. Automated expense classification and push from Kapital bank statements. P&L reports, invoices, 30+ vendors, 35+ expense/income categories. Company: "Puesta Del Sol v2" (Realm `9341456092857510`). Refresh-token auth, auto-renewable. |

---

## Local setup

Requirements: Node.js 22.12+, Python 3.11+, SQLite 3.
Optional: OpenClaw CLI, Cloudflared, FFmpeg, Chroma.

```bash
cp .env.example .env
cp prospector/config.example.json prospector/config.json
cp regina/config.example.json regina/config.json
cp sarah-coach/config.example.json sarah-coach/config.json
cp warmup/recipients.example.json warmup/recipients.json
cp warmup/state.example.json warmup/state.json
npm install
npm run check:stack
```

Create runtime directories without committing them:

```bash
mkdir -p crm/data logs secrets campaigns
cp campaigns/active-campaigns.example.json campaigns/active-campaigns.json
```

Production credentials live in mode-600 JSON files under
`SOCIALSOL_SECRETS_DIR`. See `docs/configuration.md`.

---

## Security defaults

- Internal `/api/*` routes are default-deny and loopback-only unless Basic-auth
  credentials are configured
- Only landing configuration and telemetry ingestion are public
- OwnerRez webhook endpoint (`/api/ownerrez/webhook`) is allowlisted for
  external access with its own Basic Auth layer
- Twilio, Meta, Resend, Cal.com, and OwnerRez webhooks verify provider
  signatures or auth
- Tokens travel in authorization headers, not query strings
- Pre-commit secret scanning; all secrets templated as `.example` files

See `SECURITY.md` for reporting and credential-handling guidance.

---

## For future agents reading this

1. `MEMORY.md` in the OpenClaw workspace is the tactical source of truth —
   read it at session start for active leads, campaign state, integration
   details, and key lessons.
2. Inspect schemas and paths at runtime (`sqlite3 .schema`, `ls`) — don't
   assume structure from docs or memory.
3. Every "complete" claim needs a verification command next to it.
4. Human approval gates are hard blockers, not suggestions.
5. The former `marketing-stack` repository is a migration source only — nothing
   here depends on it.
7. The Voice Service corpus is the single most sensitive training asset — do
   not bulk-export or expose message bodies outside the CRM.
8. OwnerRez is the PMS of record. When in doubt about bookings, availability,
   or guest data, query the API directly — do not rely on cached CRM data
   alone.
