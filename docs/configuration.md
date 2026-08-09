# Configuration

Copy `.env.example` to `.env` for local development. The `.env` file is ignored.

Production can use JSON secret files under `SOCIALSOL_SECRETS_DIR`:

- `meta.json` — Meta system-user token and ad account identifier
- `twilio.json` — account SID, API key SID/secret, Auth Token, WhatsApp sender, and exact webhook URL
- `resend.json` — Resend API key, webhook signing secret, and default sender
- `unsubscribe.json` — HMAC secret used to sign unsubscribe links
- `zerobounce.json` — optional ZeroBounce API key for mailbox verification
- `calcom.json` — Cal.com webhook signing secret
- `resort-api-auth.json` — Basic-auth user/password for remote internal CRM APIs
- `healthchecks.json` — Healthchecks ping base URL and per-job identifiers
- `resort-backup.json` — encrypted backup destination and passphrase file path

All secret files must be readable only by the service account:

```bash
chmod 600 /path/to/secrets/*.json
```

Live campaign mappings belong in `campaigns/active-campaigns.json`, copied from the sanitized example. That file is deliberately ignored because it contains operational identifiers and budgets.

Tracked campaign briefs are the desired configuration. `active-campaigns.json`
stores runtime IDs, observed Meta status, approval-request timestamps, and the
verifiable approval receipt. Reconciliation must update only `meta_*` observed
fields; it must not overwrite a brief or declared registry status to hide drift.

The registry also defines the Meta CAPI allow-list. A verified WhatsApp lead is
sent to Meta only when its UTM campaign is present in the registry and its UTM
source/medium identify paid Meta delivery. This prevents Paulina email,
organic, direct, and unattributed leads from entering Meta attribution or
optimization. Failed deliveries are durable in `conversion_deliveries`, retried
by `crm/scripts/retry-meta-capi.js`, and treated as tracking-health failures.

Agent configuration is handled the same way:

```bash
cp prospector/config.example.json prospector/config.json
cp regina/config.example.json regina/config.json
cp sarah-coach/config.example.json sarah-coach/config.json
```

The live files are ignored because they contain Slack identifiers, sender
details, and operational settings.

The same rule applies to sender warmup:

```bash
cp warmup/recipients.example.json warmup/recipients.json
cp warmup/state.example.json warmup/state.json
```

`warmup/recipients.json` is a private allow-list and must never be committed.

## LaunchAgents

The committed `.plist.template` files contain no usernames or installation
paths. Render them for the current checkout:

```bash
npm run render:launchagents -- --output /tmp/socialsol-launchagents
```

Review the generated files before copying them to `~/Library/LaunchAgents`.
Rendering does not install, load, or replace any running job.

The Meta CAPI retry definition is
`com.lapuestadelsolresort.meta-capi-retry.plist`. It runs every 15 minutes,
keeps the original event id/time for Meta deduplication, and stops retrying
events older than Meta's seven-day acceptance window or after the configured
attempt cap. Those records remain red in tracking health for investigation.
