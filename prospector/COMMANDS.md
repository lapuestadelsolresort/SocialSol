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

## Supporting maintenance

```bash
node prospector/scripts/engagement-analysis.js --dry-run
bash prospector/scripts/sweep-stale-drafts.sh
```

Slack commands such as add-contact, do-not-contact, campaign creation,
approval, rejection, and staging operations are adapters over authenticated
CRM endpoints. The CRM owns their state transitions and audit history.
