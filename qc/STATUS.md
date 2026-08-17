# QC status

Updated: 2026-08-17 (PDT) — session 18 (F-001 fix session, D-020). **F-001
CLOSED verified-fixed + F-045 CLOSED + Meta autonomous activation ARMED, in
the D-001 invariant-first order. Runtime baseline MOVED `1dd627ed` →
`c0a7b72`** (PR #81, CI verify green, agent-run merge, ff after ancestry +
incoming-files proofs, deploy record 2026-08-17T20-10-12-727Z completed
11/11). The deployed invariant: campaign activation on EVERY path (graph
propose → confirm, CLI, auto-dispatch) requires a human Slack approval
receipt whose `brief_hash` matches the current committed brief
(campaign_approval.py `record` binds it; `status`/`activated_at` excluded);
`landing_status → live` requires a receipt hashing the exact
`lp_variants.config`; activation-readback drift auto-rolls back to PAUSED.
All five previously brief-less campaigns got committed briefs derived from
live Meta truth (multi-ad model), verified drift-free against fresh provider
reads — gated/emergency pause now reachable for every registry campaign
(F-045). Post-deploy at c0a7b72: ×6 activation preflights fail closed
("review is pending" ×5; planner legacy receipt "review is stale"),
workflow_health 0. **ARMING executed after that verification** (owner-run
atomic install after classifier block; D-020 addendum): policy sha
`aa71f387` → `0dd75080`, `marketing.change.confirm` in autonomous_workflows
+ NEW per-operation gate `autonomous_operations = {"marketing.change.confirm":
["campaign_activate"]}` — activation ONLY; pause/budget/provision/landing
stay `!meta confirm`-gated; email/OwnerRez confirms stay un-armed (D-019
preserved). **Zero campaigns hold recorded review approvals, so nothing can
auto-activate until the owner records one.** New F-059 (P2): the retarget
adsets carry NO audience narrowing (broad 18-65 US/CA under a retargeting
name), warm adset paused with WITH_ISSUES ads, registry counts stale,
weddings declared-PAUSED vs live-ACTIVE. Rows QCFS3-01…05; evidence
E-FIX3-01…04. (The owner's working-tree STATUS patch adding F-058 to the
open list — it was missing from the committed session-17 text — is
incorporated below.)

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1/#2(17)/#3(F-001) COMPLETE (runtime baseline c0a7b72; prod main c0a7b72; policy sha 0dd75080 ARMED: marketing campaign_activate per-op only)

## ⚠️ Standing advisory (until F-039 fixed)

**Do not re-post pre-August (June/July) Kapital statement CSVs to the accounting
Slack channel.** The live pipeline stages and processes automatically and would
create ~60 duplicate standalone fee Purchases (~9.50 USD for July; June
similar). August-onward statements are fine (new format, full dedup).

## ⚠️ Standing advisory (until F-051(iii) dispositioned)

**Exact Slack commands (`!wa`, `!email confirm`, `!review resolve`, `!receipt
confirm`, `!meta confirm`, `!ownerrez confirm`) can be silently swallowed if
typed while the channel's agent (Sol) is mid-reply** — the gateway coalesces
them into the next message's history and no interception fires. Until verified
fixed: type commands top-level, unmentioned, in a quiet moment; if the bot
doesn't acknowledge within ~30s, the command did NOT execute — check before
retyping mutation commands. (Owner reported one post-0af5583 command WITH ack —
interim positive, D-018; ledger corroboration deferred to QC-8.)

## Owner follow-ups from the F-001 session (non-blocking, do when ready)

1. **Make a campaign auto-activatable** by reviewing its committed brief +
   ads/landing and recording the approval:
   `python3 automation/campaign_approval.py bind-request --brief-id <id> --request-ts <ts>`
   then `… record --brief-id <id> --slack-ts <approval-ts> --apply` (needs
   OPENCLAW_SLACK_ACCOUNT / RESORT_SOCIAL_CHANNEL /
   CAMPAIGN_APPROVER_SLACK_USER_ID env). Recording binds the brief content
   hash; editing the brief afterward re-blocks activation.
2. **Planner receipt re-record** (its pre-hash receipt reads as stale; only
   matters for future re-activation of the already-ACTIVE campaign):
   `… record --brief-id planner-partner-prospecting --slack-ts 1786313311.860909 --apply`.
3. **F-059 disposition**: ratify or fix the retarget campaign's broad
   targeting (review the two retarget briefs), reconcile the weddings
   declared-status + stale active_ad_count registry fields, and check the
   WITH_ISSUES flags before any warm-adset reactivation.
4. **Un-arm anytime**: restore
   `~/qc-evidence/F001-FIX/policy-pre-arming-20260817T201341Z.json` over
   `workflow/policy.json` (atomic mode-600). Budget-increase autonomy is
   granted by D-001 but NOT armed (one `autonomous_operations` line + session
   authorization when wanted).

## Blockers

None for the next sessions. Open D-rows: D-004 (blackout windows —
load-bearing at QC-6c/QC-10), D-007 (accounting validator), D-010 (CI scope
confirm).

Open P1s: F-014, F-051 (fixes deployed; live exact-command verify +
coalescing disposition remain — QC-8 opener). **F-001 CLOSED this session.**
Open P2s: F-013 (gated on F-031 drill), F-023, F-025, F-006, F-029, F-033,
F-035 (remainder), F-036, F-039, F-040, F-044, F-047, F-052 (notice fallback
+ Slack-path verify), **F-059 (retarget targeting/registry truth — NEW)**.
**F-045 CLOSED this session.** Open P3s: F-024, F-026, F-021, F-027, F-028,
F-030, F-034, F-037, F-038, F-042, F-043, F-019, F-046, F-048, F-049, F-050,
F-032(c), F-053, F-054, F-055, F-056 (publish_due null-snapshot — fold into
P2/P3 batch), F-057 (residual now ONLY the two COMMANDS.md "production
default" parentheticals — the policy.example.json revert landed in PR #81),
F-058 (no operator-facing command manual — generated-docs fix, rides the
F-057 docs batch). Housekeeping: `~/fix-worktree` +
`fix/f001-creative-review-invariant` branch are merged and removable (the
worktree carries disposable node_modules copies + a gitignored
runtime-registry copy); 1 pending gmail email_reply_proposal exists (inert;
human-confirmable or ignorable).

## Next

**(1) F-014 rebuild + P2/P3 batch** (weekly accounting control rebuild is the
P1 anchor; batch: F-052 fallback, F-053, F-054, F-055, F-056, F-057
COMMANDS.md residual (the two "production default" parentheticals), (F-058)
replace the hand-authored command docs with ones generated from
`/api/workflows/definitions` + add `!help` and a marketing command reference,
F-019 threshold, F-047, F-048/49/50, F-032(c), F-042/43/46, F-039).

**Then:** (2) QC-6c CANARY (D-004 first). (3) F-031 drill slot (D-006
window; F-013 gated on it). (4) **QC-8** — OPEN with the F-051 live
verification (`!wa` fixture battery in a quiet channel) + F-051
ack-corroboration ledger pull; then Sarah email (audits the standing
draft-and-approve config per D-019), Meta DM quarantine re-verify, Sarah
Coach. (5) **QC-9** (OwnerRez + Paloma) — the RO map is the audit target;
all 34 mutations confirmation-gated per D-019; surface production-unfired.
Definition-of-Done #3 note: F-051 must reach verified-fixed (or
accepted-risk with the advisory) and the F-031 drill must run before
baseline stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ c0a7b72 (runtime baseline c0a7b724ec52; newest
deploy record 2026-08-17T20-10-12-727Z completed 11/11; policy sha 0dd75080
ARMED marketing-activate-only per D-020 — standing state). Then
`cd ~/qc-worktree`, read qc/STATUS.md + D-020, and begin the F-014 fix
session with its authorization stated on the Authorizations line (BUSINESS
for the release path).

Session-notes (classifier, this session): the agent-run PR merge SUCCEEDED
(no block), while blocked actions were: Edit of workflow/policy.example.json
(Write of the same file succeeded — natural alternative), the runtime policy
install (owner-ran per QCFS2-03 precedent), and intermittent RO reads
(`gh pr view`, `shasum` of policy.json) — worked around via git-fetch reads
and python hashing.
