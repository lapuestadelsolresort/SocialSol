# Sarah email console

`#sarah-email` is the complete Slack control surface for new messages received
through Sarah's Gmail mailbox and OwnerRez channel messaging (Airbnb, Vrbo, and
other OwnerRez thread providers). Gmail and OwnerRez are transports; the CRM
conversation ledger and fixed workflow graphs are authoritative.

Every new provider conversation starts one top-level Slack message. Later
inbound messages and replies Sarah sends directly in Gmail or OwnerRez are
written back to that same Slack thread.

Questions about new, recent, today's, unread, received, or sent Gmail activity
use the read-only `email.activity.read` workflow. It queries Sarah's Gmail live
for the requested America/Los_Angeles date window and reports durable ledger
coverage separately, so a missed Slack projection cannot be mistaken for no
mail.

## Reply commands

Start replies and classifications inside the original message thread:

```text
!email reply <message>
!email classify <email-event-id> hot|not_interested|ambiguous
```

Confirm an emitted proposal anywhere in the same email channel:

```text
!email confirm <proposal-id> <acceptance-hash>
```

`!email reply` records an immutable, non-expiring proposal. Whether it also
sends depends on the runtime workflow policy. **The standing rule is
draft-and-approve (D-019): a human writes and confirms every send, on both
providers.** `email.reply.confirm` is deliberately NOT in
`autonomous_workflows`, so the same authorized Slack user must paste the exact
emitted confirmation command anywhere in the same email channel.

The auto-send mechanism exists but is dormant and policy-gated: allowlisting
`email.reply.confirm` in `autonomous_workflows` hands the proposal to the
confirm graph immediately and the reply reports the verified send with no
confirmation command. Arming is an owner-initiated decision through the D-019
arming procedure — it is not the production default. In
both modes the graph chooses Gmail or OwnerRez from the recorded inbound
event, creates one durable provider effect, and requires exact provider
readback before documenting the send in Slack. Plain Slack replies never
send, and ambiguous provider results always stop for durable manual review.

Sarah may continue replying directly in Gmail or OwnerRez. The Gmail poller and
OwnerRez message webhooks capture those outbound messages idempotently and
project them into the existing Slack conversation.

## Visibility and CRM behavior

All new Gmail mail is posted, including administrative mail and Gmail Spam;
Trash remains excluded. A
conservative deterministic sender filter decides whether a Gmail event should
also create/link a CRM inquiry and contact; filtered messages remain visible
but are labeled `Visibility only`. OwnerRez inquiry/contact records continue to
come from the authoritative OwnerRez CRM sync, while every non-draft channel
message is stored in `email_threads` with `provider='ownerrez'`.

## Verification and cutover

Read-only provider preflights:

```bash
node crm/scripts/verify-gmail-send-scope.js
node crm/scripts/verify-ownerrez-messaging-scope.js
```

Policy preview and guarded production cutover:

```bash
SARAH_EMAIL_SLACK_CHANNEL=<stable-channel-id> npm run configure:sarah-email
SARAH_EMAIL_SLACK_CHANNEL=<stable-channel-id> npm run cutover:sarah-email
```

The cutover runs both provider preflights before changing state, migrates the
ledger, adds the channel to the ignored runtime policy and OpenClaw allowlist,
installs the five-minute unified Gmail poller, retires the legacy 15-minute
inbound scanner, restarts the workflow worker and gateway, verifies the resort
Slack Socket Mode connection, and requires an acknowledged welcome post in the
channel.

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

<!-- BEGIN GENERATED: durable workflows on the sarah-email surface — regenerate with `npm run docs:commands` -->

### Durable workflows — Sarah Email

Generated from the workflow registry. Whether a mutating workflow executes for
real or is shadowed is runtime state, not repo state: ask `!help` in the channel.

| Workflow | Capability | Effects | How it runs |
| --- | --- | --- | --- |
| `email.activity.read` | `email.read` | read-only | agent tool |
| `email.message.classify` | `email.send` | read-only | `!email classify` |
| `email.message.observe` | `email.read` | read-only · autonomous | agent tool |
| `email.reply.confirm` | `email.send` | mutates | `!email confirm` or policy-armed |
| `email.reply.propose` | `email.send` | read-only | `!email reply` |

**Exact Slack commands on this surface**

- `!email classify <conversation-id> <hot|not_interested|ambiguous>`

  Records a reply classification; sends nothing.

- `!email confirm <request-id> <hash>`

  The exact emitted command, from the same user; this is the send.

- `!email reply <text>`

  Typed in the recorded conversation thread; creates an immutable proposal and sends nothing.

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
