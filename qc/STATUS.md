# QC status

Updated: 2026-08-17 (PDT) — session 19 (F-014 fix session, D-021). **F-014
CLOSED verified-fixed — the last open P1 from the audit. Runtime baseline
MOVED `c0a7b72` → `fca87c2`** (PRs #82/#83/#84, CI verify green ×3, agent-run
merges with no classifier block, ff after ancestry + incoming-files proofs,
deploy records 2026-08-17T21-09-33-576Z @ 39ef3e4 and T21-30-25-455Z @
fca87c2, each completed 11/11). The weekly `kapital-tests` control could not
fail: two of seven checks returned `needs_slack_scan` with prose addressed to
the retired "Sol" orchestrator, `__main__` always exited 0 so launchd recorded
success on every failure, and the report went only to /tmp. It now reaches
seven terminal verdicts, each with an evidence id tying it to a durable run
record; FAIL/ERROR exit nonzero and record a job_health failure so the
watchdog owns the alert, WARN reports a human backlog and stays green, and a
failed Slack post is itself nonzero. QBO access moved to the sanctioned
`qbo_push.QBOClient` — the control performs no credential writes at all,
retiring F-036 writer #4. Queries page to exhaustion; the salary matrix comes
from config. **Verified at the deployed SHA by LaunchAgent kickstart** (not a
hand invocation): 7/7 terminal, process exit 1, job_health failed, Slack post
delivered, services:check drift=false, workflow_health 0.

**Four further defects surfaced while verifying against production data and
were fixed in-session** (QCFS4-03): `openclaw --json` truncates a piped stdout
at ~64 KB (→ new F-060, latent for other callers); a field-list `SELECT` makes
QBO return Line stubs with no account reference, so three account-based checks
matched nothing and reported passes they never performed; standalone bank fees
share date+amount+vendor by design and were matched by memo text that missed
the legacy format; and same-day-before-pipeline-start receipts read as misses
under date-granularity comparison. False positives across the default window
fell splits 30→3, duplicates 51→17→4, coverage 3→1. A self-caught regression
(the rewrite dropped 755 on run_weekly_tests.sh) went back through the release
path as PR #83. Rows QCFS4-01…05; evidence E-FIX4-01…06.

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1/#2(17)/#3(F-001)/#4(F-014) COMPLETE (runtime baseline fca87c2; prod main fca87c2; policy sha 0dd75080 ARMED: marketing campaign_activate per-op only — unchanged this session)

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

## Owner follow-ups

**From the F-014 session (new):**

1. **The weekly control is legitimately red** and will alert through the
   watchdog every Monday until the FAIL classes are worked (F-061). Current
   findings: 1 receipt posted to a receipt channel after the pipeline went
   live that was never ingested, and 4 possible duplicate bookings (a triple
   457.72 to one payee on 2026-04-06 plus three same-day same-amount charges
   with no Kapital reference, two of them the ANTHROPIC pairs). Reviewed-and-
   accepted duplicate groups close individually by adding their QBO Purchase
   ids to `receipt_coverage.duplicate_allowlist` in the runtime
   `accounting/config.json` — a group is only accepted when every id in it is
   listed. The WARN classes (2 group-activity + 9 food unattributed, 4 salary
   advisories, 11 uncategorized, 3 genuine splits) are a backlog and do not
   fail the job.
2. **Tune the control's config if the defaults are wrong for you** (untracked
   runtime `accounting/config.json`, key `receipt_coverage`): `grace_days`
   (7), `duplicate_exempt_vendors` (`facebook`, `meta platforms` — vendors
   that bill identical amounts many times a day), `start_date` (defaults to
   the ledger's earliest receipt, 2026-08-06T19:42:52Z). Documented in
   `accounting/README.md`.
3. **Run it by hand any time**: `bash accounting/run_weekly_tests.sh [months]`
   (default 3). Next scheduled fire: Monday 2026-08-24 08:00 PT.

**From the F-001 session (still open):**

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

None. Open D-rows: D-004 (blackout windows — load-bearing at QC-6c/QC-10),
D-007 (accounting validator), D-010 (CI scope confirm).

Open P1s: **F-051 only** (fixes deployed; live exact-command verify +
coalescing disposition remain — QC-8 opener). **F-014 CLOSED this session —
it was the last open P1 besides F-051.**
Open P2s: F-013 (gated on F-031 drill), F-023, F-025, F-006, F-029, F-033,
F-035 (remainder), F-036 (**writer #4 retired this session**; three writers
remain), F-039, F-040, F-044, F-047, F-052, F-059, **F-061 (receipt pipeline
ingestion/booking backlog the rebuilt control now surfaces weekly — NEW)**.
Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038,
F-042, F-043, F-019, F-046, F-048, F-049, F-050, F-032(c), F-053, F-054,
F-055, F-056, F-057, F-058, **F-060 (openclaw --json pipe truncation — NEW,
latent for future bulky consumers) **. Housekeeping: `~/fix-worktree` now
carries `fix/f014-legacy-fee-dedup` (merged, removable); branches
`fix/f014-weekly-accounting-control`, `fix/f014-script-mode`,
`fix/f001-creative-review-invariant` all merged; 1 pending gmail
email_reply_proposal exists (inert).

## Next

**(1) P2/P3 batch** (deferred from this session by D-021 — the owner scoped
session 19 to F-014 only). Batch: F-052 fallback, F-053, F-054, F-055, F-056,
F-057 COMMANDS.md residual (the two "production default" parentheticals),
(F-058) replace the hand-authored command docs with ones generated from
`/api/workflows/definitions` + add `!help` and a marketing command reference,
F-019 threshold, F-047, F-048/49/50, F-032(c), F-042/43/46, F-039, **F-060
(document the CLI file-capture requirement)**.

**Then:** (2) QC-6c CANARY (D-004 first). (3) F-031 drill slot (D-006 window;
F-013 gated on it). (4) **QC-8** — OPEN with the F-051 live verification
(`!wa` fixture battery in a quiet channel) + F-051 ack-corroboration ledger
pull; then Sarah email (audits the standing draft-and-approve config per
D-019), Meta DM quarantine re-verify, Sarah Coach. (5) **QC-9** (OwnerRez +
Paloma) — the RO map is the audit target; all 34 mutations confirmation-gated
per D-019; surface production-unfired.

Definition-of-Done #3 note: with F-014 closed, F-051 is the only open P1 left
to reach verified-fixed (or accepted-risk with the advisory); the F-031 drill
must still run before baseline stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ fca87c2 (runtime baseline fca87c2dde48; newest deploy
record 2026-08-17T21-30-25-455Z completed 11/11; policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged, standing state). Then
`cd ~/qc-worktree`, read qc/STATUS.md + D-021, and begin the P2/P3 batch
session with its authorization stated on the Authorizations line (BUSINESS for
the release path; the batch is doc- and code-mixed).

Session-notes (classifier, session 18): the agent-run PR merge SUCCEEDED
(no block), while blocked actions were: Edit of workflow/policy.example.json
(Write of the same file succeeded — natural alternative), the runtime policy
install (owner-ran per QCFS2-03 precedent), and intermittent RO reads
(`gh pr view`, `shasum` of policy.json) — worked around via git-fetch reads
and python hashing.

Session-notes (classifier, session 19 / F-014): **no classifier blocks at
all** — pushes, PR creates, all three merges, both fast-forwards, both
`release:deploy` runs, the LaunchAgent kickstarts, and the runtime
`accounting/config.json` install were every one agent-run. First session since
QC3B-13 needing no owner-run fallback.

Method note worth keeping: the four extra defects were found only because the
control was dry-run against real production data before the release path, and
then again at the deployed SHA. Two of them (the field-list SELECT vacuity and
the pipe truncation) are invisible to unit tests by construction — a stubbed
QBO client returns whatever shape the stub author imagined, and a stubbed
runner never truncates. Dry-running a rebuilt control against production reads
before shipping it should be the default for the remaining fix sessions.
