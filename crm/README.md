# CRM and funnel service

The CRM is an Express application backed by SQLite. It serves the local dashboard, landing-page configuration, telemetry ingestion, signed provider webhooks, WhatsApp/Meta message bridges, and supporting voice services.

## Run locally

From the repository root:

```bash
npm install
mkdir -p crm/data
npm --workspace crm start
```

The service binds to `127.0.0.1:3456` by default. Set `PORT` or `CRM_DB_PATH`/`DB_PATH` to override those values.

## Public boundary

Only these browser APIs are intentionally public:

- `POST /api/track`
- `GET /api/lp/config`

All other `/api/*` routes require loopback access or credentials from `resort-api-auth.json`. Provider webhooks remain public but require valid provider signatures.

## Runtime files

The SQLite database belongs at `crm/data/crm.db` by default. The entire `crm/data/` directory is ignored and must never be committed.

Use `automation/crm_backup.py` for verified, compressed, encrypted backups rather than copying a live WAL-mode database file.

## Squarespace

The reviewed site-wide injection is `squarespace-injection-v6.html`. It loads the versioned Squarespace tracker, preserves UTMs, records contact intent, captures successful form submissions, and adds the WhatsApp attribution reference.
