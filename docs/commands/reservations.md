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

**Proposing an OwnerRez change — `ownerrez.mutation.propose` input contract**

Ask in the channel; the agent calls the `resort_workflow` tool with
`workflow: "ownerrez.mutation.propose"` and an `input` carrying:

- `operationId` — one of the 34 catalog ids below, spelled exactly
- `pathParams` — the `{…}` fields of the operation path (integers)
- `query` — only for operations that declare query parameters
- `body` — an object (or array where allowed) for POST/PATCH operations; omitted for DELETE
- `reason` — 4–500 characters, recorded with the proposal

There is no per-operation allowlist at proposal time: every id below may be
proposed, the server validates the id and the request shape before any
provider call, and nothing changes in OwnerRez until the same user types the
emitted `!ownerrez confirm <request-id> <hash>` within 15 minutes. The catalog
itself lives in `crm/lib/ownerrez-mutation-catalog.js`.

| Operation id | Method | Path | Path params | Query params | Body |
| --- | --- | --- | --- | --- | --- |
| `Bookings_Patch` | PATCH | `/v2/bookings/{id}` | `id` | — | object or array |
| `Bookings_Post` | POST | `/v2/bookings` | — | — | object |
| `Discounts_Delete` | DELETE | `/v2/discounts/{id}` | `id` | — | — |
| `Discounts_Patch` | PATCH | `/v2/discounts/{id}` | `id` | — | object or array |
| `Discounts_Post` | POST | `/v2/discounts` | — | — | object |
| `FieldDefinitions_Delete` | DELETE | `/v2/fielddefinitions/{id}` | `id` | — | — |
| `FieldDefinitions_Patch` | PATCH | `/v2/fielddefinitions/{id}` | `id` | — | object or array |
| `FieldDefinitions_Post` | POST | `/v2/fielddefinitions` | — | — | object |
| `Fields_ByDefinition` | DELETE | `/v2/fields/bydefinition` | — | `field_definition_id`, `entity_id`, `entity_type` | — |
| `Fields_Delete` | DELETE | `/v2/fields/{id}` | `id` | — | — |
| `Fields_Patch` | PATCH | `/v2/fields/{id}` | `id` | — | object or array |
| `Fields_Post` | POST | `/v2/fields` | — | — | object |
| `Guests_Delete` | DELETE | `/v2/guests/{id}` | `id` | — | — |
| `Guests_DeleteAddress` | DELETE | `/v2/guests/{id}/addresses/{address_id}` | `id`, `address_id` | — | — |
| `Guests_DeleteEmailAddress` | DELETE | `/v2/guests/{id}/emailaddresses/{email_address_id}` | `id`, `email_address_id` | — | — |
| `Guests_DeletePhone` | DELETE | `/v2/guests/{id}/phones/{phone_id}` | `id`, `phone_id` | — | — |
| `Guests_Patch` | PATCH | `/v2/guests/{id}` | `id` | — | object or array |
| `Guests_Post` | POST | `/v2/guests` | — | — | object |
| `Messages_Post` | POST | `/v2/messages` | — | — | object |
| `Quotes_Delete` | DELETE | `/v2/quotes/{id}` | `id` | — | — |
| `Quotes_Patch` | PATCH | `/v2/quotes/{id}` | `id` | — | object or array |
| `Quotes_Post` | POST | `/v2/quotes` | — | — | object |
| `SpotRates_Patch` | PATCH | `/v2/spotrates` | — | — | — |
| `Surcharges_Delete` | DELETE | `/v2/surcharges/{id}` | `id` | — | — |
| `Surcharges_Patch` | PATCH | `/v2/surcharges/{id}` | `id` | — | object or array |
| `Surcharges_Post` | POST | `/v2/surcharges` | — | — | object |
| `TagDefinitions_Delete` | DELETE | `/v2/tagdefinitions/{id}` | `id` | — | — |
| `TagDefinitions_Patch` | PATCH | `/v2/tagdefinitions/{id}` | `id` | — | object or array |
| `TagDefinitions_Post` | POST | `/v2/tagdefinitions` | — | — | object |
| `Tags_ByName` | DELETE | `/v2/tags/byname` | — | `name`, `entity_id`, `entity_type` | — |
| `Tags_Delete` | DELETE | `/v2/tags/{id}` | `id` | — | — |
| `Tags_Post` | POST | `/v2/tags` | — | — | object |
| `WebhookSubscriptions_Delete` | DELETE | `/v2/webhooksubscriptions/{id}` | `id` | — | — |
| `WebhookSubscriptions_Post` | POST | `/v2/webhooksubscriptions` | — | — | object |

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
