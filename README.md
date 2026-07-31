# SocialSol

Marketing infrastructure for La Puesta del Sol Resort:

- Meta Ads → Astro landing pages → WhatsApp funnel attribution
- Twilio WhatsApp and Meta DM webhook bridge
- SQLite CRM and landing-page experiment service
- Daily reporting, campaign integrity checks, encrypted backups, and job monitoring
- Guarded GitHub snapshots of in-progress Mac mini work
- Cloudflare Pages landing applications
- Prospector Paulina lead research, compliant composition, and outbound sending
- Reengager Regina past-guest/inquiry campaigns and Sarah Coach reply assistance
- Sender-domain warmup tooling

This repository contains source code and safe configuration examples only. Live databases, credentials, customer records, Slack identifiers, media originals, logs, campaign state, and deployment caches are intentionally excluded.

## Repository layout

- `crm/` — Express CRM, webhook handlers, attribution, SQLite migrations, and tests
- `landing/apps/` — Astro landing pages for weddings, retreats, fitness, and seasonal campaigns
- `automation/` — daily reports, campaign checks, budget guardrails, backups, and watchdogs
- `lp/variants/` — versioned landing-page copy definitions
- `media/` — source-only creative/media pipeline
- `prospector/` — Paulina research, composition, compliance, and send orchestration
- `regina/` — the Reengager campaign engine and optional automated Resend path
- `sarah-coach/` — inbound-reply drafting and outcome capture
- `warmup/` — sender warmup templates and private-recipient driver
- `campaigns/` — sanitized configuration template; live campaign state is ignored
- `scripts/autosave-to-github.sh` — isolated snapshots to `autosave/macmini`

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
cp warmup/recipients.example.json warmup/recipients.json
cp warmup/state.example.json warmup/state.json
npm install
npm run check:stack
```

Create runtime directories without committing them:

```bash
mkdir -p crm/data logs secrets campaigns
cp campaigns/active-campaigns.example.json campaigns/active-campaigns.json
```

Production credentials belong in mode-600 JSON files under `SOCIALSOL_SECRETS_DIR`. See `docs/configuration.md`.

The committed voice spec and fixtures are sanitized public baselines. Do not
commit generated voice-corpus output or exported customer data.

The former `marketing-stack` repository is a migration source only. This
repository does not depend on its checkout or legacy `workspace-resort` paths.
See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and data boundaries.

## Security defaults

- Internal `/api/*` routes are default-deny and loopback-only unless Basic-auth credentials are configured.
- Only landing configuration and telemetry ingestion are public.
- Twilio, Meta, Resend, and Cal.com webhooks verify provider signatures.
- Browser telemetry is origin-restricted and rate-limited.
- Tokens are sent in authorization headers, not query strings.
- Live budget changes require explicit mode and total-budget guardrails.

See [SECURITY.md](SECURITY.md) for reporting and credential-handling guidance.

## GitHub autosave

The Mac mini scheduler runs `npm run autosave:run` every 30 minutes. The script
snapshots all Git-eligible working-tree changes to `origin/autosave/macmini`
through an isolated Git index, so it does not switch branches, stage files, or
alter the working tree. Ignored runtime data remains excluded. A secret scan
and a 10 MiB per-file limit must pass before any snapshot is pushed.

Run a safe connectivity and snapshot preview with:

```bash
npm run autosave:dry-run
```

The autosave branch is a recovery stream, not a replacement for reviewed
commits on `main`. Promote finished work through normal tested commits and pull
requests.
