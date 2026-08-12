# Prospector Paulina

Paulina is the resort's outbound lead-discovery and compliant email pipeline.

1. `research/scripts/run-research.js` searches, fetches, extracts, deduplicates,
   and imports qualified leads.
2. `scripts/preverify-queue.js` rejects role inboxes, catch-alls, invalid
   addresses, and unknown verifier results before composition.
3. `composer.js` creates persona-aware drafts only for pre-verified recipients
   and runs the compliance gate.
4. The durable `paulina.daily` graph invokes `orchestrator.js`, which re-verifies
   approved recipients, adds unsubscribe artifacts, enforces sending limits,
   sends through Resend, and records outcomes attributed to that workflow run.
5. `scripts/performance-status.js` is the canonical read-only status report.
   `scripts/engagement-analysis.js` uses engagement data to maintain a private
   iteration-state file. The weekday preparation job is scheduled for migration
   into its own durable graph; it is not the Resend sending authority.

Copy `config.example.json` to ignored `config.json` and configure `.env` before
running. Research runs, fetched-page cache, draft state, and recent-send logs
are runtime data and remain outside Git.

Automated approval is off in the example configuration so a fresh installation
fails safely. Production intentionally enables `composer.auto_approve` under
Jason's standing autonomy directive. The composer is the single authority for
that choice; scheduled shell jobs must not update approval state directly.

## Planner throughput and deliverability controls

The daily workflow derives its batch from the campaign's calendar-week ramp:

| Campaign week | Weekly cap | Daily target (5 weekdays) |
|---|---:|---:|
| 1 | 20 | 4 |
| 2 | 40 | 8 |
| 3 | 50 | 10 |
| 4 | 75 | 15 |
| 5+ | 100 | 20 |

`scripts/daily-capacity.js` subtracts sends and scheduled drafts already
committed that day/week. This makes the daily job safe to rerun without doubling
volume. The 9am–5pm PT scheduler uses 20–25 minute gaps at the highest tier.

Before drafting, the job keeps a two-day buffer of verified mailboxes. By
default, only a named mailbox with MX records and a `valid` ZeroBounce result is
eligible. Generic role addresses, catch-alls, invalid addresses, and verifier
errors remain blocked. The orchestrator performs the same fail-closed check
again immediately before Resend delivery.

Each Resend POST uses `socialsol-outreach-<outreach_sends.id>` as its provider
idempotency key. Resend retains that key for 24 hours; the CRM row's terminal
or `ambiguous` status is the durable replay guard after that window. Network,
5xx, or id-less success responses are never changed to cancelled or retried as
if they were known failures. See Resend's official idempotency-key contract:
https://resend.com/docs/dashboard/emails/idempotency-keys

Delivery automatically pauses when any configured absolute or rate threshold
is reached. Production defaults are two bounces in 24 hours, a 4% seven-day
bounce rate after 20 sends, or any complaint. Resume only after the queue and
sender reputation have been investigated.

Automation-facing commands reserve stdout for one JSON result. Diagnostics go
to stderr and the Prospector log, so daily Slack counts reflect actual drafts.

## Reporting contract

Run `node prospector/scripts/performance-status.js` for all human-facing status
and performance answers. `outreach_sends` is a workflow ledger, so `COUNT(*)`
is not a sent-email metric: only rows with `sent_at IS NOT NULL` count as
sends. The report keeps internal tests, non-Paulina campaigns, cancelled rows,
and the global CRM contact pool separate from production planner outreach.

Open and click metrics are configuration-gated. Open tracking additionally
requires `reporting.open_tracking_enabled_at`; only messages sent on or after
that timestamp enter its denominator because historical opens cannot be
backfilled. When tracking is disabled or lacks a valid activation timestamp,
the report returns opens as unavailable rather than zero. A delivery webhook
means the receiving server accepted the message; it is not proof of inbox
placement, sender reputation, or warmup health. Open pixels are approximate
because image blocking, privacy features, and automated scanners can suppress
or inflate counts. Report observed reply counts and rates without grading them
unless an approved benchmark and adequate sample are available.

### Resend open-tracking production configuration

Paulina's Resend sending domain uses a dedicated, DNS-verified tracking host:

- sending domain: `outreach.lapuestadelsolresort.com`
- tracking host: `links.outreach.lapuestadelsolresort.com`
- DNS: unproxied CNAME to `links1.resend-dns.com`
- open tracking: enabled
- click tracking: disabled (links remain unchanged)
- activation boundary: `2026-08-10T00:03:04Z`
- webhook: `https://webhook.lapuestadelsolresort.com/webhook/resend`, subscribed
  to all Resend events including `email.opened`

The CRM records only the first `email.opened` event in
`outreach_sends.opened_at`. Keep the Resend activation boundary and
`reporting.open_tracking_enabled_at` identical. If the tracking host or setting
is replaced, record a new activation timestamp; never move it backward to make
historical messages look tracking-eligible. The canonical status and daily
engagement reports use the eligible delivered-message count as the denominator.
