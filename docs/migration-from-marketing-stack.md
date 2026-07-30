# Migration from marketing-stack

This consolidation copies the resort-owned source into SocialSol without
changing the currently loaded production jobs.

## Included

- complete Prospector research, persona, composition, compliance, orchestration,
  OpenClaw adapter, engagement analysis, and scheduling source
- current Regina/Reengager campaign library, reconciliation, anniversary, and
  opt-in automated Resend source
- Sarah Coach
- sender warmup templates and driver
- all current resort LaunchAgent definitions as portable templates
- the existing CRM, landing pages, media pipeline, Meta automation, tunnel
  scripts, tests, and reporting

## Deliberately excluded

- GoldRoute
- provider credentials and account/channel/user identifiers
- CRM databases, customer/prospect CSVs, and warmup recipients
- research cache/runs, query history, send history, logs, and state
- private agent identity, memory, conversation, and historical implementation
  specs
- nested dependency locks; the root `package-lock.json` is authoritative
- retired `prospector/send.sh`; `prospector/orchestrator.js` replaced it

## Cutover rule

Do not delete `marketing-stack` or change loaded LaunchAgents merely because
this source migration is merged. First:

1. restore private configuration and data into the new checkout;
2. render and diff all LaunchAgents;
3. run dry-runs for CRM, Prospector, Regina, reporting, backup, and tunnel jobs;
4. switch one service group at a time and verify healthchecks/webhooks;
5. retain a rollback copy until at least one complete reporting cycle passes.
