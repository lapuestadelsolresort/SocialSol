# Agent operating contract

This repository contains resort marketing automation only. GoldRoute, private
agent memory, customer exports, and credentials are outside its boundary.

Before changing or running a workflow:

1. Read `ARCHITECTURE.md` and the service README.
2. Use configuration from `.env`, ignored `*/config.json` files, and
   `SOCIALSOL_SECRETS_DIR`; never hard-code an identity or credential.
3. Treat email sends, Meta budget changes, external posts, and deployment
   cutovers as production mutations. Honor dry-run and enable switches.
4. Do not copy runtime data into Git. This includes databases, contact lists,
   research runs/cache, reports, logs, agent memory, and warmup recipients.
5. Run `npm run check:stack` before proposing a commit.

Service command references live in:

- `prospector/COMMANDS.md`
- `regina/COMMANDS.md`
- `sarah-coach/COMMANDS.md`

The committed LaunchAgents are templates. Rendering them is safe; installing
or loading them is a separate production cutover.
