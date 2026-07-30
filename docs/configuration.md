# Configuration

Copy `.env.example` to `.env` for local development. The `.env` file is ignored.

Production can use JSON secret files under `SOCIALSOL_SECRETS_DIR`:

- `meta.json` — Meta system-user token and ad account identifier
- `twilio.json` — account SID, API key SID/secret, Auth Token, WhatsApp sender, and exact webhook URL
- `resend.json` — Resend webhook signing secret
- `calcom.json` — Cal.com webhook signing secret
- `resort-api-auth.json` — Basic-auth user/password for remote internal CRM APIs
- `healthchecks.json` — Healthchecks ping base URL and per-job identifiers
- `resort-backup.json` — encrypted backup destination and passphrase file path

All secret files must be readable only by the service account:

```bash
chmod 600 /path/to/secrets/*.json
```

Live campaign mappings belong in `campaigns/active-campaigns.json`, copied from the sanitized example. That file is deliberately ignored because it contains operational identifiers and budgets.

Agent configuration is handled the same way:

```bash
cp prospector/config.example.json prospector/config.json
cp regina/config.example.json regina/config.json
cp sarah-coach/config.example.json sarah-coach/config.json
```

The live files are ignored because they contain Slack identifiers, sender
details, and operational settings.
