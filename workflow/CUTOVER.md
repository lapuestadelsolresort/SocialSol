# Shadow rollout and cutover

The committed LaunchAgents are templates. Rendering is non-mutating; installing
or loading them and merging the OpenClaw patch are production cutovers.

## 1. Preflight

```bash
npm run init:runtime
npm run setup:workflow-token
npm run check:stack
npm run render:launchagents
npm run render:openclaw-policy -- --output workflow/openclaw-policy.patch.json
npm run validate:openclaw-shadow
PYTHONPATH=automation python3 automation/backup_restore_drill.py
```

Confirm `workflow/policy.json` still has `"shadow_mode": true`. Review the
rendered OpenClaw patch and generated plists. Do not replace the full OpenClaw
config with the patch; merge only its Slack channel policy and plugin sections.
The guarded `npm run apply:openclaw-shadow` command performs that merge,
validates it, and creates a mode-600 config backup before the atomic write.
`npm run install:shadow-services` installs only the durable worker, health
monitor, weekly restore drill, and the repaired legacy GTKU environment; it
does not install any graph producer.

## 2. Shadow observation and narrow live workflows

Load only the workflow health/worker components and the OpenClaw plugin in
shadow mode. Existing production jobs remain active. Confirm:

- ordinary WhatsApp thread text is observed but not claimed or sent;
- `!wa` is recognized in logs but the legacy path remains the only live path;
- receipt messages are observed without duplicate ledger writes;
- read workflows return evidence-backed results in every controlled channel;
- no final response can retain an unsupported sent/published/delivered claim;
- the worker, CRM, tunnel, backup, restore drill, and watchdog remain healthy.

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

| New graph | Legacy producer to remove at the same cutover |
|---|---|
| `graph-paulina` | `com.lapuestadelsolresort.orchestrator` |
| `graph-regina` | `com.lapuestadelsolresort.regina-anniversary` |
| `graph-social-publish` | `com.lapuestadelsolresort.gtku` |
| `graph-crm-sync` | legacy OwnerRez sync LaunchAgent |
| `graph-squarespace-sync` | legacy Squarespace sync LaunchAgent |

The accounting inbox graph has no legacy autonomous QBO writer; add a statement
to `accounting/inbox/` only after the dry-run classification has been reviewed.
The first live statement should be a known historical statement whose QBO
records already exist, proving deduplication without creating records.

WhatsApp has no staff-controlled test phone. Arm a passive canary for the next
genuine inbound: inbound stored → durable `#whatsapp` thread posted → explicit
staff `!wa` accepted → sent callback → delivered callback → read callback where
available. The same Slack thread must display exactly the states Twilio
supplied. Never fabricate a guest message for this test. The direct
`/api/whatsapp/reply` and `/api/whatsapp/thread-reply` paths must remain retired.

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
