# Paid Meta and social command reference

The `social-sol` Slack channel is the only human surface for paid Meta, the
campaign-linked landing variants, social publishing, and Meta DMs. Everything
below either runs through the durable control plane or is refused: the channel
is workflow-only, so a direct shell, Graph, or Postiz call from the channel is
blocked by the controlled-channel tool guard.

Committed briefs live beside this file. A brief is the authority for what a
campaign is allowed to be — targeting, budget, creative, and landing variant —
and the reconciler compares it against live Meta state.

## The one command you type

Reads and proposals are conversational: ask in the channel and Sol runs the
matching workflow through `resort_workflow`. A mutation is never conversational.
`marketing.change.propose` returns an immutable proposal and emits the exact
command that executes it:

```
!meta confirm <request-id> <hash>
```

It must be typed by the same person who asked for the proposal, unedited, within
fifteen minutes. Retyping it after the window, from another account, or with a
changed hash is refused. Nothing else in the channel sends a mutation to Meta.

If the bot does not acknowledge within about thirty seconds, the command did not
execute — check before retyping (standing advisory, F-051).

## What runs without you

`meta.campaign.autonomous` may **pause or decrease** a budget on its own, never
increase and never activate. It requires at least three completed local days,
healthy tracking, an unchanged live budget, unexpired evidence, a committed
brief, and no prior autonomous mutation on that campaign within 24 hours.

The **aggregate daily budget across all campaigns is owner-only** — 80.00 USD/day
at the time of recording (`optimizer_config.budget_cap_daily`). The system
enforces it at budget-increase preflight against the projected active total and
may never raise it itself. Ask Jason; it is not a system decision (D-001).

Campaign **activation** is gated on a machine-enforced creative/landing review
(F-001). Spend cannot begin while review is pending, and the gate re-enforces at
execute time, so revoking an approval stops an activation that was already
proposed.

## Meta DMs

`!dm` is **quarantined** and refused. The send path exists in the registry but
the owner never authorized the feature, so `meta.dm.reply` is barred from
`live_workflows` by a machine-enforced guard (F-020). Inbound Instagram and
Facebook DM forwarding into Slack continues; nothing sends back. Re-arming it is
a release-path change, not a runtime toggle.

## Recording a review approval

Activation preflight fails closed until a real Slack approval is bound to the
brief's exact content:

```bash
python3 automation/campaign_approval.py bind-request --brief-id <id> --request-ts <slack-ts>
python3 automation/campaign_approval.py record --brief-id <id> --slack-ts <approval-ts> --apply
python3 automation/campaign_approval.py verify --brief-id <id>
```

`record-landing` / `verify-landing` do the same for a landing variant going live.
The receipt is bound to the brief hash: editing the brief after approval
invalidates it, which is the point.

## Campaign lifecycle from the terminal

```bash
python3 automation/meta_campaign_control.py plan      --brief campaigns/<brief>.json
python3 automation/meta_campaign_control.py provision --brief campaigns/<brief>.json --apply
python3 automation/meta_campaign_control.py assert    --brief campaigns/<brief>.json
python3 automation/meta_campaign_control.py activate  --brief campaigns/<brief>.json --apply
```

`plan` and `assert` are read-only; `assert` is the drift check between the
committed brief and live Meta state. New campaigns provision **paused**.

## Reads

```bash
python3 automation/marketing_snapshot.py --date <YYYY-MM-DD>
python3 automation/daily_consolidated_report.py --dry-run
python3 automation/reconcile_marketing_state.py
```

The daily paid report posts to the channel on its own schedule and ends with the
exact commands that apply to the campaigns in that report.

<!-- BEGIN GENERATED: durable workflows on the social-sol surface — regenerate with `npm run docs:commands` -->

### Durable workflows — Paid Meta, social publishing, and Meta DMs

Generated from the workflow registry. Whether a mutating workflow executes for
real or is shadowed is runtime state, not repo state: ask `!help` in the channel.

| Workflow | Capability | Effects | How it runs |
| --- | --- | --- | --- |
| `marketing.change.confirm` | `marketing.write` | mutates | `!meta confirm` or policy-armed |
| `marketing.change.propose` | `marketing.write` | read-only | agent tool |
| `marketing.report.daily` | `marketing.read` | mutates · autonomous | agent tool |
| `marketing.snapshot.read` | `marketing.read` | read-only | agent tool |
| `meta.audience.sync` | `marketing.write` | mutates · autonomous | agent tool |
| `meta.campaign.autonomous` | `marketing.write` | mutates · autonomous | agent tool |
| `meta.dm.reply` | `social.write` | **quarantined** | `!dm` |
| `social.content.publish` | `social.publish` | mutates | agent tool |
| `social.content.read` | `social.read` | read-only | agent tool |
| `social.content.upsert` | `social.write` | mutates | agent tool |
| `social.publish_due` | `social.publish` | mutates · autonomous | agent tool |
| `social.publish_routine` | `social.publish` | mutates · autonomous | agent tool |

A **quarantined** workflow stays registered but is barred from
`live_workflows` by a machine-enforced guard, so its command is refused.
Re-arming one means removing it from `QUARANTINED_LIVE_WORKFLOWS` through
the release path — an owner-visible change, never a runtime toggle.

**Exact Slack commands on this surface**

- `!meta confirm <request-id> <hash>`

  The exact emitted command, from the same proposer, inside the 15-minute window.

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
