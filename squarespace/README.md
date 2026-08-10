# Squarespace commerce integration

Squarespace Commerce is the financial source for **direct bookings only**.
OwnerRez remains the booking/occupancy source of truth for direct, Airbnb, and
Vrbo reservations. Airbnb and Vrbo payouts enter accounting only through the
Kapital statement workflow; they must never be inferred from Squarespace.

## Authentication

Create a replacement Squarespace API key after revoking any key exposed in
chat or logs. Store it outside Git at:

```text
$SOCIALSOL_SECRETS_DIR/squarespace.json
```

Use this shape and restrict the file to the service account (`chmod 600`):

```json
{
  "api_key": "replacement-key"
}
```

The key is used only by the server-side sync. It must never be added to the
Squarespace code-injection JavaScript, a browser bundle, `.env`, or Git.

Copy `squarespace/config.example.json` to the ignored
`squarespace/config.json` and review the property and department keyword maps.

## Migration and sync

From the repository root:

```bash
npm run migrate:squarespace -- --dry-run
npm run migrate:squarespace
npm run sync:squarespace -- --full --dry-run
npm run sync:squarespace -- --full
npm run sync:squarespace
```

The client is deliberately read-only against Squarespace. A full sync imports
contacts, orders, payments, fees, and refunds; later runs use overlapping
watermarks. Re-running either mode is idempotent.

Commerce customers are merged into the CRM by Squarespace customer ID or
normalized email. Order contacts are tagged `My Website`, and the order source
is always `direct`. Marketing consent is retained separately and is not
inferred from a purchase.

OwnerRez links are conservative: explicit mappings or matching guest/date
evidence are accepted; ambiguous records remain in the review queue. The sync
does not create or edit OwnerRez bookings.

## Agent access and reports

Protected CRM routes expose normalized data without credentials or raw
provider payloads:

- `GET /api/squarespace/summary`
- `GET /api/squarespace/orders`
- `GET /api/squarespace/orders/:orderId`
- `GET /api/squarespace/reconciliation`
- `GET|POST /api/squarespace/expense-links`

Preview pending agent reports with:

```bash
npm run report:squarespace -- --all
```

Slack delivery requires both `--post` and
`SQUARESPACE_SLACK_ENABLED=1`. Channel IDs and the OpenClaw Slack account come
from environment configuration. The audiences are `#business-intel`,
`#accounting`, `#reservations`, and the configured housekeeping channel.

The daily social/campaign report includes a separate, non-attributed
Squarespace commerce line. Traffic and campaign attribution continue through
the existing browser tracker and Meta Pixel; order revenue is not falsely
assigned to a campaign without an attribution key.

LaunchAgent templates are provided for the five-minute sync and ten-minute
report jobs. Rendering is safe; installing/loading them is a separate
production cutover and should happen only after the replacement key and Slack
switches are verified.
