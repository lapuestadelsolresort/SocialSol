# SocialSol

AI operations platform for La Puesta del Sol Resort (Riviera Nayarit, Mexico).

What began as a marketing stack now runs three domains of the business:
**marketing & guest conversion**, **property operations**, and **finance &
admin support**. It runs on a single Mac mini via OpenClaw, with humans
using Slack as the human interface. Stable Slack channel and user IDs are the
authorization boundary; fixed, durable workflows—not an agent prompt—perform
and verify business mutations.

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
| OwnerRez CRM contact sync | Every 15 min + real-time webhooks | `#business-intel` |
| OwnerRez full-occupancy calendar | Monday 8am PT | `#reservations` |
| Squarespace direct-commerce sync | Every 5 min | `#business-intel`, `#accounting`, `#reservations` |
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

- **Durable workflow control plane** (`workflow/`, `crm/workflows/`) — fixed
  versioned graphs backed by SQLite runs, steps, effects, evidence, retries,
  leases, and a notification outbox. Model context can request a workflow but
  is never the workflow state or the authority for a completion claim.

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

## Authority and mutation rules

- Channel membership grants the domain capabilities listed in the ignored
  runtime `workflow/policy.json`. The committed example contains no real Slack
  identities.
- Paulina, Regina, routine social publishing, CRM synchronization, accounting
  classification, and auto-tier QBO writes have standing autonomous authority.
- `#whatsapp` is the sole human WhatsApp console. A send must be an explicit
  `!wa` command by a member of that private channel; plain Slack replies and
  the retired direct HTTP send endpoints cannot send to a guest.
- Instagram/Facebook DM replies are likewise command-only: `!dm <dm-id>
  <message>` in `#social-sol`. The retired `/api/meta-dm/reply` endpoint cannot
  bypass the durable ledger.
- OwnerRez writes are additionally restricted to configured user IDs. A
  proposal records its exact fixed-catalog operation, request hash, reason,
  preflight snapshot, and 15-minute expiry. The same authorized Slack user must
  paste the emitted `!ownerrez confirm …` command; the graph then rechecks the
  precondition, executes once, and requires operation-specific readback. No
  generic method, URL, API client, or shell escape is exposed to an agent.
- OwnerRez and QBO writes notify the configured human recipients after provider
  readback. Ad budget changes retain their separate code-level caps.
- Completion claims require a workflow, effect, evidence, or provider artifact.
  Accepted, queued, sent, delivered, read, and verified-by-readback are distinct
  states.
- Ambiguous non-idempotent results pause that workflow for human provider-console
  review. They are never automatically replayed; configured reviewers resolve
  them with the exact `!review resolve …` command recorded in the alert.
- Provider sends and local message projections are separate graph steps. Once
  provider acceptance is recorded, a local SQLite retry cannot call the
  provider again, and staff are explicitly told not to resend.

---

## Repository layout

```
crm/                   Express CRM server, SQLite migrations, tests
├── routes/            Webhook handlers (Twilio, Meta, Resend, Cal.com, OwnerRez)
├── scripts/           Sync jobs (OwnerRez CRM sync, message ingest, full occupancy
│                      query/calendar, voice corpus indexer, inbound email scanner)
├── lib/               Shared libraries (API auth, Gmail client, voice retrieval,
│                      Chroma connect, suppressions, webhook verification)
└── data/              SQLite databases (never committed)

workflow/              Channel policy template, architecture and cutover runbook
openclaw-plugins/       Trusted Slack identity adapter and claim-verification hooks

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
runtime/state/          Generated health and tracking snapshots (not committed)
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
| **OwnerRez** | PMS of record. Full read/write API + 24 webhook subscriptions (booking, guest, property, message, quote, inquiry, surcharge, discount × create/update/delete). 15-min CRM contact sync + real-time webhook handler. The separate full-occupancy query includes guestless reservations, blocks, holds, and linked availability and powers the weekly ops calendar. Message thread ingestion into voice corpus. |
| **Squarespace Commerce** | Direct-booking financial source. Server-side, read-only import of customers, orders, payments, fees, and refunds into the CRM, with conservative OwnerRez cross-links and agent-specific reporting. Airbnb/Vrbo bookings remain in OwnerRez and their payouts enter accounting only through Kapital. |
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
| **QuickBooks Online** | Accounting system of record. Read/write API via OAuth 2.0. Automated expense classification and push from Kapital bank statements, with provider idempotency and entity readback. Runtime company identity and tokens remain in the secrets directory. |

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
npm run setup:workflow-token
npm run check:stack
```

Create runtime directories without committing them:

```bash
mkdir -p crm/data logs secrets campaigns runtime/state
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

1. Runtime databases and authoritative provider APIs are the source of truth.
   Agent memory is context only and cannot prove a mutable business fact.
2. Inspect schemas and paths at runtime (`sqlite3 .schema`, `ls`) — don't
   assume structure from docs or memory.
3. Every "complete" claim needs a verification command next to it.
4. Enforce `workflow/policy.json` and each graph's explicit mutation contract;
   never infer authority from a name supplied by a model.
5. The former `marketing-stack` repository is a migration source only — nothing
   here depends on it.
7. The Voice Service corpus is the single most sensitive training asset — do
   not bulk-export or expose message bodies outside the CRM.
8. OwnerRez is the PMS of record. The CRM sync is contact-only and must never
   answer booking or availability questions. Use
   `node crm/scripts/ownerrez-full-occupancy.js --start YYYY-MM-DD --end YYYY-MM-DD`
   to query all active reservations and blocks directly from OwnerRez.
