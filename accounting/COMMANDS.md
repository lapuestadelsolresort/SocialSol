# Accounting, receipts, and owner-ledger command reference

This is the Slack operator surface. The command-line tooling — the classifier,
the weekly integrity control, receipt-channel provisioning, FX handling — is
documented in [`accounting/README.md`](README.md) and is not repeated here.

Three distinct channel classes feed accounting, and they behave differently:

## Scoped receipt channels

Every top-level expense post by a configured member is a resort transaction that
must be documented — receipt, invoice, quotation, estimate, or a text-only
expense. **There is no command to type.** The hook re-reads the exact Slack post
and creates one bundle with one classified item per attached document, so a
single post may and should carry several receipts. Never ask anyone to split a
post or repost attachments that are already there.

The bundle then asks the submitter or the approver to press exactly one
receipt-bound payment-source button:

- **Reembolso personal** — creates one Kapital-safe reference and an itemized
  validation/payment instruction.
- **Pagado con Kapital** — no reimbursement and no reference; reconciles against
  the original business debit.
- **Ya reembolsado** — no second payment and no retroactive reference; asks for
  payment proof in the original thread.

No reference or payment instruction exists before that selection. A CLABE, bank
account number, or any other banking detail is never needed to log, classify,
reimburse, or reconcile a receipt, and is never requested or stored.

If extraction needs review, inspect the original post and correct it with
`receipt.annotate` using the exact receipt id — never reconstruct a receipt id
from chat context.

## The owner-ledger channel

Channel membership is conclusive provenance: every top-level post there was paid
personally by the configured owner and increases the configured liability. The
confirmation is typed:

```
!receipt confirm <receipt-id> <YYYY-MM-DD> <MXN|USD> <amount> <account-code> | <description>
!receipt confirm repayment <receipt-id> <YYYY-MM-DD> <MXN|USD> <amount> | <description>
```

`expense` may appear before the receipt id. An optional third `|` segment
carries a longer memo.

## The accounting channel

Kapital CSV attachments are captured automatically and processed in a fixed
order: classify → receipt reconcile → QBO write with provider readback.
Unresolved debits land in QBO Uncategorized Expense and are surfaced for category
review; they are never silently dropped.

For any reconciliation, statement breakdown, missing-transaction, or QBO
completeness question, ask in the channel — Sol runs
`accounting.reconciliation.read` and reports its durable counts with the
workflow/evidence id. Channel history is not an answer. QBO is never invoked
through a shell or ad-hoc code from this channel.

## Command timing (quiet-moment rule)

Exact `!` commands are claimed by a deterministic pre-model layer in the
gateway. Type them as their own top-level message, unmentioned, in a quiet
moment — not while the bot is mid-turn in the channel. A message that arrives
during an active bot turn can be coalesced into the next turn's conversation
history and never becomes a command event for any handler (D-026; F-051 iii,
accepted as an operational constraint). If the bot does not acknowledge within
about thirty seconds, the command did not execute: check the state it would
have changed — proposal, review, queue, or send ledger — before retyping any
mutation command.

<!-- BEGIN GENERATED: durable workflows on the accounting surface — regenerate with `npm run docs:commands` -->

### Durable workflows — Accounting, receipts, and the owner ledger

Generated from the workflow registry. Whether a mutating workflow executes for
real or is shadowed is runtime state, not repo state: ask `!help` in the channel.

| Workflow | Capability | Effects | How it runs |
| --- | --- | --- | --- |
| `accounting.classify` | `accounting.write` | mutates · autonomous | agent tool |
| `accounting.reconciliation.read` | `qbo.read` | read-only | agent tool |
| `qbo.bank_balances.read` | `qbo.read` | read-only | agent tool |
| `qbo.report.read` | `qbo.read` | read-only | agent tool |
| `qbo.write` | `qbo.write` | mutates · autonomous | agent tool |
| `receipt.annotate` | `receipts.write` | mutates | agent tool |
| `receipt.ingest` | `receipts.submit` | mutates | automatic |
| `receipt.owner_expense.confirm` | `qbo.owner_expense.write` | mutates | `!receipt confirm` |
| `receipt.owner_expense.ingest` | `qbo.owner_expense.write` | mutates | automatic |
| `receipt.owner_expense.process` | `qbo.owner_expense.write` | mutates | child run |
| `receipt.owner_expense.reconcile` | `qbo.owner_expense.write` | mutates | admin CLI |
| `receipt.payment_source.select` | `receipts.write` | mutates | buttons |
| `receipt.process` | `receipts.write` | mutates | child run |
| `receipt.reconcile` | `accounting.write` | mutates · autonomous | agent tool |
| `receipts.scoped.read` | `accounting.read_scoped` | read-only | agent tool |
| `receipts.status.read` | `receipts.read` | read-only | agent tool |

**Exact Slack commands on this surface**

- `!receipt confirm <receipt-id> <YYYY-MM-DD> <MXN|USD> <amount> <account-code> | <description>`
- `!receipt confirm repayment <receipt-id> <YYYY-MM-DD> <MXN|USD> <amount> | <description>`

  Owner-ledger confirmation; `expense` may precede the receipt id.

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
