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

## Change and release completion

The repository's primary checkout is the serving production checkout. Keep it
on clean `main`; never switch it to a feature branch or edit source there.
Build changes in a separate Git worktree on a `codex/*` branch.

For an implementation request, a commit or feature-branch push is an
intermediate checkpoint, not completion. Unless the requester explicitly says
to stop at a local change, commit, branch, pull request, or no-deploy state,
finish the complete release path:

1. Validate the change and run `npm run check:stack`.
2. Commit and push the `codex/*` branch.
3. Open a pull request to `main` and wait for the GitHub `verify` check.
4. Merge only after that check passes.
5. Fast-forward the serving checkout to `origin/main` and run
   `npm run release:check` followed by `npm run release:deploy`.
6. Verify the deployment record, live workflow health, clean Git state, and
   exact local/remote `main` SHA before reporting completion.

If unrelated edits are discovered in the serving checkout, preserve them in a
named stash or separate worktree, restore clean `main` immediately, and handle
them in a separate pull request. Never leave uncommitted source changes in the
serving checkout.

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
