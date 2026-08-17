# SocialSol service manifest — regenerated fix session #1 (2026-08-17)

Generated 2026-08-17 (PDT) at deployed SHA `b7b0b07` by
`~/qc-evidence/FIX1/gen-service-manifest.py` parsing the repo's authoritative
`deploy/launchagents/service-manifest.json` (new this session), installed
plists, and fresh `launchctl` state, carrying QC-owner/criticality annotations
from the 2026-08-15 generation. Never handwritten; regenerate on any service
change. Raw prior-generation artifact: `~/qc-evidence/QC1B/08-service-manifest.tsv`;
this session's evidence: `~/qc-evidence/FIX1/`. TZ for calendar schedules:
America/Los_Angeles (host TZ).

**The service layer is now release-governed (F-016 closure):** the repo file
`deploy/launchagents/service-manifest.json` is the machine-read authority
(48 loaded / 1 disabled / 6 retired); `npm run install:launchagents` is the
single sanctioned install path (render → diff → backup → atomic install →
bootout/bootstrap; retired = removed + launchd disable override);
`release:deploy` runs install + a convergence check as pipeline steps; the
daily watchdog derives its EXPECTED set from the same file and alerts on any
loaded-set divergence (resurrection detection, F-041).

Columns: Expected = intended state per the repo service manifest;
Actual/Convergence = fresh capture at generation time; Alert = watchdog
slug/max-age from the repo manifest + script-level healthchecks ping + Slack
env presence; Criticality = proposed rubric (owner ratifies at sign-off, D-007).

| Service | Sched (local) | Script (repo-rel) | Env contract | Expected state | Actual (2026-08-17 PDT) | Convergence | Alert owner | QC owner | Crit |
|---|---|---|---|---|---|---|---|---|---|
| chroma | keepalive | crm/scripts/chroma-server.sh ⚠tmp-logs | - | RUNNING (keepalive) | loaded | converged (installed==rendered) | NONE | QC-3 — vector store server | MEDIUM |
| chroma-heartbeat | every 300s | crm/scripts/chroma-heartbeat.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-3 — chroma monitor | LOW |
| crm | keepalive | crm/server.js | GMAIL_IMPERSONATE_USER, OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, RESORT_SOCIAL_CHANNEL, RESORT_WHATSAPP_CHANNEL, SOCIALSOL_ROOT | RUNNING (keepalive) | loaded | converged (installed==rendered) | script-ping; Slack env | QC-2/QC-8 — serving core (HTTP+webhooks+Slack) | CRITICAL |
| crm-audience-sync | cal:Hour=7,Minute=0 | crm/scripts/workflow-trigger.js meta.audience.sync --bucket day | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-6 — Meta audience sync (write) | HIGH |
| crm-backup | cal:Hour=3,Minute=15 | automation/crm_backup.py | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-crm-backup/30h; script-ping | QC-3 — encrypted DB backup + offsite | CRITICAL |
| crm-heartbeat | every 300s | crm/scripts/crm-heartbeat.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-3 — crm liveness ping | MEDIUM |
| daily-report | cal:Hour=7,Minute=30 | crm/scripts/workflow-trigger.js marketing.report.daily --bucket day | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-6 — daily marketing report | MEDIUM |
| daily-tests | cal:Hour=6,Minute=30 | scripts/daily-test-suite.sh | OPENCLAW_SLACK_ACCOUNT, RESORT_ACCOUNTING_CHANNEL | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-daily-tests/30h | QC-2/QC-3 (F-017) — daily test suite | MEDIUM |
| gmail-reply-forwarder | every 300s | crm/scripts/gmail-reply-forwarder.js | GMAIL_IMPERSONATE_USER, OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, SARAH_EMAIL_SLACK_CHANNEL, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | Slack env | QC-8 — gmail reply forwarder | HIGH |
| graph-accounting-inbox | every 300s | crm/scripts/accounting-inbox.js | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-4 — accounting inbox intake | CRITICAL |
| graph-crm-sync | every 900s | crm/scripts/workflow-trigger.js ownerrez.crm.sync --bucket 15m | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-9 — OwnerRez CRM sync workflow | HIGH |
| graph-paulina | every 300s | crm/scripts/workflow-trigger.js paulina.daily --bucket 5m | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-7 — Paulina send workflow | CRITICAL |
| graph-paulina-prepare | cal:Hour=8,Minute=30 | crm/scripts/workflow-trigger.js paulina.prepare_daily --bucket day | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-7 — Paulina daily prepare | HIGH |
| graph-receipt-reconcile | every 3600s | crm/scripts/workflow-trigger.js receipt.reconcile --bucket hour | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-4 — receipt reconcile workflow | CRITICAL |
| graph-regina | cal:Hour=7,Minute=30 | crm/scripts/workflow-trigger.js regina.daily --bucket day | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-7 — Regina send workflow | CRITICAL |
| graph-social-publish | every 300s | crm/scripts/workflow-trigger.js social.publish_due --bucket 5m | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-6 — social publish dispatcher | CRITICAL |
| graph-social-routine | cal:Hour=8,Minute=0 | crm/scripts/workflow-trigger.js social.publish_routine --bucket day | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-6 — daily social routine | CRITICAL |
| graph-squarespace-sync | every 300s | crm/scripts/workflow-trigger.js squarespace.crm.sync --bucket 5m | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-5 — Squarespace sync workflow | HIGH |
| gtku | - | - | - | RETIRED (removed + launchd-disabled) | not loaded | converged (absent + launchd-disabled) | - | QC-6 — legacy GTKU social | LOW |
| job-watchdog | cal:Hour=9,Minute=0 | automation/job_watchdog.py | OPENCLAW_SLACK_ACCOUNT, RESORT_SOCIAL_CHANNEL | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping; Slack env | QC-3 — job staleness alerts | HIGH |
| kapital-tests | cal:Weekday=1,Hour=8,Minute=0 | accounting/run_weekly_tests.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-4 (F-014) — weekly accounting integrity tests | HIGH |
| log-rotation | cal:Weekday=0,Hour=2,Minute=30 | automation/rotate_logs.py | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-log-rotation/8d; script-ping | QC-3 — log rotation | LOW |
| lp-phase-gate | cal:Hour=8,Minute=0 | automation/lp_phase_gate.py | OPENCLAW_SLACK_ACCOUNT, RESORT_SOCIAL_CHANNEL | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-lp-phase-gate/30h; script-ping; Slack env | QC-6 — landing-page phase gate | MEDIUM |
| marketing-reconcile | cal:Hour=6,Minute=30 | automation/reconcile_marketing_state.py | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-marketing-reconcile/30h; script-ping | QC-6 — marketing state reconcile | MEDIUM |
| media-backup-verify | cal:Weekday=1,Hour=9,Minute=30 | automation/media_backup_verify.py | SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-media-backup-verify/8d | QC-10 (F-032e) — offline media copy checksum verify | LOW |
| media-corpus-indexer | cal:Hour=8,Minute=20 | media/scripts/index-media-corpus.sh | SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-10 — media corpus indexer | LOW |
| media-rescan | cal:Weekday=1,Hour=7,Minute=45 | media/scripts/rescan-sarah.sh | MEDIA_SHOOT_SLUG, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-media-rescan/8d | QC-10 — Sarah media rescan | LOW |
| meta-capi-retry | every 900s | crm/scripts/retry-meta-capi.js | SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-6 — CAPI retry queue | HIGH |
| meta-insights | - | - | - | DISABLED (coherent) | not loaded | converged (.disabled at all layers) | - | QC-6 — meta insights (disabled) | LOW |
| orchestrator | - | - | - | RETIRED (removed + launchd-disabled) | not loaded | converged (absent + launchd-disabled) | - | QC-7 — legacy outreach orchestrator | LOW |
| ownerrez-message-ingest | cal:Hour=6,Minute=30 | crm/scripts/ownerrez-message-ingest.js | SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-9 — OwnerRez message ingest | HIGH |
| ownerrez-sync | - | - | - | RETIRED (removed + launchd-disabled) | not loaded | converged (absent + launchd-disabled) | - | QC-9 — legacy OwnerRez sync | LOW |
| ownerrez-weekly-calendar | cal:Weekday=1,Hour=8,Minute=0 | crm/scripts/ownerrez-weekly-calendar.js | OPENCLAW_SLACK_ACCOUNT, RESORT_RESERVATIONS_CHANNEL, SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-9 — weekly ops calendar | MEDIUM |
| paloma-followup | cal:Weekday=1,Hour=8,Minute=0 | paloma/scripts/weekly-followup.sh | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-9 — Paloma followups (scheduled half) | MEDIUM |
| paloma-scan | every 14400s | paloma/scripts/scan-channels.sh | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-9 — Paloma channel scan/reconcile | MEDIUM |
| paloma-summary | cal:Weekday=1,Hour=9,Minute=0 | paloma/scripts/weekly-summary.sh | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-9 — Paloma weekly summary | MEDIUM |
| prospector-daily | - | - | - | RETIRED (removed + launchd-disabled) | not loaded | converged (absent + launchd-disabled) | - | QC-7 — legacy prospector | LOW |
| qbo-keepalive | cal:Weekday=3,Hour=4,Minute=0 | scripts/qbo-token-keepalive.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-4 — QBO OAuth token refresh (credential mutation) | CRITICAL |
| regina-anniversary | - | - | - | RETIRED (removed + launchd-disabled) | not loaded | converged (absent + launchd-disabled) | - | QC-7 — legacy anniversary cron | LOW |
| regina-reconcile | cal:Hour=10,Minute=0 | regina/scripts/gmail-reconcile.js | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-7 — Regina gmail reconcile | MEDIUM |
| restore-drill | cal:Weekday=2,Hour=5,Minute=30 | automation/backup_restore_drill.py | SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-crm-restore-drill/8d; script-ping | QC-3 — weekly restore drill | HIGH |
| squarespace-report | every 600s | crm/scripts/squarespace-report.js --all --post | OPENCLAW_SLACK_ACCOUNT, RESORT_ACCOUNTING_CHANNEL, RESORT_BIZEVENT_CHANNEL, RESORT_HOUSEKEEPING_CHANNEL, RESORT_RESERVATIONS_CHANNEL, SQUARESPACE_SLACK_ENABLED | LOADED-SCHEDULED | loaded | converged (installed==rendered) | Slack env | QC-5 — Squarespace report | MEDIUM |
| squarespace-sync | - | - | - | RETIRED (removed + launchd-disabled) | not loaded | converged (absent + launchd-disabled) | - | QC-5 — legacy Squarespace sync | LOW |
| stale-draft-sweep | cal:Hour=9,Minute=0 | prospector/scripts/sweep-stale-drafts.sh | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-8 — stale draft sweep | MEDIUM |
| state-backup | cal:Hour=3,Minute=45 | automation/state_backup.py | SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-state-backup/30h | QC-3 (F-032a/b) — encrypted state backup + offsite | HIGH |
| telmex-check | cal:Day=1,Hour=9,Minute=0 | scripts/telmex-check.sh | OPENCLAW_SLACK_ACCOUNT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | NONE | QC-10 — ISP bill check | LOW |
| tracker-liveness | cal:Hour=7,Minute=0 | scripts/tracker-liveness-test.py | OPENCLAW_SLACK_ACCOUNT, TRACKING_QC_CHANNEL | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-tracker-liveness/30h; script-ping; Slack env | QC-6 (F-019) — tracker liveness probe | MEDIUM |
| tracking-health | cal:Hour=6,Minute=45 | scripts/tracking-health-check.py | OPENCLAW_SLACK_ACCOUNT, TRACKING_QC_CHANNEL | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-tracking-health/30h; script-ping; Slack env | QC-6 — tracking health check | MEDIUM |
| tunnel | keepalive | crm/scripts/start-tunnel.sh ⚠tmp-logs | - | RUNNING (keepalive) | loaded | converged (installed==rendered) | NONE | QC-3 — webhook ingress tunnel | CRITICAL |
| tunnel-heartbeat | every 300s | crm/scripts/tunnel-heartbeat.sh ⚠tmp-logs | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-3 — tunnel monitor | HIGH |
| voice-corpus-indexer | cal:Hour=8,Minute=15 | crm/scripts/index-voice-corpus.sh | - | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-10 — voice corpus indexer | LOW |
| warmup-daily | cal:Hour=8,Minute=30 | warmup/scripts/warmup-daily.sh | OPENCLAW_SLACK_ACCOUNT, PROSPECTOR_SLACK_CHANNEL, SOCIALSOL_ROOT | LOADED-SCHEDULED | loaded | converged (installed==rendered) | script-ping | QC-7 — email warmup | MEDIUM |
| weekly-tracking-audit | cal:Weekday=1,Hour=7,Minute=0 | scripts/weekly-tracking-audit.py | OPENCLAW_SLACK_ACCOUNT, TRACKING_QC_CHANNEL | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-weekly-tracking-audit/8d; script-ping; Slack env | QC-6 — weekly tracking audit | MEDIUM |
| workflow-health | every 300s | automation/workflow_health.py | OPENCLAW_SLACK_ACCOUNT, RESORT_OPS_ALERTS_CHANNEL, SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | LOADED-SCHEDULED | loaded | converged (installed==rendered) | watchdog:resort-workflow-health/15m; script-ping; Slack env | QC-3 — control-plane health | HIGH |
| workflow-worker | keepalive | crm/scripts/workflow-worker.js | OPENCLAW_SLACK_ACCOUNT, SOCIALSOL_ROOT, SOCIALSOL_SECRETS_DIR | RUNNING (keepalive) | loaded | converged (installed==rendered) | NONE | QC-2 — durable control plane | CRITICAL |

## Convergence state (fix session #1, 2026-08-17)

All ten QC-1b convergence deltas are resolved at `b7b0b07`:

1. `kapital-tests` + `qbo-keepalive` adopted with byte-faithful templates —
   governed without a behavior change (F-016a closed).
2. Paloma trio installed and loaded per D-012 (F-016b closed; QC-9 tests them).
3. Installed-ahead envs folded into templates first (`crm` WhatsApp env;
   `squarespace-report` Slack-enable): reinstall can no longer regress (F-016c).
4. All template-ahead jobs reinstalled from render (daily-tests,
   tracker-liveness, ownerrez pair, telmex-check) (F-016c).
5. Bizevent binding corrected to `business-intel` and housekeeping bound to the
   owner-designated `housekeeper` policy channel (owner decision D-016).
6. Media pair definitions are repo-controlled regular files; outer-repo
   symlinks gone (F-016d / F-023 residual).
7. `warmup-daily.plist.disabled` remnant deleted; `meta-insights` stays
   coherently disabled (F-016g).
8. Six legacy producers (gtku, orchestrator, ownerrez-sync, prospector-daily,
   regina-anniversary, squarespace-sync) retired reboot-durably: plists
   removed (backed up), labels launchd-disabled, templates deleted, watchdog
   resurrection check active (F-041 closed).
9. NODE_BIN renders use stable `/opt/homebrew/bin/node` (F-016f closed).
10. `/tmp` logging on chroma/heartbeat/tunnel jobs + adopted kapital/qbo pair
    remains (QC-3 residual, unchanged this session by design).

New producers this session: `state-backup` (nightly 03:45 encrypted
tasks.db + policy.json + openclaw.json riding the crm_backup pipeline,
offsite same folder — F-032a/b) and `media-backup-verify` (weekly Monday
09:30 checksum verification of the attested offline media copy with 35-day
grace — F-032e). Gateway cron `auto-organic-ig-post` retired per D-001
walkthrough (F-035c) — the sanctioned organic-IG surface is the autonomous
`social.*` workflow set.

## F-023 launchd convergence proof (carried forward)

The 2026-08-15 proof stands: all loaded `com.lapuestadelsolresort.*` jobs
execute scripts resolving into `~/.openclaw/SocialSol`; the media-pair
symlink caveat is now resolved (repo-controlled installs). Co-tenant jobs
(goldroute, maya, claude-max-api, Google, ollama, `ai.openclaw.gateway`)
unchanged and out of QC scope.
