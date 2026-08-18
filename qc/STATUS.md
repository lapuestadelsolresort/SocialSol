# QC status

Updated: 2026-08-17 (PDT) — session 20 (P2/P3 batch, D-022). **Sixteen findings
closed in one batch through the full release path; runtime baseline MOVED
`fca87c2` → `b9ea4fe`** (PRs #85/#86/#87, CI verify green on each PR *and* on
merged main before `release:check`, all three merges agent-run with no
classifier block, ff after ancestry + incoming-files proofs, deploy record
2026-08-18T01-22-04-532Z @ b9ea4fe completed 11/11). Closed: F-039, F-042,
F-043, F-046, F-047, F-048, F-049, F-050, F-053, F-054, F-055, F-056, F-057,
F-060, F-032(c) — plus the F-052 engine half and the F-019 threshold.

The two that mattered most: **F-047** — the send-time `edit_override` carve-out
downgraded *every* failed compliance item to advisory, so a contact suppressed
or marked do_not_contact after a human edit was sent to; it is now scoped to
content items 6-7 while items 1-5 always enforce. **F-039** — legacy QBO records
carry SPEI fees as Bank Fee split lines *inside* the parent Purchase, invisible
to a matcher that only knew standalone fee records, so re-uploading a June/July
statement would have created ~60 duplicate fee Purchases. The matcher now reads
embedded lines, which **retires the standing pre-August statement advisory**.

**One recorded correction (plan §2 — reality wins):** F-052's remaining item was
"engine notice fallback for channel-less runs". That fallback already existed,
and has since the cutover commit `4cad390` — `reviewChannelId` falls through run
channel → definition channel → first `write_notifications` channel bound in
`policy.channels`. What the incident actually hit was an *empty* `channel_ids`,
since filled by D-017 (RO check at close: 2 configured, both bound). The gap
genuinely open was that a review opened with no resolvable channel left no trace
at all; both review paths now record a `manual_review_unnotified` event.

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1/#2(17)/#3(F-001)/#4(F-014)/#5(P2/P3 batch) COMPLETE (runtime baseline b9ea4fe; prod main b9ea4fe; policy sha 0dd75080 ARMED: marketing campaign_activate per-op only — unchanged this session)

## ⚠️ Standing advisory (until F-051(iii) dispositioned)

**Exact Slack commands (`!wa`, `!email confirm`, `!review resolve`, `!receipt
confirm`, `!meta confirm`, `!ownerrez confirm`) can be silently swallowed if
typed while the channel's agent (Sol) is mid-reply** — the gateway coalesces
them into the next message's history and no interception fires. Until verified
fixed: type commands top-level, unmentioned, in a quiet moment; if the bot
doesn't acknowledge within ~30s, the command did NOT execute — check before
retyping mutation commands. (Owner reported one post-0af5583 command WITH ack —
interim positive, D-018; ledger corroboration deferred to QC-8.)

*(The June/July Kapital statement advisory is RETIRED — F-039 closed. Re-posting
a pre-August statement no longer creates duplicate fee Purchases; the matcher
recognizes the legacy embedded format.)*

## Owner follow-ups

**New this session:**

1. **A policy fingerprint now exists.** After any hand edit of the runtime
   `workflow/policy.json` (arming, un-arming, troubleshooting), finish with
   `node scripts/policy-fingerprint.js record --note "<why>"`. Until you do,
   `release:check` reports `policyFingerprint.status: drift` and the health job
   carries `runtime_policy_unrecorded: 1` (reported, never paging). The baseline
   recorded today is the D-020 armed policy, sha `0dd75080a85ac297…`.
2. **Regina's `!sent` / `!skip` / `!defer` are documented as terminal-only**
   (your D-022 call). If you ever want them working in Slack threads, that is
   the F-058 command-surface session, not a separate build.
3. **`accounting/config.json` is now backed up** nightly inside the encrypted
   state archive, so its receipt channels, account/vendor maps and thresholds
   survive a host loss.

**Still open from the F-014 session:**

1. **The weekly control is legitimately red** and alerts through the watchdog
   every Monday until the FAIL classes are worked (F-061): 1 never-ingested
   receipt and 4 possible duplicate bookings. Reviewed-and-accepted duplicate
   groups close by adding their QBO Purchase ids to
   `receipt_coverage.duplicate_allowlist` in the runtime
   `accounting/config.json` (a group closes only when every id in it is listed).
   Next scheduled fire: Monday 2026-08-24 08:00 PT.
2. **Tune the control's config if the defaults are wrong** (`grace_days` 7,
   `duplicate_exempt_vendors`, `start_date`). Documented in
   `accounting/README.md`.

**Still open from the F-001 session:**

1. **Make a campaign auto-activatable** by reviewing its committed brief +
   ads/landing and recording the approval:
   `python3 automation/campaign_approval.py bind-request --brief-id <id> --request-ts <ts>`
   then `… record --brief-id <id> --slack-ts <approval-ts> --apply`.
2. **Planner receipt re-record** (its pre-hash receipt reads as stale):
   `… record --brief-id planner-partner-prospecting --slack-ts 1786313311.860909 --apply`.
3. **F-059 disposition**: ratify or fix the retarget campaign's broad targeting,
   reconcile the weddings declared-status + stale `active_ad_count` fields, and
   check the WITH_ISSUES flags before any warm-adset reactivation. *(The
   reconciler now reports declared-vs-live divergence rather than swallowing it
   — F-046 — so the weddings row will surface on its next run.)*
4. **Un-arm anytime**: restore
   `~/qc-evidence/F001-FIX/policy-pre-arming-20260817T201341Z.json` over
   `workflow/policy.json` (atomic mode-600), then re-record the fingerprint.

## Blockers

None. Open D-rows: D-004 (blackout windows — load-bearing at QC-6c/QC-10),
D-007 (accounting validator), D-010 (CI scope confirm).

Open P1s: **F-051 only** (fixes deployed; live exact-command verify +
coalescing disposition remain — QC-8 opener).
Open P2s: F-013 (gated on F-031 drill), F-023, F-025, F-006, F-029, F-033,
F-035 (remainder), F-036 (three writers remain), F-040, F-044, F-052
(**engine half closed; live Slack-path verification rides QC-8**), F-059,
F-061.
Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038,
F-058, F-019 (**threshold closed; browser page-JS leg is QC-6c CANARY**).
Housekeeping: `~/fix-worktree` carries `fix/p2p3-batch-accounting` and
`~/fix-worktree2` carries `fix/p2p3-batch-workflow` (both merged, removable);
1 pending gmail email_reply_proposal exists (inert).

## Next

**(1) F-058** — the command-surface session, deferred from this batch by D-022
because it is a build rather than a fix: `COMMANDS.md` per surface generated
from `GET /api/workflows/definitions` and regenerated in the release path so
drift is structurally impossible; a marketing/Meta command reference (none
exists today for the $40/day surface); Slack `!help` rendering only
policy-live workflows plus unknown-command guidance on the `^!` interception
path; and the daily paid report appending the exact applicable commands with
real campaign ids. Re-verify: regenerated docs byte-identical in CI, `!help`
output matching `live_workflows` exactly.

**Then:** (2) the remaining P3 hygiene batch not scoped into D-022 — F-024,
F-026, F-027, F-028, F-030, F-034, F-037, F-038, F-021 — most of them
one-liners (chmod, rm, a policy key removal, doc alignment). (3) QC-6c CANARY
(D-004 first). (4) F-031 drill slot (D-006 window; F-013 gated on it).
(5) **QC-8** — OPEN with the F-051 live verification (`!wa` fixture battery in
a quiet channel) + F-051 ack-corroboration ledger pull, then Sarah email
(audits the standing draft-and-approve config per D-019), Meta DM quarantine
re-verify, Sarah Coach. (6) **QC-9** (OwnerRez + Paloma) — the RO map is the
audit target; all 34 mutations confirmation-gated per D-019.

Definition-of-Done #3 note: F-051 is the only open P1 left to reach
verified-fixed (or accepted-risk with the advisory); the F-031 drill must still
run before baseline stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ b9ea4fe (runtime baseline b9ea4fe085cc; newest deploy
record 2026-08-18T01-22-04-532Z completed 11/11; policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged, standing state; the policy
fingerprint record now exists and `node scripts/policy-fingerprint.js check`
should print `match`). Then `cd ~/qc-worktree`, read qc/STATUS.md + D-022, and
begin the F-058 session with its authorization stated on the Authorizations
line (BUSINESS for the release path; F-058 adds a generated-docs pipeline and a
new Slack `!help` surface).

Session-notes (classifier, session 20 / P2/P3 batch): **no classifier blocks at
all** — three pushes, three PR creates, three merges, the fast-forward, the
deploy, and the runtime `policy-fingerprint record` were every one agent-run.
Second session running with no owner-run fallback.

Method notes worth keeping:

- **Three PRs, not one.** Splitting the batch by subsystem (outreach / durable
  boundary / accounting+reads) kept each diff reviewable and let CI run while
  the next part was being written. Parts 2 and 3 were built off different bases,
  so the merged-main CI run was waited on before `release:check` — that run, not
  the per-PR ones, is what validates the combination.
- **A regression test that has never failed proves nothing.** The F-056 test was
  run against the reverted fix to confirm it fails with the expected message
  before being trusted. Worth doing for any test written after the fix it covers.
- **Two findings turned out to be partly wrong when traced** (F-052's engine
  fallback already existed; F-039's fix would have silently done nothing without
  moving to `SELECT *`). Both were caught by reading the current code rather
  than the finding text — the finding is a hypothesis about code that has since
  moved.
