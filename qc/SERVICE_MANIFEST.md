# SocialSol service manifest — QC-1b (generated)

Generated 2026-08-15 (PDT) at deployed SHA `2983ed0` by a script parsing the
installed/rendered plists, fresh `launchctl` state, `workflow/CUTOVER.md` §3,
`automation/job_watchdog.py` EXPECTED, and per-script healthchecks wiring.
Never handwritten; regenerate on any service change. Raw artifact incl. env
values: `~/qc-evidence/QC1B/08-service-manifest.tsv` (channel IDs stay there;
this file lists env var NAMES only). TZ for all calendar schedules:
America/Los_Angeles (host TZ; no plist sets TZ).

Columns: Expected = intended state per CUTOVER/policy/installer evidence;
Convergence = installed file vs deploy-rendered file at 2983ed0;
Alert = watchdog slug/max-age, script-level healthchecks ping, Slack channel
env presence; Criticality = proposed rubric (owner ratifies at sign-off, D-007).

| Service | Sched (local) | Script (repo-rel) | Env contract | Expected state | Actual (2026-08-15 15:38 PDT) | Convergence | Alert owner | QC owner | Crit |
|---|---|---|---|---|---|---|---|---|---|
| chroma | keepalive | crm/scripts/chroma-server.sh ⚠tmp-logs | - | RUNNING (keepalive) | loaded pid=6986 lastexit=0 | identical | NONE | QC-3 — vector store server | MEDIUM |
| chroma-heartbeat | every 300s | crm/scripts/chroma-heartbeat.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-3 — chroma monitor | LOW |
| crm | keepalive | crm/server.js | GMAIL_IMPERSONATE_USER, OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, RESORT_SOCIAL_CHANNEL, RESORT_WHATSAPP_CHANNEL, SOCIALSOL_ROOT | RUNNING (keepalive) | loaded pid=89370 lastexit=-15 | DIFFERS-from-render | script-ping; Slack env | QC-2/QC-8 — serving core (HTTP+webhooks+Slack) | CRITICAL |
| crm-audience-sync | cal:Hour=7,Minute=0 | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-6 — Meta audience sync (write) | HIGH |
| crm-backup | cal:Hour=3,Minute=15 | automation/crm_backup.py | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-crm-backup/30h; script-ping | QC-3 — encrypted DB backup + offsite | CRITICAL |
| crm-heartbeat | every 300s | crm/scripts/crm-heartbeat.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-3 — crm liveness ping | MEDIUM |
| daily-report | cal:Hour=7,Minute=30 | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-6 — daily marketing report | MEDIUM |
| daily-tests | cal:Hour=6,Minute=30 | scripts/daily-test-suite.sh | OPENCLAW_SLACK_ACCOUNT | LOADED-SCHEDULED | loaded pid=- lastexit=1 | DIFFERS-from-render | NONE | QC-2/QC-3 (F-017) — daily test suite | MEDIUM |
| gmail-reply-forwarder | every 300s | crm/scripts/gmail-reply-forwarder.js | GMAIL_IMPERSONATE_USER, OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, SARAH_EMAIL_SLACK_CHANNEL, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | Slack env | QC-8 — gmail reply forwarder | HIGH |
| graph-accounting-inbox | every 300s | crm/scripts/accounting-inbox.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-4 — accounting inbox intake | CRITICAL |
| graph-crm-sync | every 900s | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-9 — OwnerRez CRM sync workflow | HIGH |
| graph-paulina | every 300s | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-7 — Paulina send workflow | CRITICAL |
| graph-paulina-prepare | cal:Hour=8,Minute=30 | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-7 — Paulina daily prepare | HIGH |
| graph-receipt-reconcile | every 3600s | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-4 — receipt reconcile workflow | CRITICAL |
| graph-regina | cal:Hour=7,Minute=30 | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-7 — Regina send workflow | CRITICAL |
| graph-social-publish | every 300s | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-6 — social publish dispatcher | CRITICAL |
| graph-social-routine | cal:Hour=8,Minute=0 | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-6 — daily social routine | CRITICAL |
| graph-squarespace-sync | every 300s | crm/scripts/workflow-trigger.js | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-5 — Squarespace sync workflow | HIGH |
| gtku | cal:Hour=8,Minute=0 | crm/scripts/gtku-daily.sh | GTKU_GOOGLE_ACCOUNT, POSTIZ_INTEGRATION_ID, SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | DORMANT (replaced by graph-social-routine) | not loaded | identical | script-ping | QC-6 — legacy GTKU social | LOW |
| job-watchdog | cal:Hour=9,Minute=0 | automation/job_watchdog.py | OPENCLAW_SLACK_ACCOUNT, RESORT_SOCIAL_CHANNEL | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping; Slack env | QC-3 — job staleness alerts | HIGH |
| kapital-tests | cal:Hour=8,Minute=0,Weekday=1 | accounting/run_weekly_tests.sh ⚠tmp-logs | - | LOADED (ungoverned: no template) | loaded pid=- lastexit=0 | NO-TEMPLATE (hand-installed) | NONE | QC-4 (F-014) — weekly accounting integrity tests | HIGH |
| log-rotation | cal:Hour=2,Minute=30,Weekday=0 | automation/rotate_logs.py | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-log-rotation/8d; script-ping | QC-3 — log rotation | LOW |
| lp-phase-gate | cal:Hour=8,Minute=0 | automation/lp_phase_gate.py | OPENCLAW_SLACK_ACCOUNT, RESORT_SOCIAL_CHANNEL | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-lp-phase-gate/30h; script-ping; Slack env | QC-6 — landing-page phase gate | MEDIUM |
| marketing-reconcile | cal:Hour=6,Minute=30 | automation/reconcile_marketing_state.py | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-marketing-reconcile/30h; script-ping | QC-6 — marketing state reconcile | MEDIUM |
| media-corpus-indexer | cal:Hour=8,Minute=20 | media/scripts/index-media-corpus.sh ⚠symlink→OUTER(workspace-resort) | SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-10 — media corpus indexer | LOW |
| media-rescan | cal:Hour=7,Minute=45,Weekday=1 | media/scripts/rescan-sarah.sh ⚠symlink→OUTER(workspace-resort) | SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=1 | identical | NONE | QC-10 — Sarah media rescan | LOW |
| meta-capi-retry | every 900s | crm/scripts/retry-meta-capi.js | SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | NONE | QC-6 — CAPI retry queue | HIGH |
| orchestrator | every 300s | prospector/orchestrator.js | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT | DORMANT (replaced by graph-paulina) | not loaded | identical | script-ping | QC-7 — legacy outreach orchestrator | LOW |
| ownerrez-message-ingest | cal:Hour=6,Minute=30 | crm/scripts/ownerrez-message-ingest.js ⚠tmp-logs | SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded pid=- lastexit=0 | DIFFERS-from-render | NONE | QC-9 — OwnerRez message ingest | HIGH |
| ownerrez-sync | every 900s | crm/scripts/ownerrez-sync.js ⚠tmp-logs | OPENCLAW_BIN, OPENCLAW_SLACK_ACCOUNT, RESORT_BIZEVENT_CHANNEL, SOCIALSOL_SECRETS_DIR | DORMANT (replaced by graph-crm-sync) | not loaded | DIFFERS-from-render | Slack env | QC-9 — legacy OwnerRez sync | LOW |
| ownerrez-weekly-calendar | cal:Hour=8,Minute=0,Weekday=1 | crm/scripts/ownerrez-weekly-calendar.js ⚠tmp-logs | OPENCLAW_BIN, OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded pid=- lastexit=0 | DIFFERS-from-render | NONE | QC-9 — weekly ops calendar | MEDIUM |
| prospector-daily | cal:Hour=8,Minute=30 | prospector/scripts/daily-prospecting.sh | OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, SOCIALSOL_ROOT | DORMANT (replaced by graph-paulina-prepare) | not loaded | identical | Slack env | QC-7 — legacy prospector | LOW |
| qbo-keepalive | cal:Hour=4,Minute=0,Weekday=3 | scripts/qbo-token-keepalive.sh ⚠tmp-logs | - | LOADED (ungoverned: no template) | loaded pid=- lastexit=0 | NO-TEMPLATE (hand-installed) | NONE | QC-4 — QBO OAuth token refresh (credential mutation) | CRITICAL |
| regina-anniversary | cal:Hour=9,Minute=0 | regina/scripts/anniversary-cron.js | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT | DORMANT (replaced by graph-regina) | not loaded | identical | script-ping | QC-7 — legacy anniversary cron | LOW |
| regina-reconcile | cal:Hour=10,Minute=0 | regina/scripts/gmail-reconcile.js | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-7 — Regina gmail reconcile | MEDIUM |
| restore-drill [installer-managed] | cal:Hour=5,Minute=30,Weekday=2 | automation/backup_restore_drill.py | SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-crm-restore-drill/8d; script-ping | QC-3 — weekly restore drill | HIGH |
| squarespace-report | every 600s | crm/scripts/squarespace-report.js | OPENCLAW_SLACK_ACCOUNT, RESORT_ACCOUNTING_CHANNEL, RESORT_BIZEVENT_CHANNEL, RESORT_HOUSEKEEPING_CHANNEL, RESORT_RESERVATIONS_CHANNEL, SQUARESPACE_SLACK_ENABLED | LOADED-SCHEDULED | loaded pid=- lastexit=0 | DIFFERS-from-render | Slack env | QC-5 — Squarespace report | MEDIUM |
| squarespace-sync | every 300s | crm/scripts/squarespace-sync.js | SOCIALSOL_SECRETS_DIR | DORMANT (replaced by graph-squarespace-sync) | not loaded | identical | NONE | QC-5 — legacy Squarespace sync | LOW |
| stale-draft-sweep | cal:Hour=9,Minute=0 | prospector/scripts/sweep-stale-drafts.sh | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-8 — stale draft sweep | MEDIUM |
| telmex-check | cal:Day=1,Hour=9,Minute=0 | scripts/telmex-check.sh | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | DIFFERS-from-render | NONE | QC-10 — ISP bill check | LOW |
| tracker-liveness | cal:Hour=7,Minute=0 | scripts/tracker-liveness-test.py | OPENCLAW_SLACK_ACCOUNT, TRACKING_QC_CHANNEL | LOADED-SCHEDULED | loaded pid=- lastexit=1 | DIFFERS-from-render | script-ping; Slack env | QC-6 (F-019) — tracker liveness probe | MEDIUM |
| tracking-health | cal:Hour=6,Minute=45 | scripts/tracking-health-check.py | OPENCLAW_SLACK_ACCOUNT, TRACKING_QC_CHANNEL | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-tracking-health/30h; script-ping; Slack env | QC-6 — tracking health check | MEDIUM |
| tunnel | keepalive | crm/scripts/start-tunnel.sh ⚠tmp-logs | - | RUNNING (keepalive) | loaded pid=29280 lastexit=0 | identical | NONE | QC-3 — webhook ingress tunnel | CRITICAL |
| tunnel-heartbeat | every 300s | crm/scripts/tunnel-heartbeat.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-3 — tunnel monitor | HIGH |
| voice-corpus-indexer | cal:Hour=8,Minute=15 | crm/scripts/index-voice-corpus.sh | - | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping | QC-10 — voice corpus indexer | LOW |
| warmup-daily | cal:Hour=8,Minute=30 | warmup/scripts/warmup-daily.sh | OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | script-ping; Slack env | QC-7 — email warmup | MEDIUM |
| weekly-tracking-audit | cal:Hour=7,Minute=0,Weekday=1 | scripts/weekly-tracking-audit.py | OPENCLAW_SLACK_ACCOUNT, TRACKING_QC_CHANNEL | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-weekly-tracking-audit/8d; script-ping; Slack env | QC-6 — weekly tracking audit | MEDIUM |
| workflow-health [installer-managed] | every 300s | automation/workflow_health.py | OPENCLAW_SLACK_ACCOUNT, RESORT_OPS_ALERTS_CHANNEL, SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded pid=- lastexit=0 | identical | watchdog:resort-workflow-health/15m; script-ping; Slack env | QC-3 — control-plane health | HIGH |
| workflow-worker [installer-managed] | keepalive | crm/scripts/workflow-worker.js | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | RUNNING (keepalive) | loaded pid=89376 lastexit=0 | identical | NONE | QC-2 — durable control plane | CRITICAL |
| meta-insights (.disabled) | cal:Hour=7,Minute=45 | automation/meta_daily_insights.py | OPENCLAW_SLACK_ACCOUNT, RESORT_SOCIAL_CHANNEL | DISABLED (coherent) | not loaded | disabled at all 4 layers | script-ping; Slack env | QC-6 — meta insights (disabled) | LOW |
| warmup-daily (.disabled) | cal:Hour=8,Minute=30 | OUTER:workspace-resort/warmup/scripts/warmup-daily.sh | - | REMNANT (active twin loaded) | not loaded | stale .disabled twin | script-ping | QC-7 — email warmup | MEDIUM |
| paloma-followup | cal:Hour=8,Minute=0,Weekday=1 | paloma/scripts/weekly-followup.sh | - | UNDETERMINED (owner: install or retire) | not installed | RENDERED-NOT-INSTALLED | NONE | QC-9 — Paloma followups (scheduled half) | MEDIUM |
| paloma-scan | every 14400s | paloma/scripts/scan-channels.sh | - | UNDETERMINED (owner: install or retire) | not installed | RENDERED-NOT-INSTALLED | NONE | QC-9 — Paloma channel scan/reconcile | MEDIUM |
| paloma-summary | cal:Hour=9,Minute=0,Weekday=1 | paloma/scripts/weekly-summary.sh | - | UNDETERMINED (owner: install or retire) | not installed | RENDERED-NOT-INSTALLED | NONE | QC-9 — Paloma weekly summary | MEDIUM |
| ai.openclaw.gateway | keepalive | OUTER:service-env/ai.openclaw.gateway-env-wrapper.sh | - | RUNNING (keepalive) | loaded pid=89734 lastexit=0 | out-of-scope (OpenClaw runtime) | NONE | QC-2 — OpenClaw gateway (Slack agents) | CRITICAL |

## Convergence deltas (named, complete)

Layer counts at 2983ed0: 50 active templates + 1 `.template.disabled` → 50
fresh-rendered → 51 deploy-generated (incl. `meta-insights.plist.disabled`) →
49 installed active + 2 installed `.disabled` → 43 loaded + `ai.openclaw.gateway`.
The release pipeline (scripts/production-release.js) renders and restarts only
`crm`+`workflow-worker`; the sanctioned installer (`install:shadow-services`)
manages exactly 3 labels (workflow-worker, workflow-health, restore-drill).
Every other installed plist was placed by hand.

1. Installed-with-no-template (hand-installed, invisible to release path):
   `kapital-tests` (F-014 weekly accounting control, Mon 08:00, logs to /tmp),
   `qbo-keepalive` (QBO credential mutation, Wed 04:00, logs to /tmp). → F-016A
2. Rendered-every-deploy but never installed: `paloma-followup`, `paloma-scan`,
   `paloma-summary` — no installer covers them; Paloma event-driven path is live
   (tasks.db written this session) but the scheduled scan/followup/summary half
   has no producer. → F-016B, owner decision pending
3. Installed ≠ rendered, installed AHEAD (re-install would REGRESS production):
   `crm` (installed adds WhatsApp channel env the template lacks),
   `squarespace-report` (installed enables Slack posting + 2 channel envs;
   template has it disabled/empty).
4. Installed ≠ rendered, template AHEAD (rendered improvements never installed):
   `daily-tests` (template adds WorkingDirectory + accounting channel; missing
   WorkingDirectory is the F-015 failure mechanism), `tracker-liveness`
   (template adds WorkingDirectory), `ownerrez-message-ingest`,
   `ownerrez-weekly-calendar` (installed lacks reservations-channel env, logs to
   /tmp), `ownerrez-sync` (dormant), `telmex-check`.
5. Channel-binding drift inside env values (see raw TSV): template vs installed
   bizevent channel differs in `ownerrez-sync` and `squarespace-report`.
6. Loaded plist definitions sourced OUTSIDE the repo via symlink into the dirty
   outer repo (`workspace-resort/media/launchagents/`): `media-corpus-indexer`,
   `media-rescan`. Executed scripts are nested-repo; the *definitions* are not
   release-controlled.
7. Disabled remnants: `meta-insights` (.disabled coherently at all 4 layers —
   intentional); `warmup-daily.plist.disabled` (2026-05-01 remnant pointing at
   OUTER workspace-resort code; an active nested-repo twin is loaded) — delete.
8. Dormant legacy producers exactly per CUTOVER §3 (intentional, PASS):
   gtku, orchestrator, ownerrez-sync, prospector-daily, regina-anniversary,
   squarespace-sync; all six graph replacements loaded.
9. NODE_BIN fragility: renders embed `process.execPath` — the Cellar-versioned
   node path (`/opt/homebrew/Cellar/node/25.6.0/bin/node`) now baked into most
   loaded node jobs. A `brew upgrade node` + cleanup breaks every such job at
   next start until a re-render+reinstall; hand-installed ownerrez pair uses
   stable `/opt/homebrew/bin/node` instead.
10. Template-designed /tmp logging on: chroma, chroma-heartbeat, crm-heartbeat,
    tunnel, tunnel-heartbeat (+ hand-installed kapital-tests, qbo-keepalive,
    ownerrez trio) — outside repo log rotation. → QC-3.

## F-023 launchd convergence proof (this session)

All 43 loaded `com.lapuestadelsolresort.*` jobs execute scripts resolving into
`~/.openclaw/SocialSol` (43/43, fresh capture E-QC1B-01/03/08). The only loaded
non-resort SocialSol-relevant job is `ai.openclaw.gateway`: OpenClaw runtime
(agent-home env wrapper + global npm openclaw) loading SocialSol plugins from
the nested repo (E-QC1INV-16, INVENTORY §7). Co-tenant launchd jobs in
`~/Library/LaunchAgents` (recorded, out of QC scope): 12 goldroute (separate
venture, outer agent home), 2 maya autosync, claude-max-api, Google updater ×3,
homebrew ollama. No SocialSol effect executes outer-repo code via launchd.

## Fresh-state attribution notes (2026-08-15 session, not generated)

- `crm` last exit −15 = SIGTERM from the deploy's `launchctl kickstart -k` of the
  prior instance; current PID 89370 started 2026-08-15 14:39:59 PDT by the deploy
  (E-QC1B-12). Not a crash.
- Keepalive daemons `chroma` (PID 6986) and `tunnel` (PID 29280) started 2026-08-07 —
  expected: the release pipeline restarts only `crm`+`workflow-worker`; the gateway
  (PID 89734, 14:42:13) was restarted by the owner-authorized F-020 reload.
- `paloma/data/tasks.db` was written at 15:40 PDT this session with no launchd paloma
  job installed → the event-driven gateway path is the live Paloma producer; exact
  writer identification belongs to QC-9.

