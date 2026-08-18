# WhatsApp command reference

The WhatsApp console channel is the only human surface for guest WhatsApp
messages. It is workflow-only: shell, Twilio, and direct provider calls from the
channel are blocked by the controlled-channel tool guard.

## The invariant

**No guest-bound WhatsApp message is sent without a human typing `!wa` in
Slack** (D-001). That covers every guest-bound outbound path, including any
Regina reactivation of a WhatsApp-provenance contact. Nothing — not a workflow
retry, not an autonomous graph, not a legacy route — sends in its place.

```
!wa <wa-id> <message>
!wa <message>
```

The second form works only as a reply inside the guest's thread, where the
recipient comes from the thread. A malformed command answers with its usage and
sends nothing. Sends are serialized per guest.

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

## Delivery truth

Ask in the channel for delivery state and Sol runs `whatsapp.status.read`.
Provider acceptance, delivery, and read are distinct states and are never
inferred: a stored Twilio SID with no callback field is "no callback recorded",
not "unknown forever". Every failed or undelivered recipient is named with the
Twilio error reason and flagged as follow-up required.

<!-- BEGIN GENERATED: durable workflows on the whatsapp surface — regenerate with `npm run docs:commands` -->

### Durable workflows — WhatsApp console

Generated from the workflow registry. Whether a mutating workflow executes for
real or is shadowed is runtime state, not repo state: ask `!help` in the channel.

| Workflow | Capability | Effects | How it runs |
| --- | --- | --- | --- |
| `whatsapp.reply` | `whatsapp.send` | mutates | `!wa` |
| `whatsapp.status.read` | `whatsapp.read` | read-only | agent tool |

**Exact Slack commands on this surface**

- `!wa <wa-id> <message>`
- `!wa <message>`

  Human-typed in the WhatsApp console channel; the threaded form omits the wa-id.

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
