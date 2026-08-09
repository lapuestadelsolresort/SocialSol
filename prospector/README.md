# Prospector Paulina

Paulina is the resort's outbound lead-discovery and compliant email pipeline.

1. `research/scripts/run-research.js` searches, fetches, extracts, deduplicates,
   and imports qualified leads.
2. `scripts/preverify-queue.js` rejects role inboxes, catch-alls, invalid
   addresses, and unknown verifier results before composition.
3. `composer.js` creates persona-aware drafts only for pre-verified recipients
   and runs the compliance gate.
4. `orchestrator.js` re-verifies approved recipients, adds unsubscribe artifacts,
   enforces sending limits, sends through Resend, and records outcomes.
5. `scripts/engagement-analysis.js` summarizes performance and maintains a
   private iteration-state file.

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

Delivery automatically pauses when any configured absolute or rate threshold
is reached. Production defaults are two bounces in 24 hours, a 4% seven-day
bounce rate after 20 sends, or any complaint. Resume only after the queue and
sender reputation have been investigated.

Automation-facing commands reserve stdout for one JSON result. Diagnostics go
to stderr and the Prospector log, so daily Slack counts reflect actual drafts.
