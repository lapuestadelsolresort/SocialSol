# SocialSol

Marketing infrastructure for La Puesta del Sol Resort:

- Meta Ads → Astro landing pages → WhatsApp funnel attribution
- Twilio WhatsApp and Meta DM webhook bridge
- SQLite CRM and landing-page experiment service
- Daily reporting, campaign integrity checks, encrypted backups, and job monitoring
- Cloudflare Pages landing applications

This repository contains source code and safe configuration examples only. Live databases, credentials, customer records, Slack identifiers, media originals, logs, campaign state, and deployment caches are intentionally excluded.

## Repository layout

- `crm/` — Express CRM, webhook handlers, attribution, SQLite migrations, and tests
- `landing/apps/` — Astro landing pages for weddings, retreats, fitness, and seasonal campaigns
- `automation/` — daily reports, campaign checks, budget guardrails, backups, and watchdogs
- `lp/variants/` — versioned landing-page copy definitions
- `media/` — source-only creative/media pipeline
- `prospector/`, `regina/`, `sarah-coach/` — supporting voice and outreach modules used by the CRM
- `campaigns/` — sanitized configuration template; live campaign state is ignored

## Local setup

Requirements:

- Node.js 22.12 or later
- Python 3.11 or later
- SQLite 3
- Optional: OpenClaw CLI, Cloudflared, FFmpeg, and Chroma

```bash
cp .env.example .env
cp prospector/config.example.json prospector/config.json
cp regina/config.example.json regina/config.json
cp sarah-coach/config.example.json sarah-coach/config.json
npm install
npm test
npm run build:landing
```

Create runtime directories without committing them:

```bash
mkdir -p crm/data logs secrets campaigns
cp campaigns/active-campaigns.example.json campaigns/active-campaigns.json
```

Production credentials belong in mode-600 JSON files under `SOCIALSOL_SECRETS_DIR`. See `docs/configuration.md`.

The committed voice spec and fixtures are sanitized public baselines. Do not
commit generated voice-corpus output or exported customer data.

## Security defaults

- Internal `/api/*` routes are default-deny and loopback-only unless Basic-auth credentials are configured.
- Only landing configuration and telemetry ingestion are public.
- Twilio, Meta, Resend, and Cal.com webhooks verify provider signatures.
- Browser telemetry is origin-restricted and rate-limited.
- Tokens are sent in authorization headers, not query strings.
- Live budget changes require explicit mode and total-budget guardrails.

See [SECURITY.md](SECURITY.md) for reporting and credential-handling guidance.
