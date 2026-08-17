# Shadow rollout and cutover

The committed LaunchAgents are templates. Rendering is non-mutating; installing
or loading them and merging the OpenClaw patch are production cutovers.

## 1. Preflight

The serving checkout is a deployment boundary. Before editing or restarting a
process, record the reviewed Git commit and ensure every intended change is
committed. A CRM/worker process started before a source-file edit is stale even
though its command points at the same path; the health monitor reports this as
`runtime_code_drift`. Never use an incidental crash or reboot as a deployment.
Normal application releases must follow `docs/DEPLOYMENT.md` and pass
`npm run release:check` / `npm run release:deploy`. The steps below add the
separate authority and producer cutover checks required for a workflow domain.

```bash
npm run init:runtime
npm run setup:workflow-token
npm run check:stack
npm run render:launchagents
npm run render:openclaw-policy -- --output workflow/openclaw-policy.patch.json
npm run validate:openclaw-shadow
PYTHONPATH=automation python3 automation/backup_restore_drill.py
```

Require `git diff --check` to pass and review every remaining `git status
--short` entry. Unrelated user work must not be bundled into the deployment.
Restart CRM first so additive schema migrations complete, then restart the
worker and health/restore agents from the same reviewed commit. Confirm
`schema_migration_required=0`, `runtime_code_drift=0`, and
`runtime_process_missing=0` before any live command.

Confirm `workflow/policy.json` still has `"shadow_mode": true`. Review the
rendered OpenClaw patch and generated plists. Do not replace the full OpenClaw
config with the patch; merge only its Slack channel policy and plugin sections.
The policy renderer queries the configured resort Slack account and adds every
non-archived channel that Sol has joined to the stable-ID ingress allowlist.
Only channels in ignored `workflow/policy.json` receive resort workflow tools
or business-system authority; ordinary joined channels retain default Sol
conversation behavior without gaining controlled workflow capabilities.
The guarded `npm run apply:openclaw-shadow` command performs that merge,
validates it, and creates a mode-600 config backup before the atomic write.
`npm run install:launchagents` is the single sanctioned LaunchAgent install
path: it converges every installed job onto the current render according to
`deploy/launchagents/service-manifest.json` (backup → atomic install →
bootout/bootstrap), removes and durably disables retired labels, and runs as
a step of every `release:deploy`. `npm run services:check` verifies
installed==rendered and loaded==manifest without changing anything. GTKU is
owned by `graph-social-routine` after social cutover.

Before deploying this control-plane version, add the intended explicit
exceptions to the ignored runtime policy and review them as production
authority:

```json
{
  "live_workflows": ["whatsapp.reply", "meta.dm.reply", "ownerrez.mutation.confirm"],
  "always_on_effects": ["whatsapp.inbound.process:send_conversion"]
}
```

`always_on_effects` is step-specific; it does not make the rest of the inbound
workflow or any other external mutation live.

## 2. Shadow observation and narrow live workflows

Load only the workflow health/worker components and the OpenClaw plugin in
shadow mode. Existing production jobs remain active. Confirm:

- ordinary WhatsApp thread text is observed but not claimed or sent;
- `!wa` is recognized in logs but the legacy path remains the only live path;
- receipt messages are observed without duplicate ledger writes;
- read workflows return evidence-backed results in every controlled channel;
- no final response can retain an unsupported sent/published/delivered claim;
- the worker, CRM, tunnel, backup, restore drill, and watchdog remain healthy.
- no queued run executes in the HTTP request process; the fenced worker claims
  it and renews its lease;
- an injected provider timeout creates one open manual review and never a
  second provider POST.
- an injected post-acceptance local projection failure retries only the local
  step, records one provider POST, and blocks a concurrent human resend;
- two conflicting manual-review resolutions produce one winner and one 409;
- a lease renewal racing stale recovery creates no review and does not stop the
  worker's other subsystems.

Global `shadow_mode` can remain true while a reviewed workflow is listed in
`live_workflows`. This is the supported narrow-cutover mechanism: only that
registered graph can cross its production mutation boundary, and only its
Slack channel receives workflow-only tools. Do not add a workflow to this list
until its domain tests and provider preflight pass.

## 3. Domain canaries

Canary one domain at a time. Add only the matching workflow to
`live_workflows`, render and merge the configuration, then remove the
corresponding legacy producer before loading its graph producer. Never run two
producers for the same effect concurrently. Set global `shadow_mode` false only
after every domain has completed its independent cutover.

Removal must be reboot-durable: mark the legacy label `retired` in
`deploy/launchagents/service-manifest.json` and let `install:launchagents`
boot it out, delete its installed plist (backed up first), and write the
launchd disable override — a live `launchctl bootout` alone resurrects the
producer at the next login (F-041). The 2026-08-17 service-layer fix retired
all six legacy producers below this way; the daily watchdog compares the
loaded set against the manifest so any resurrection alerts.

| New graph | Legacy producer to remove at the same cutover |
|---|---|
| `graph-paulina-prepare` | `com.lapuestadelsolresort.prospector-daily` |
| `graph-paulina` | `com.lapuestadelsolresort.orchestrator` |
| `graph-regina` | `com.lapuestadelsolresort.regina-anniversary` |
| `graph-social-routine` | `com.lapuestadelsolresort.gtku` |
| `graph-crm-sync` | legacy OwnerRez sync LaunchAgent |
| `graph-squarespace-sync` | legacy Squarespace sync LaunchAgent |

`graph-social-publish` is the five-minute dispatcher for approved
`social_content` rows. It is additive and does not replace GTKU. The daily
`graph-social-routine` owns the durable GTKU series after the legacy GTKU
LaunchAgent is unloaded.

The accounting inbox graph has no legacy autonomous QBO writer. A CSV attached
in the allowlisted `#accounting` channel is refetched from the exact Slack
message and staged automatically in `accounting/inbox/`; the watched graph then
runs classification, receipt reconciliation, and QBO readback in that order.
Unknown or duplicate candidates remain held, while only auto-classified rows
cross the QBO write boundary. Direct shell and QBO tools are blocked in the
channel so they cannot become a second producer.

WhatsApp has no staff-controlled test phone. Arm a passive canary for the next
genuine inbound: inbound stored → durable `#whatsapp` thread posted → explicit
staff `!wa` accepted → sent callback → delivered callback → read callback where
available. The same Slack thread must display exactly the states Twilio
supplied. Never fabricate a guest message for this test. The direct
`/api/whatsapp/reply` and `/api/whatsapp/thread-reply` paths must remain retired.

For Meta DMs, add `meta.dm.reply` to `live_workflows` in the same deployment
that retires `/api/meta-dm/reply`. Confirm an explicit `!dm` records a single
provider message ID and reports only acceptance; ordinary model prose must not
invoke the workflow.

For the Sarah email console, run the guarded `npm run cutover:sarah-email`
after the normal release deploy with `SARAH_EMAIL_SLACK_CHANNEL` set to the
stable channel ID. The command proves Gmail send/read and OwnerRez message-read
access before changing state, installs the unified five-minute Gmail poller,
retires `com.lapuestadelsolresort.inbound-email-scanner`, updates the OpenClaw
channel allowlist, restarts the socket gateway and worker, probes Socket Mode,
and requires an acknowledged channel welcome post. The first genuine inbound
Gmail and OwnerRez messages are the passive canaries; do not send a fabricated
guest response merely to test the workflow.

### Paid-Meta autonomy canary

After the normal release deploy, run `npm run configure:social-autonomy` first
and review its dry-run summary. The production cutover is one guarded command:

```bash
npm run cutover:social-autonomy
```

It backs up and updates the ignored workflow policy, merges the OpenClaw shadow
configuration, replaces the direct daily report with `marketing.report.daily`,
installs the graph-owned `meta.audience.sync` schedule, retires the stale
pipeline validator, and restarts the gateway. LaunchAgent and policy backups
are retained for rollback. The command does not report success until the daily
report and audience-sync canaries complete as durable graph runs. Before
accepting an autonomous campaign action,
confirm a fresh `marketing.snapshot.read` covers at least three completed days,
tracking is healthy, the live budget still equals the evidence, and the target
has a committed campaign brief. A one-day report, missing brief, changed live
budget, expired evidence, or prior autonomous mutation within 24 hours must
fail before provider dispatch.

## 4. Rollback

Stop the new graph producer, restore `shadow_mode: true`, re-render and merge the
OpenClaw policy, and re-enable the single legacy producer for that domain. Do
not delete workflow rows: they are the audit trail needed to distinguish safe
retries from ambiguous external results.

## OwnerRez mutation gate

The fixed catalog snapshots all 34 official OwnerRez v2 write operations. An
authorized user first runs `ownerrez.mutation.propose`, reviews the exact
operation/path/reason and request hash, and then pastes the emitted
`!ownerrez confirm <proposal-id> <acceptance-hash>` command within 15 minutes.
Confirmation must come from the same trusted Slack user. The graph rejects
stale preconditions, executes a mutation only once, verifies create/update/
delete using the operation-specific provider readback, records evidence, and
notifies the configured humans. Ambiguous network results are manual-review
failures and are never replayed automatically.
