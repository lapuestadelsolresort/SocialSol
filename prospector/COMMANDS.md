# Prospector Paulina command reference

Authorization is defined by private configuration and
`PAULINA_AUTHORIZED_USER_IDS`; it is never embedded here.

## Status and performance

```bash
node prospector/scripts/performance-status.js
node prospector/scripts/performance-status.js --json
```

This is the canonical source for every Paulina status, performance, pipeline,
volume, deliverability, and "how is it going?" answer—whether the request is a
command or free-form Slack message. It counts a send only when `sent_at` is
present; separates production recipients, smoke tests, other campaigns, and
cancelled drafts; and scopes queue figures to the active Paulina campaign.
Open and click rates are shown only when their tracking settings are enabled in
`config.json`. Open metrics also require a valid
`reporting.open_tracking_enabled_at` timestamp and exclude older sends because
historical opens cannot be backfilled. Never calculate these totals from
`COUNT(*)` on `outreach_sends` or from globally `new` contacts.

Delivery confirms receiving-server acceptance only; it does not establish
inbox placement, sender reputation, or warmup health. Open pixels can
undercount or overcount because of image blocking, privacy features, and
automated scanners. Do not grade a reply rate without an approved benchmark
and adequate sample. A contact's lifecycle `status` is not its `email_status`:
`new` does not mean unverified or outside the attached campaign. Do not infer a
verification shortage when the report says the configured buffer target is
met, and do not guess cancellation causes when recorded reasons are available.

## Research

```bash
node prospector/research/scripts/run-research.js --persona <persona|all> --dry-run
node prospector/research/scripts/run-research.js --persona <persona|all>
```

Research imports are reversible and are written to ignored
`prospector/research/runs/`.

## Compose

```bash
node prospector/composer.js compose --persona <id> --contact <id> --campaign <id> --dry-run
node prospector/composer.js compose --persona <id> --contact <id> --campaign <id>
node prospector/composer.js compose-batch <campaign_slug> [count]
```

Drafts pass the compliance gate before entering the shared CRM. The example
configuration keeps automatic approval disabled. Production may enable it by
standing directive; the composer owns that gate and records the result on every
composed draft.

## Queue verification and capacity

```bash
node prospector/scripts/daily-capacity.js <campaign_slug>
node prospector/scripts/preverify-queue.js <campaign_slug> --target-valid 20 --max 25 --dry-run
node prospector/scripts/preverify-queue.js <campaign_slug> --target-valid 20 --max 25
```

`daily-capacity.js` is read-only and prints the current ramp tier, weekly and
daily commitments, and safe composition batch as JSON. `preverify-queue.js`
uses ZeroBounce credits unless `--dry-run` is present; it updates only the
contact's `email_status` and prints a PII-free JSON summary. Role inboxes,
catch-alls, invalid results, and verifier outages are blocked by default.

## Send orchestration

```bash
node prospector/orchestrator.js --dry-run
node prospector/orchestrator.js
```

The orchestrator sends only due, approved rows and honors
`prospector/state.json` pause state. In production the durable `paulina.daily`
graph invokes it every five minutes, attributes every resulting row to the
workflow run, and verifies the result against the CRM. It re-verifies every
recipient and fails closed if the verification provider is unavailable.

## Weekday preparation graph

```bash
node crm/scripts/workflow-trigger.js paulina.prepare_daily --bucket day
node crm/scripts/workflow-trigger.js paulina.prepare_daily --bucket day \
  --idempotency-key paulina-prepare-canary-YYYY-MM-DD \
  --input-json '{"dryRun":true,"skipAnalysis":true,"skipResearch":true}'
```

The daily 8:30 a.m. LaunchAgent invokes the first command. The fixed graph records
preflight, truthful engagement analysis, capacity, research, campaign
attachment, ZeroBounce verification, draft composition, provider readbacks,
and one Slack summary without user `@mentions` as separate steps. That summary aggregates
all CRM-verified five-minute dispatch runs since the prior completed daily
summary; dispatch runs never post individual success notifications. Weekend
and paused runs skip preparation, but still post a digest when the prior
interval had sends or failures. A provider-facing step that dies mid-flight
opens manual review and is not automatically replayed. The dry-run command is
the deployment canary; its custom idempotency key must never reuse the scheduled
daily key.

## Supporting maintenance

```bash
node prospector/scripts/engagement-analysis.js --dry-run
bash prospector/scripts/sweep-stale-drafts.sh
node crm/scripts/reconcile-email-conversations.js --days 365
node crm/scripts/reconcile-email-classifications.js
```

## Email conversations

Every matched Gmail reply and every reply Sarah sends from Gmail is appended to
the original `#prospector-paulina` draft thread and persisted in
`email_threads`. The mailbox poller never marks Gmail messages read. The
classifier strips quoted history before looking for explicit positive or
negative language, so the original outreach unsubscribe footer cannot classify
the contact as `not_interested`.

In the original draft thread:

```text
!email reply <message>
!email confirm <proposal-id> <acceptance-hash>
!email classify <email-event-id> hot|not_interested|ambiguous
```

The reply command does not send. It records an immutable proposal with a
15-minute expiry. The exact confirm command must be posted by the same
authorized Slack user in the same thread; Gmail acceptance and Sent readback
must both succeed before the workflow reports the message sent. Top-level
commands and ordinary Slack replies do not send email. `!approve`, `!edit`, and
`!reject` belong only to unsent outbound-draft review; they are never email
conversation reply commands.

Historical reconciliation is dry-run by default. Production repair uses
`--apply`; by default it excludes legacy/test sends without an original Slack
thread. Use `--include-unthreaded` only for an explicit forensic backfill.
The classification reconciliation is also dry-run by default. Its guarded
`--apply --confirm-production` mode normalizes collapsed Gmail quote history,
requeues changed classifications or stale reasons through the durable graph,
repairs only the exact false-negative suppression, and posts the correction in
the original Slack thread.

### Gmail delegation access

Paulina's Gmail capture and reply graph uses the existing Workspace
service-account client with domain-wide delegation. The credential stays
outside Git at `${SOCIALSOL_SECRETS_DIR}/gmail-service-account.json`; the
delegated mailbox comes from `GMAIL_IMPERSONATE_USER`, with
`prospector/config.json`'s `sender_reply_to` as the fallback. Do not copy the
client ID, mailbox address, or credential into committed files.

The authoritative Admin Console location is **Security → Access and data
control → API controls → Manage domain wide delegation**. Find the client whose
identity matches `client_email` in the service-account JSON. Its required
scopes are:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

Other scopes already assigned to that client must be preserved. The production
preflight is:

```bash
node crm/scripts/verify-gmail-send-scope.js
```

Success proves that the configured client can impersonate the configured
mailbox with both Gmail scopes; it does not send a message. The guarded cutover
also runs this preflight before changing policy, LaunchAgents, or live workflow
state. Treat the committed requirement and this command as the normal access
record. Ask for an Admin sign-in only if the preflight fails with an
authorization error and the delegation entry actually needs repair.

Slack commands such as add-contact, do-not-contact, campaign creation,
approval, rejection, and staging operations are adapters over authenticated
CRM endpoints. The CRM owns their state transitions and audit history.
