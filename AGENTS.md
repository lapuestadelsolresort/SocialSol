# Agent operating contract

This repository is the AI operations platform for La Puesta del Sol Resort,
covering marketing & guest conversion, property operations, and finance &
admin support. `README.md` is the canonical infrastructure map. GoldRoute,
private agent memory, customer exports, and credentials are outside its
boundary.

Before changing or running a workflow:

1. Read `README.md` for the full system map — agents, integrations,
   automations, and repository layout.
2. Use configuration from `.env`, ignored `*/config.json` files, and
   `SOCIALSOL_SECRETS_DIR`; never hard-code an identity or credential.
3. Treat email sends, Meta budget changes, external posts, OwnerRez writes,
   and deployment cutovers as production mutations. Honor dry-run and enable
   switches.
4. Do not copy runtime data into Git. This includes databases, contact lists,
   research runs/cache, reports, logs, agent memory, media originals, and
   warmup recipients.
5. Run `npm run check:stack` before proposing a commit.

Service command references live in:

- `prospector/COMMANDS.md`
- `regina/COMMANDS.md`
- `sarah-coach/COMMANDS.md`

The committed LaunchAgents are templates. Rendering them is safe; installing
or loading them is a separate production cutover.

## Deterministic owner cash-flow answers

When an owner asks about future cash flow, upcoming booking revenue, direct
balances, Airbnb/Vrbo payouts, or the value of current bookings, run:

```bash
node crm/scripts/owner-cash-flow.js
```

For the initial answer, the entire final response MUST be the command's stdout
verbatim. Do not summarize, shorten, relabel, round differently, add memory or
Slack context, append recommendations, or invite follow-up. This output
contract overrides the general preference for brevity. A separate follow-up
may use `--json` and other explicitly queried sources. If the command fails,
report the failure instead of constructing a partial financial answer.
