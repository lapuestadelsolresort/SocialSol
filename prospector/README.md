# Prospector Paulina

Paulina is the resort's outbound lead-discovery and compliant email pipeline.

1. `research/scripts/run-research.js` searches, fetches, extracts, deduplicates,
   and imports qualified leads.
2. `composer.js` creates persona-aware drafts and runs the compliance gate.
3. `orchestrator.js` verifies approved recipients, adds unsubscribe artifacts,
   enforces sending limits, sends through Resend, and records outcomes.
4. `scripts/engagement-analysis.js` summarizes performance and maintains a
   private iteration-state file.

Copy `config.example.json` to ignored `config.json` and configure `.env` before
running. Research runs, fetched-page cache, draft state, and recent-send logs
are runtime data and remain outside Git.

Automated approval is off in the example configuration so a fresh installation
fails safely. Production intentionally enables `composer.auto_approve` under
Jason's standing autonomy directive. The composer is the single authority for
that choice; scheduled shell jobs must not update approval state directly.
