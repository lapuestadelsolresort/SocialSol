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

Run these only inside the original message thread:

```text
!email reply <message>
!email confirm <proposal-id> <acceptance-hash>
!email classify <email-event-id> hot|not_interested|ambiguous
```

`!email reply` records an immutable, non-expiring proposal; it does not send. The
same authorized Slack user must paste the exact emitted confirmation command in
the same channel and thread. The graph chooses Gmail or OwnerRez from the
recorded inbound event, creates one durable provider effect, and requires exact
provider readback before documenting the send in Slack. Plain Slack replies and
top-level commands never send.

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
