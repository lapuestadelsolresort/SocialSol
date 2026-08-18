# Reservations and OwnerRez command reference

OwnerRez is the only authority for bookings and occupancy. The CRM's OwnerRez
sync is contact-only and is never a booking mirror, so every occupancy question
is answered by a live OwnerRez read, not from CRM rows or channel history.

## Reads

Ask in the reservations channel; Sol runs `ownerrez.occupancy.read` against a
live date window. A `type=block` entry is a manual calendar encoding that may
represent a guest stay or an event — it is never proof of owner use on its own,
and `linked_availability` records are derived copies, not separate arrivals.

## Mutations

All 34 OwnerRez operations are confirmation-gated (D-019): no autopilot for any
of them. A mutation is proposed with a preflight snapshot, returns an immutable
proposal, and emits the exact command that executes it:

```
!ownerrez confirm <request-id> <hash>
```

Same proposer, unedited, within fifteen minutes, against an unchanged
precondition. Execution happens once and is read back from OwnerRez per
operation. An ambiguous provider result opens a durable manual review in the
channel rather than guessing; the review blocks further runs until resolved.

Write access is restricted by trusted Slack user id in the control-plane policy.
There is no generic URL or method exposed — the operation catalog is fixed, and
an unknown operation or unknown key is rejected before any provider call.

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

<!-- BEGIN GENERATED: durable workflows on the reservations surface — regenerate with `npm run docs:commands` -->

### Durable workflows — Reservations and OwnerRez

Generated from the workflow registry. Whether a mutating workflow executes for
real or is shadowed is runtime state, not repo state: ask `!help` in the channel.

| Workflow | Capability | Effects | How it runs |
| --- | --- | --- | --- |
| `ownerrez.mutation.confirm` | `ownerrez.write` | mutates | `!ownerrez confirm` or policy-armed |
| `ownerrez.mutation.propose` | `ownerrez.write` | read-only | agent tool |
| `ownerrez.occupancy.read` | `ownerrez.read` | read-only | agent tool |

**Exact Slack commands on this surface**

- `!ownerrez confirm <request-id> <hash>`

  The exact emitted command, from the same proposer, inside the 15-minute window.

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
