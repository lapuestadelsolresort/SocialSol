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

Every standard receipt post is captured as a single bundle with one child item
per attached receipt. Before classification can issue a payment instruction,
the submitter or configured payment approver must choose one receipt-bound
Slack button: `Reembolso personal`, `Pagado con Kapital`, or `Ya reembolsado`.
The selection is durable and immutable without manual accounting review.
Personal reimbursements then receive an itemized reply in the original Slack
thread with a stable, alphanumeric-only `LPDSR…` Kapital concept for the
configured payment approver to copy exactly. Business-paid expenses create no
reimbursement or code and reconcile against the original Kapital debit.
Already-reimbursed expenses create no second payment or retroactive code and
request payment proof in the original thread. Multi-attachment posts are never
split or reposted, and Mayela-facing validation/payment instructions are in
Spanish. New referenced reimbursements
reconcile on that exact concept plus amount and currency; the legacy ±3-day
rule is used only for older receipts that have no payment reference. Receipt
annotation and reference generation never need a CLABE, bank-account number,
or bank name. When proof shows a transfer was already completed without the
workflow reference, the receipt is marked already paid, no duplicate transfer
instruction is issued, and its actual description plus non-sensitive payment
folio are preserved for legacy reconciliation. A top-level payment-confirmation
PDF is held for linkage to the original bundle and cannot generate another
payable reimbursement or payment code. A matched
bundle is written to QBO with one expense line per receipt item so mixed
categories remain split even though Kapital contains one reimbursement.
If an uncoded transfer has the same payee, currency, and amount within 30 days
of a successfully reconciled coded reimbursement, it is held as a possible
duplicate instead of being auto-posted.

Before any QBO write, overlapping transactions are checked through the
refresh-aware QBO client. An expired access token is refreshed automatically;
if authentication, the duplicate query, or its response cannot be verified,
the statement fails closed before creating any QBO entity. The completion
message in `#accounting` reports run-scoped principal writes, separate SPEI fee
records, deduplicated transactions, and every transaction held for review.
It is posted to the channel without tagging global workflow reviewers.

A Kapital CSV attached in `#accounting` is refetched from the exact Slack
message and atomically staged in `accounting/inbox/`. The inbox processor then
runs one fixed sequence keyed by the file hash: `accounting.classify`,
`receipt.reconcile`, and `qbo.write`. Controlled-channel tool enforcement
blocks shell or direct-QBO bypasses, so the final notification represents the
single durable statement run rather than a mixture of ad-hoc and workflow
writes. Accounting attachments are claimed at OpenClaw's terminal pre-model
dispatch boundary: finalized media metadata selects the handler, and exact
provider readback authorizes staging. The deterministic acknowledgement stops
the chat model from attempting direct QBO calls or inventing alternate staging
instructions. Content hashes are checked against both the active inbox and the
successful processed archive. An exact retry is reported as already queued or
already processed and cannot reuse a workflow idempotency key with a different
path or create a second QBO run.

Configure the Slack user(s) who submit Kapital reimbursements. The command is
a dry run unless `--confirm-production` is supplied and backs up the ignored
runtime config before changing it:

```bash
npm run configure:receipt-payments -- \
  --payment-approver-id U0XXXXX

# After inspecting the dry-run output, repeat with:
# --confirm-production
```

Use the guarded configurator to update both ignored runtime files together.
It is a dry run unless `--confirm-production` is supplied:

```bash
npm run configure:receipt-channel -- \
  --channel-id C0XXXXX --channel-name receipts-pettycash \
  --scope sergio --description "Sergio petty cash receipts and invoices" \
  --person-id U0XXXXX

# After inspecting the dry-run output, repeat with:
# --confirm-production
```

### Owner-paid expense channels

An owner-expense channel is also listed under `owner_expense_channels` with
the owner's name, exact QBO liability account ID/name, repayment bank account,
and an automatic-post confidence threshold. Use the production-safe configurator rather than
editing both runtime files independently:

```bash
npm run configure:owner-expense-channel -- \
  --channel-id C0XXXXX --channel-name receipt-owner \
  --owner-name "Owner Name" \
  --liability-account-id 123 --liability-account-name "Due to Owner (Net)" \
  --repayment-bank-account-id 456 --repayment-bank-account-name "Operating Bank"

# After inspecting the dry-run output:
npm run configure:owner-expense-channel -- \
  --channel-id C0XXXXX --channel-name receipt-owner \
  --owner-name "Owner Name" \
  --liability-account-id 123 --liability-account-name "Due to Owner (Net)" \
  --repayment-bank-account-id 456 --repayment-bank-account-name "Operating Bank" \
  --confirm-production
```

Uploads are acknowledged in their Slack thread. Membership in an owner-expense
channel is conclusive provenance: every top-level post is a business expense
paid personally by that channel's configured owner, including attachment-only
payment confirmations whose bank or app name could otherwise be ambiguous.
High-confidence owner-paid business expenses become a balanced QBO
JournalEntry: debit the selected expense account and credit the configured
Other Current Liability account. Missing or genuinely ambiguous document facts
are saved as `needs_review` and emit an exact `!receipt confirm ...` command;
they are never posted speculatively. An exceptional accounting reclassification
as an owner repayment remains possible only through an explicit repayment
confirmation. It creates a QBO Purchase that debits the owner liability and
credits the configured bank, with an exact-date/amount/bank duplicate preflight
before the write; automatic extraction never infers a repayment from a post in
the owner-expense channel.

If a QBO owner-ledger entity was created outside the durable workflow, reconcile
it instead of confirming the pending receipt (which could create a duplicate).
The command is dry-run by default and, in production mode, verifies the existing
QBO ID, date, USD amount, debit/credit accounts, and receipt source reference
before recording the effect, evidence, and posted receipt projection. It never
creates a QBO transaction:

```bash
npm run reconcile:owner-expense -- \
  --receipt-id <receipt-uuid> --qbo-id <existing-qbo-id> \
  --date YYYY-MM-DD --currency MXN --amount 4400 --amount-usd 255.37 \
  --fx-rate 17.23 --category-key maintenance \
  --vendor "Vendor Name" --description "Business purpose" \
  --source-reference <receipt-reference>

# After inspecting the dry-run output, repeat with:
# --confirm-production
```

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
