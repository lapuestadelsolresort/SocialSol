# QC-1a generated inventory — deployed SHA 2983ed0

Generated 2026-08-15 (PDT). Sources: the QC worktree (code byte-identical to deployed `2983ed00646611a6a2b59d294af71ce49e08ad3a`; `git diff --stat 2983ed0 HEAD -- . ':(exclude)qc' ':(exclude).claude'` is empty) and read-only reads of production runtime. No handwritten component lists: every table is script-generated from registry/policy/launchd/filesystem evidence (E-QC1INV-01…19 in `EVIDENCE_INDEX.md`; raw artifacts in `~/qc-evidence/QC1-INV/`). Provider/channel identifiers are aliased per plan §4.1.

## 1. Workflows — 53 definitions from `crm/workflows/registry.js` `listDefinitions()`

| Workflow | Capability | Mutates | Live | Autonomous (reg/pol) | Trigger | Scheduled producer |
|---|---|---|---|---|---|---|
| accounting.classify | accounting.write | yes | LIVE | reg/pol | - | - |
| accounting.reconciliation.read | qbo.read | no | shadow | -/- | - | - |
| business.snapshot.read | business.read | no | shadow | -/- | - | - |
| crm.contacts.read | crm.read | no | shadow | -/- | - | - |
| crm.pipeline.read | crm.read | no | shadow | -/- | - | - |
| crm.sync | crm.write | yes | LIVE | reg/pol | - | - |
| email.activity.read | email.read | no | shadow | -/- | - | - |
| email.message.classify | email.send | no | LIVE | -/- | slack_email_classify_command | - |
| email.message.observe | email.read | no | shadow | -/pol | - | - |
| email.reply.confirm | email.send | yes | LIVE | -/- | slack_email_confirm_command | - |
| email.reply.propose | email.send | no | LIVE | -/- | slack_email_reply_command | - |
| guest.reply.draft | guest_messages.draft | yes | shadow | -/- | - | - |
| marketing.change.confirm | marketing.write | yes | LIVE | -/- | slack_meta_campaign_confirm_command | - |
| marketing.change.propose | marketing.write | no | shadow | -/- | - | - |
| marketing.report.daily | marketing.read | yes | LIVE | reg/pol | - | daily-report (cal:Hour=7,Minute=30) |
| marketing.snapshot.read | marketing.read | no | shadow | -/- | - | - |
| meta.audience.sync | marketing.write | yes | LIVE | reg/pol | - | crm-audience-sync (cal:Hour=7,Minute=0) |
| meta.campaign.autonomous | marketing.write | yes | LIVE | reg/pol | - | - |
| meta.dm.reply | social.write | yes | shadow | -/- | slack_meta_dm_command | - |
| ownerrez.crm.sync | crm.write | yes | LIVE | reg/pol | - | graph-crm-sync (every 900s) |
| ownerrez.mutation.confirm | ownerrez.write | yes | LIVE | -/- | slack_ownerrez_command | - |
| ownerrez.mutation.propose | ownerrez.write | no | shadow | -/- | - | - |
| ownerrez.occupancy.read | ownerrez.read | no | shadow | -/- | - | - |
| ownerrez.webhook.process | crm.write | yes | LIVE | reg/pol | - | - |
| paulina.daily | paulina.send | yes | LIVE | reg/pol | - | graph-paulina (every 300s) |
| paulina.performance.read | paulina.read | no | shadow | -/- | - | - |
| paulina.prepare_daily | paulina.prepare | yes | LIVE | reg/pol | system | graph-paulina-prepare (cal:Hour=8,Minute=30) |
| qbo.bank_balances.read | qbo.read | no | shadow | -/- | - | - |
| qbo.report.read | qbo.read | no | shadow | -/- | - | - |
| qbo.write | qbo.write | yes | LIVE | reg/pol | - | - |
| receipt.annotate | receipts.write | yes | LIVE | -/- | - | - |
| receipt.ingest | receipts.submit | yes | LIVE | -/- | slack_receipt_hook | - |
| receipt.owner_expense.confirm | qbo.owner_expense.write | yes | LIVE | -/- | slack_receipt_confirm_command | - |
| receipt.owner_expense.ingest | qbo.owner_expense.write | yes | LIVE | -/- | slack_receipt_hook | - |
| receipt.owner_expense.process | qbo.owner_expense.write | yes | LIVE | -/- | workflow | - |
| receipt.owner_expense.reconcile | qbo.owner_expense.write | yes | shadow | -/- | admin_reconciliation | - |
| receipt.payment_source.select | receipts.write | yes | LIVE | -/- | slack_receipt_source_action | - |
| receipt.process | receipts.write | yes | LIVE | -/- | workflow | - |
| receipt.reconcile | accounting.write | yes | LIVE | reg/pol | - | graph-receipt-reconcile (every 3600s) |
| receipts.scoped.read | accounting.read_scoped | no | shadow | -/- | - | - |
| receipts.status.read | receipts.read | no | shadow | -/- | - | - |
| regina.campaign | regina.send | yes | LIVE | -/- | - | - |
| regina.daily | regina.send | yes | LIVE | reg/pol | - | graph-regina (cal:Hour=7,Minute=30) |
| social.content.publish | social.publish | yes | LIVE | -/- | - | - |
| social.content.read | social.read | no | shadow | -/- | - | - |
| social.content.upsert | social.write | yes | LIVE | -/- | - | - |
| social.publish_due | social.publish | yes | LIVE | reg/pol | - | graph-social-publish (every 300s) |
| social.publish_routine | social.publish | yes | LIVE | reg/pol | - | graph-social-routine (cal:Hour=8,Minute=0) |
| squarespace.crm.sync | crm.write | yes | LIVE | reg/pol | - | graph-squarespace-sync (every 300s) |
| squarespace.summary.read | squarespace.read | no | shadow | -/- | - | - |
| whatsapp.inbound.process | crm.write | yes | LIVE | reg/pol | - | - |
| whatsapp.reply | whatsapp.send | yes | LIVE | -/- | slack_whatsapp_command | - |
| whatsapp.status.read | whatsapp.read | no | shadow | -/- | - | - |

Registry/policy facts (E-QC1INV-01/02/03):

- Runtime policy `workflow/policy.json`: version=1, `shadow_mode=true` with 32 `live_workflows` exceptions, 17 `autonomous_workflows`, 35 Slack channel bindings (channel IDs aliased; raw in evidence), sha256 `32c2bdfe1edefe48…` mode 600 — exactly the post-F-020-quarantine fingerprint (QCF20-03).
- All 32 live workflows exist in the registry; zero policy names missing from code.
- 21 registry workflows not live: 15 read models, the propose/draft halves (`marketing.change.propose`, `ownerrez.mutation.propose`, `guest.reply.draft`), admin `receipt.owner_expense.reconcile`, `email.message.observe`, and quarantined `meta.dm.reply` (F-020, verified-fixed).
- `always_on_effects`: `whatsapp.inbound.process:send_conversion`. `restricted_capabilities`: `email.send`, `marketing.write`, `ownerrez.write`.
- **Drift → QC-1b:** `email.message.observe` appears in policy `autonomous_workflows` but not in `live_workflows`, and its registry `autonomous` flag is false.
- **Side-effect mismatch → QC-6:** `marketing.report.daily` carries capability `marketing.read` but `mutates=true`.

## 2. Scheduled producers — launchd, five layers

Layers captured: templates (50 `.plist.template`) → fresh render to temp dir (50 files, `--output` confined; E-QC1INV-08) → production deploy-generated (`deploy/launchagents/generated`, 51 entries) → installed (`~/Library/LaunchAgents`: 49 active-named resort plists + 2 `.plist.disabled`) → loaded (43 resort jobs + `ai.openclaw.gateway` = 44) → running processes (E-QC1INV-12). Fresh-render caveat: rendered plists embed the rendering host's node path (`__NODE_BIN__` = `process.execPath`), so node-path lines are environment-sensitive in diffs.

| Job label (com.lapuestadelsolresort.*) | Schedule | RunAtLoad | Program |
|---|---|---|---|
| ai.openclaw.gateway | keepalive | RA | ai.openclaw.gateway-env-wrapper.sh ai.openclaw.gateway.env node |
| chroma-heartbeat | every 300s | RA | bash chroma-heartbeat.sh |
| chroma | keepalive | RA | bash chroma-server.sh |
| crm-audience-sync | cal:Hour=7,Minute=0 | - | node workflow-trigger.js meta.audience.sync |
| crm-backup | cal:Hour=3,Minute=15 | RA | python3 crm_backup.py |
| crm-heartbeat | every 300s | RA | bash crm-heartbeat.sh |
| crm | keepalive | RA | node server.js |
| daily-report | cal:Hour=7,Minute=30 | - | node workflow-trigger.js marketing.report.daily |
| daily-tests | cal:Hour=6,Minute=30 | - | bash daily-test-suite.sh |
| gmail-reply-forwarder | every 300s | - | node gmail-reply-forwarder.js |
| graph-accounting-inbox | every 300s | - | node accounting-inbox.js |
| graph-crm-sync | every 900s | RA | node workflow-trigger.js ownerrez.crm.sync |
| graph-paulina-prepare | cal:Hour=8,Minute=30 | - | node workflow-trigger.js paulina.prepare_daily |
| graph-paulina | every 300s | RA | node workflow-trigger.js paulina.daily |
| graph-receipt-reconcile | every 3600s | RA | node workflow-trigger.js receipt.reconcile |
| graph-regina | cal:Hour=7,Minute=30 | - | node workflow-trigger.js regina.daily |
| graph-social-publish | every 300s | - | node workflow-trigger.js social.publish_due |
| graph-social-routine | cal:Hour=8,Minute=0 | - | node workflow-trigger.js social.publish_routine |
| graph-squarespace-sync | every 300s | RA | node workflow-trigger.js squarespace.crm.sync |
| gtku | cal:Hour=8,Minute=0 | - | bash gtku-daily.sh |
| job-watchdog | cal:Hour=9,Minute=0 | - | python3 job_watchdog.py |
| kapital-tests | cal:Hour=8,Minute=0,Weekday=1 | - | bash run_weekly_tests.sh |
| log-rotation | cal:Hour=2,Minute=30,Weekday=0 | RA | python3 rotate_logs.py |
| lp-phase-gate | cal:Hour=8,Minute=0 | RA | python3 lp_phase_gate.py |
| marketing-reconcile | cal:Hour=6,Minute=30 | - | python3 reconcile_marketing_state.py |
| media-corpus-indexer | cal:Hour=8,Minute=20 | - | bash index-media-corpus.sh |
| media-rescan | cal:Hour=7,Minute=45,Weekday=1 | - | bash rescan-sarah.sh |
| meta-capi-retry | every 900s | RA | node retry-meta-capi.js |
| orchestrator | every 300s | - | node orchestrator.js |
| ownerrez-message-ingest | cal:Hour=6,Minute=30 | - | node ownerrez-message-ingest.js |
| ownerrez-sync | every 900s | - | node ownerrez-sync.js |
| ownerrez-weekly-calendar | cal:Hour=8,Minute=0,Weekday=1 | - | node ownerrez-weekly-calendar.js |
| prospector-daily | cal:Hour=8,Minute=30 | - | bash daily-prospecting.sh |
| qbo-keepalive | cal:Hour=4,Minute=0,Weekday=3 | - | bash qbo-token-keepalive.sh |
| regina-anniversary | cal:Hour=9,Minute=0 | - | node anniversary-cron.js |
| regina-reconcile | cal:Hour=10,Minute=0 | - | node gmail-reconcile.js |
| restore-drill | cal:Hour=5,Minute=30,Weekday=2 | - | python3 backup_restore_drill.py |
| squarespace-report | every 600s | - | node squarespace-report.js --all |
| squarespace-sync | every 300s | RA | node squarespace-sync.js --json |
| stale-draft-sweep | cal:Hour=9,Minute=0 | - | bash sweep-stale-drafts.sh |
| telmex-check | cal:Day=1,Hour=9,Minute=0 | - | bash telmex-check.sh |
| tracker-liveness | cal:Hour=7,Minute=0 | - | python3 tracker-liveness-test.py |
| tracking-health | cal:Hour=6,Minute=45 | - | python3 tracking-health-check.py |
| tunnel-heartbeat | every 300s | RA | bash tunnel-heartbeat.sh |
| tunnel | keepalive | RA | bash start-tunnel.sh |
| voice-corpus-indexer | cal:Hour=8,Minute=15 | - | bash index-voice-corpus.sh |
| warmup-daily | cal:Hour=8,Minute=30 | - | bash warmup-daily.sh |
| weekly-tracking-audit | cal:Hour=7,Minute=0,Weekday=1 | - | python3 weekly-tracking-audit.py |
| workflow-health | every 300s | RA | python3 workflow_health.py |
| workflow-worker | keepalive | RA | node workflow-worker.js |

- 10 `graph-*` jobs invoke `crm/scripts/workflow-trigger.js <workflow>` (mapping in §1, last column) — the sanctioned scheduled producers of the durable control plane.
- **Dormant legacy producers** (installed, not loaded — consistent with `workflow/CUTOVER.md` §3 replacement map; intentionally dormant per plan): `gtku`, `orchestrator`, `ownerrez-sync`, `prospector-daily`, `regina-anniversary`, `squarespace-sync` (E-QC1INV-19). All six graph replacements are loaded.
- Disabled remnants: `meta-insights.plist.disabled`, `warmup-daily.plist.disabled` (an *active* `warmup-daily.plist` is also loaded) — hygiene, QC-1b.
- **Outside canonical template set** (installed, no template, no generated copy): `kapital-tests`, `qbo-keepalive` → F-016 half A. **Templated but not installed:** `paloma-followup`, `paloma-scan`, `paloma-summary` (present in templates and in deploy-generated output) → F-016 half B. Validation and ownership = QC-1b.
- `~/Library/LaunchAgents/socialsol-backups/` holds timestamped installer `.bak` plists (deploy-installer artifact).
- Keepalive daemons: `crm` (server.js), `workflow-worker`, `chroma`, `tunnel` (cloudflared `lapuestadelsol-crm`), plus gateway.
- Freshness: newest deployment record `2026-08-15T21:39:17Z` targets `2983ed0…` (completed, 9 steps); server started 14:39:59, worker 14:40:00, gateway 14:42:13 PDT — all after the deploy. The goldroute CRM process runs from the outer agent home (separate venture, F-023).

## 3. HTTP surface — `crm/server.js` is the only production listener

- ~66 direct routes + 10 mounted routers (38 sub-routes): voice(1), media(9), landing(3), track(1), lp(2), ownerrez(2), squarespace(6), whatsapp(6), workflows(4), quickbooks(4). Full generated list: E-QC1INV-04.
- Inbound webhooks: `/webhook/twilio-whatsapp`, `/webhook/meta` (GET verify + POST), `/webhook/resend`, `/webhook/resend-reply` (loopback-only), `/webhook/calcom`, `/webhook/attribution` (loopback-only), `/webhook/inquiry` + `/webhook/pixel` (browser-source-gated, rate-limited), `/unsubscribe` (GET/POST, rate-limited), `/healthz`.
- Retired path: `POST /api/meta-dm/reply` → hard 410 stub (`crm/server.js:2655`, commit 4cad390).
- Middleware observed (semantics = QC-2): `guardProtected`, `requireLoopback`, `requireBrowserSource`, per-route rate limiters, 128kb JSON body cap with raw-body capture for signature verification.

## 4. Slack command surfaces (gateway plugins → control plane)

| Surface | Exact syntax (from parser) | Target |
|---|---|---|
| WhatsApp reply | `!wa <message>` in inbound thread, or `!wa <dm-id> <message>` | `whatsapp.reply` (trigger `slack_whatsapp_command`) |
| Meta DM reply | `!dm <dm-id> <message>` | quarantined — exact shadow refusal before any control-plane call (F-020) |
| Email | `!email reply <msg>` (thread) · `!email confirm <uuid36> <hash12>` (anywhere in channel; D-011 ratified) · `!email classify <event-id> hot\|not_interested\|ambiguous` (thread) | `email.reply.propose` / `email.reply.confirm` / `email.message.classify` |
| Marketing | `!meta confirm <uuid36> <hash12>` | `marketing.change.confirm` |
| Manual review | `!review resolve <uuid36> sent <ref>` · `… not-sent` · `… abandon` | control-plane manual-review resolve API |
| Receipts (owner expense) | `!receipt confirm [expense] <uuid36> <date> <MXN\|USD> <amt> <category> \| <vendor> [\| <desc>]` · `!receipt confirm repayment …` | `receipt.owner_expense.confirm` |
| OwnerRez | `!ownerrez confirm <uuid36> <hash8-12>` | `ownerrez.mutation.confirm` |

Parsers: `openclaw-plugins/resort-workflows/index.js:836–961`. Additional Slack-facing intake: receipt attachment hooks (`slack_receipt_hook` → `receipt.ingest` / `receipt.owner_expense.ingest`) and payment-source buttons (`slack_receipt_source_action`). Regina manual commands are CLI scripts `regina/scripts/{sent,skip,defer}.js`. The `owner-cash-flow` plugin matches natural-language cash-flow questions (`isOwnerCashFlowQuestion`) and execs `crm/scripts/owner-cash-flow.js` inside the agent workspace (QC-5 owns its writable-open side effect). Paloma is a separate OpenClaw agent identity (QC-9).

## 5. Providers and authorities

Endpoint map (generated host extraction, E-QC1INV-05): Meta `graph.facebook.com` (marketing, CAPI; DM path quarantined) · Twilio `api.twilio.com` (WhatsApp) · Resend `api.resend.com` · Gmail `www.googleapis.com` · Intuit `quickbooks.api.intuit.com` + `oauth.platform.intuit.com` (sandbox host present in code) · OwnerRez `api.ownerrez.com` · Squarespace `api.squarespace.com` · Postiz `api.postiz.com` · Slack `slack.com` · ZeroBounce `api.zerobounce.net` · Banxico `www.banxico.org.mx` (contractual FX) with `api.exchangerate-api.com` fallback (QC-4 checks the contract) · OpenAI `api.openai.com` (embeddings) · Anthropic `api.anthropic.com` · Brave `api.search.brave.com` · own domains `webhook.lapuestadelsolresort.com`, `planners.lapuestadelsolresort.com`, `wa.me`.

Authorities (plan §2): OwnerRez = bookings/occupancy (CRM sync contact-only). Squarespace = direct commerce only. Kapital/QBO = bank/books. Meta = campaign state and spend. Resend/Gmail = email dispatch/mailbox truth. Twilio = WhatsApp transport states. Slack = command surface, never provider truth.

## 6. CLI entrypoints

49 npm scripts (E-QC1INV-06), by side-effect class:

- Local RO checks/tests/builds (24): `test*`, `check:*`, `eval:*`, `audit:production`, `build:landing`, `validate:openclaw-shadow`.
- Config writers: `configure:*` (7), `setup:workflow-token`, `init:runtime`.
- Renderers: `render:launchagents` / `render:openclaw-policy` — verified to write only their output dir (default `deploy/launchagents/generated`; `--output` honored, code-traced this session).
- Explicit-switch-gated production mutations: `release:deploy`, `cutover:social-autonomy`, `cutover:email-replies`, `cutover:sarah-email` (all `--confirm-production`); `apply:openclaw-shadow`, `install:shadow-services` (both `--confirm-shadow`). `release:check` is the RO half.
- Maintenance/reconciliation: `reconcile:*` (4), `migrate:squarespace`, `sync:squarespace`, `report:squarespace`, `report:owner-cash-flow`.
- Control plane: `workflow:worker` / `workflow:once` (durable worker); `workflow:trigger` POSTs `/api/workflows/execute` with bearer control token + bucketed idempotency key — mutation-capable by design, gated by token+policy rather than a CLI switch; its sanctioned invokers are the 10 `graph-*` launchd jobs.

Vertical script surfaces (file counts, E-QC1INV-07): `scripts/` 30 · `crm/scripts/` 42 · `automation/` 39 · `accounting/` 17 · `prospector/scripts` 8 · `regina/scripts` 6 · `paloma/scripts` 5 · `sarah-coach/scripts` 2 · `warmup/scripts` 1 (~150 total). Per-command deep side-effect traces (token refresh, local/external writes, notifications) are owned by their vertical phases (QC-4…QC-9) per the phase split; this inventory records the surface and the gating observed.

## 7. OpenClaw gateway (shared agent home)

- Config `~/.openclaw/openclaw.json`: sha256 `4754ce5a530ec8c2…`, mode 600, mtime 14:41 (the F-020 apply). Structure-only extraction; no token fields read.
- Plugin entries (9, all enabled): anthropic, brave, browser, codex, openai, slack, telegram, owner-cash-flow, resort-workflows. Both SocialSol plugins load from production root `openclaw-plugins/`.
- `resort-workflows` runtime state: enabled, `shadowMode=true`, `liveWorkflowNames=32` — matches the quarantined policy.
- Agents and bindings: `resort` + `paloma` (SocialSol) bind to **Slack accounts only**; `goldroute`, `llvrads` → Slack; `erate` → telegram. The enabled telegram channel has accounts configured but **zero references in the SocialSol repo** and no SocialSol agent binding → other-venture transport in the shared agent home (F-023 context), not a SocialSol transport; shared-gateway identity-binding isolation is a QC-2 input. D-002 not implicated on current evidence.
- No gateway cron entries — all scheduling is launchd.

## 8. Data stores

| Store | Path (under production root) | State |
|---|---|---|
| CRM DB (live) | `crm/data/crm.db` | 142 MB, mode 600, WAL active; single open inode across server+worker (QC0-07 / T3) |
| Paloma tasks (live) | `paloma/data/tasks.db` | 69 KB, mode 600, fresh mtime |
| **Stray** | `crm/data/resort-crm.db` | **0 bytes, created 2026-08-14 (deploy day)** — unexplained default-path artifact → QC-3 path-contract input (F-006 family) |
| Snapshot | `crm/data/crm-pre-paulina-scale-20260809.db` | has stale `-wal`/`-shm` siblings — file-copy-while-WAL pattern flagged by §4.4 → QC-3 |
| Snapshots | `crm/data/backups/{pre-meta-capi-repair-20260809, pre-owner-cash-flow-20260810, qc-conversion-semantics-20260807}.db` | cold copies |
| Snapshot | `runtime/config-backups/paloma-tasks.pre-checkpoint-rewind.2026-08-13.db` | cold copy |
| Chroma | server `127.0.0.1:8000`; venv `chroma-venv/`, data `chroma-data/` | collections: `contacts`, `media_corpus`, `sarah_voice_corpus`; rebuild path documented in `crm/scripts/chroma-server.sh` (~$0.003 from `sarah_voice_corpus`) — QC-3 verifies |
| Encrypted backups | `backups/resort-crm/crm-*.db.gz.enc` | daily 03:15 + deploy-triggered; latest 2026-08-15 14:39; mode 600; sqlite `mode=ro` verify; offsite via `gog drive upload`; retention prune. RPO/RTO + offsite retrieval = QC-3 (D-006) |

## 9. Runtime configs (fingerprints only; contents never in Git)

| File | Mode | Size | sha256 (16) |
|---|---|---|---|
| `workflow/policy.json` | 600 | 7434 | `32c2bdfe1edefe48` |
| `paloma/config.json` | 644 | 323 | `18e6373eb777e48a` |
| `prospector/config.json` | 600 | 2960 | `1408b36a060bab03` |
| `regina/config.json` | 600 | 1492 | `99326eefd2fad673` |
| `squarespace/config.json` | 644 | 680 | `ed9e0c7a8ca79475` |
| `warmup/state.json` | 644 | 251 | `1b21a68c100693ba` |
| `warmup/recipients.json` | 644 | 980 | `cd9da8568d4a36c7` |
| `accounting/config.json` | 600 | 12578 | `93adf49eb9ad329f` |

`campaigns/registry.json` is ABSENT on disk — the campaign registry lives in the CRM DB (QC0-12 observed 7 active records) → QC-6 reconciles committed briefs ↔ DB registry ↔ provider.

## 10. Secrets locations (names + modes only; contents never read)

26 files in `secrets/` (E-QC1INV-17). All mode 600 except **`anthropic_vocabgen.json` (644)** → QC-2 mode-audit input. Stray backup copy `healthchecks.json.bak-pre-goldroute` → QC-2 hygiene. Control-plane token at `secrets/workflow-control.json`; `quickbooks-dev.json` (sandbox) present alongside `quickbooks.json`.

## 11. Alert destinations

- Healthchecks.io: per-job ping slugs in `secrets/healthchecks.json` (aliased); 17 scripts wire pings via `crm/scripts/healthcheck-ping.sh` or `automation/job_health.py` (E-QC1INV-18).
- `automation/job_watchdog.py` (daily 9:00): 8 expected slugs — tracking-health 30h, weekly-tracking-audit 8d, marketing-reconcile 30h, lp-phase-gate 30h, crm-backup 30h, crm-restore-drill 8d, workflow-health 15m, log-rotation 8d — alerting to a Slack channel (aliased `OPS`) via the gateway CLI. **F-015 (validated P1): `daily-tests`, `tracker-liveness`, `media-rescan` are outside this set and last-exited 1.**
- `workflow_health.py` every 300s (control-plane health → Healthchecks + Slack).
- Slack alert-channel env placeholders in templates: `__RESORT_OPS_ALERTS_CHANNEL__`, `__TRACKING_QC_CHANNEL__`, etc. (channel IDs aliased; raw values only in evidence copies).

## 12. Annotations handed forward

1. **QC-1b:** formalize the convergence diff — fresh render (50) vs deploy-generated (51) vs installed (49 + 2 `.disabled`) vs loaded (43+gateway); name every delta (paloma trio templated-not-installed; kapital-tests/qbo-keepalive installed-without-template; warmup-daily active+disabled twin; NODE_BIN caveat); then the versioned service manifest + F-015/F-016 validation and remediation ownership.
2. **QC-1b:** `email.message.observe` autonomy drift (policy-autonomous, not live, registry says non-autonomous).
3. **QC-2:** secrets mode 644 (`anthropic_vocabgen.json`), stray `healthchecks.json.bak-pre-goldroute`; shared-gateway identity-binding isolation (SocialSol agents Slack-only; telegram bound to another venture's agent).
4. **QC-3:** 0-byte `crm/data/resort-crm.db` (deploy-day artifact); `crm-pre-paulina-scale` snapshot with stale WAL/SHM siblings; offsite retrieval + RPO/RTO per store.
5. **QC-6:** `marketing.report.daily` mutates under a read capability; campaign registry lives in DB, not in a committed file.
