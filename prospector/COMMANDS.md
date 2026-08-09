# Prospector Paulina command reference

Authorization is defined by private configuration and
`PAULINA_AUTHORIZED_USER_IDS`; it is never embedded here.

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

## Send orchestration

```bash
node prospector/orchestrator.js --dry-run
node prospector/orchestrator.js
```

The orchestrator sends only due, approved rows and honors
`prospector/state.json` pause state. The LaunchAgent invokes it every five
minutes in production.

## Supporting maintenance

```bash
node prospector/scripts/engagement-analysis.js --dry-run
bash prospector/scripts/sweep-stale-drafts.sh
```

Slack commands such as add-contact, do-not-contact, campaign creation,
approval, rejection, and staging operations are adapters over authenticated
CRM endpoints. The CRM owns their state transitions and audit history.
