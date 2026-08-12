# Kapital Transaction Classifier

Parses Kapital Bank (Mexico) CSV statements and classifies each transaction
into QuickBooks Online expense/income categories. Converts MXN → USD using
the Banxico daily FIX rate.

Squarespace Commerce is a separate direct-booking financial feed. Its orders,
payments, processing fees, and refunds are imported into the CRM for
reconciliation and receipt association. Airbnb and Vrbo payouts are not
Squarespace orders; they enter accounting only through Kapital statements.

## Files

| File | Purpose |
|---|---|
| `config.json` | All configuration: receipt channels, QBO accounts, vendors, salary patterns. **Add new channels/vendors here.** |
| `kapital_parser.py` | Parses the quirky Kapital CSV format. Groups SPEI triplets (transfer + comisión + IVA). |
| `classifier.py` | Three-tier rule engine: auto → guess → unknown. Also has `format_classification_report()`. |
| `fx_rates.py` | MXN/USD exchange rate via Banxico API (with cache + fallback). |
| `run_classify.py` | Main entry point. Dry-run by default. |
| `fx_cache/` | Cached daily FX rates (auto-created). |

## Usage

```bash
# Dry run (default) — classify and report, no QBO push
python3 accounting/run_classify.py <kapital_csv_file>

# Skip FX conversion (MXN-only report)
python3 accounting/run_classify.py <kapital_csv_file> --no-fx

# JSON output for programmatic use
python3 accounting/run_classify.py <kapital_csv_file> --json
```

## Adding a New Receipt Channel

Edit `config.json` → `receipt_channels`. Add a new entry:

```json
"C0XXXXX": {
  "name": "#channel-name",
  "scope": "who_or_what",
  "description": "What gets posted here",
  "people": ["U_SLACK_ID"]
}
```

The classifier references channels in `needs_channel_check` so Sol knows
where to look for context on ambiguous transactions.

### Owner-paid expense channels

An owner-expense channel is also listed under `owner_expense_channels` with
the owner's name, exact QBO liability account ID/name, and an automatic-post
confidence threshold. Use the production-safe configurator rather than
editing both runtime files independently:

```bash
npm run configure:owner-expense-channel -- \
  --channel-id C0XXXXX --channel-name receipt-owner \
  --owner-name "Owner Name" \
  --liability-account-id 123 --liability-account-name "Due to Owner (Net)"

# After inspecting the dry-run output:
npm run configure:owner-expense-channel -- \
  --channel-id C0XXXXX --channel-name receipt-owner \
  --owner-name "Owner Name" \
  --liability-account-id 123 --liability-account-name "Due to Owner (Net)" \
  --confirm-production
```

Uploads are acknowledged in their Slack thread. High-confidence owner-paid
business expenses become a balanced QBO JournalEntry: debit the selected
expense account and credit the configured Other Current Liability account.
Ambiguous or contradictory documents are saved as `needs_review` and emit an
exact `!receipt confirm ...` command; they are never posted speculatively.

## Adding a New Vendor

Edit `config.json` → `vendors`. Add:

```json
"vendor_key": { "id": "QBO_VENDOR_ID", "name": "Display Name", "clabe_hint": "optional_CLABE" }
```

Then add matching rules in `classifier.py` → `_tier1_exact()`.

## Classification Tiers

1. **Auto** — High confidence. Known payee + known concept keyword. No review needed.
2. **Guess** — Likely correct but needs confirmation. Petty cash reimbursements, ambiguous amounts.
3. **Unknown** — Can't classify. Sol pings Mayela or Jason in the appropriate receipt channel.
