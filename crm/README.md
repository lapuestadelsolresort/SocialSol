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

## OwnerRez: contacts versus occupancy

`crm/scripts/ownerrez-sync.js` is a contact-enrichment pipeline. It only syncs
OwnerRez records with a `guest_id`, so the CRM must not be used to answer what
is booked or whether dates are available.

Use the read-only full-occupancy query for calendar and availability work. It
downloads the complete OwnerRez booking/block list and includes every active
record in the requested window regardless of `guest_id` or `type`:

```bash
node crm/scripts/ownerrez-full-occupancy.js --start 2026-08-10 --end 2026-09-07
node crm/scripts/ownerrez-full-occupancy.js --start 2026-08-10 --end 2026-09-07 --json
```

The Monday `#reservations` job uses this same query through
`crm/scripts/ownerrez-weekly-calendar.js --dry-run`.

For “next booking/reservation/arrival,” use the earliest primary calendar
entry rather than filtering to `type=booking`. OwnerRez uses `type=block` for
some manually entered guest stays and events, so that field alone is not proof
of owner use. `linked_availability` records are derived occupancy copies and
are not separate arrivals.

## Squarespace

The reviewed site-wide injection is `squarespace-injection-v6.html`. It loads the versioned Squarespace tracker, preserves UTMs, records contact intent, captures successful form submissions, and adds the WhatsApp attribution reference.

The separate server-side Commerce integration imports direct-booking contacts,
orders, payments, processing fees, and refunds into normalized CRM tables. It
does not replace OwnerRez as the booking/occupancy source of truth, and it does
not treat Airbnb or Vrbo payouts as Squarespace revenue. See
`../squarespace/README.md` for authentication, migration, protected API routes,
reporting, and cutover instructions.
