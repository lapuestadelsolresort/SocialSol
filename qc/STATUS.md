# QC status

Updated: 2026-08-17 (PDT) — session 17 (two halves). **17a: Sarah/OwnerRez arming
fix session ran the release path to a completed deploy — runtime baseline MOVED
`0af5583` → `1dd627ed`** (PR #80, CI verify green, owner-run REST merge during a
GitHub GraphQL outage, owner-run ff after ancestry + incoming-files proofs,
deploy record 2026-08-17T17-58-54-930Z completed 11/11). The deployed code adds
policy-gated auto-confirm dispatch to `email.reply.propose` v2 +
`ownerrez.mutation.propose` v2 (new `crm/lib/auto-confirm-dispatch.js`; confirm
graphs allow the `auto_confirm_dispatch` trigger; plugin renders the new states;
docs updated incl. the stale D-011 15-minute text). **The code is INERT: the
policy arming step NEVER RAN.** **17b: owner mid-session instruction superseded
the arming** — full stop, RO investigation instead. Proofs recorded: policy.json
sha `aa71f387` mtime 08:29 untouched end-to-end; `autonomous_workflows` contains
neither confirm workflow; staged armed-policy candidate destroyed. Rows
QCFS2-01…03 + RO17-01/02; evidence E-FIX2-01…03; new F-056 (P3 publish_due
null-snapshot latent, fail-closed) + F-057 (P3 dormant capability vs superseded
intent, rides D-019); D-018 superseded in part; **D-019 OPEN and load-bearing**.

**Owner-stated intended state (2026-08-17, 17b — supersedes the D-018 addendum):**
Paulina auto-send ENABLED (verified MATCH), Regina auto-send ENABLED (verified
MATCH), **Sarah guest replies DRAFT-AND-APPROVE** (verified MATCH behaviorally —
every send requires the human `!email confirm`, both providers; dormant dispatch
is policy-denied and FIXTURE-proven inert). The D-018 email canary is
**CANCELLED** unless D-019 revives it. Full map:
`qc/RO-2026-08-17-email-autonomy-ownerrez-mutation-map.md` — includes the
34-operation OwnerRez mutation catalog (13 destructive), the shared gate chain,
the ambiguous→review→alert trace (review always channel-bound on this surface;
success/failure/stuck-review alerts all answered), zero-production-usage fact,
and the arming-granularity constraint (per-WORKFLOW today; per-operation
autopilot needs a small `autonomous_operations` extension).

Authorizations session 17: 17a ran under D-018 (BUSINESS + OUTAGE; merges + ff
owner-run via `!` after classifier blocks; GitHub GraphQL 503s worked around via
REST). 17b was RO/FIXTURE-only by owner instruction. Note: the auto-mode
classifier intermittently blocked even RO commands (sqlite mode=ro reads, ls,
git fetch on the production path) — worked around via allowed forms; F-051
ledger corroboration of the owner's reported command ack was deferred to QC-8's
opener because of it.

## Phase ledger — QC-0…QC-7 COMPLETE + fix session #1 COMPLETE + session 17a deploy COMPLETE (runtime baseline 1dd627ed; prod main 1dd627ed; policy sha aa71f387 UN-ARMED)

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

## Blockers

**D-019 (OPEN) blocks any arming work**: per-operation OwnerRez autopilot matrix
+ dormant-dispatch disposition (keep vs revert, F-057) + ratifying Sarah
draft-and-approve as the standing D-001 row. Input = the RO map. Other open
D-rows: D-004 (blackout windows — load-bearing at QC-6c/QC-10), D-007
(accounting validator), D-010 (CI scope confirm).

Open P1s: F-001 (invariant-first fix session), F-014, F-051 (fixes deployed;
live exact-command verify + coalescing disposition remain — QC-8 opener). Open
P2s: F-013 (gated on F-031 drill), F-023, F-025, F-006, F-029, F-033, F-035
(remainder), F-036, F-039, F-040, F-045, F-044, F-047, F-052 (notice fallback +
Slack-path verify). Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034,
F-037, F-038, F-042, F-043, F-019, F-046, F-048, F-049, F-050, F-032(c),
F-053, F-054, F-055, **F-056 (publish_due null-snapshot — fold into P2/P3
batch), F-057 (rides D-019)**. Housekeeping: `~/fix-worktree` +
`fix/sarah-ownerrez-arming` branch are merged and removable; 1 pending gmail
email_reply_proposal exists (inert; human-confirmable or ignorable).

## Next

**(1) D-019 owner decision** (can be a short walkthrough): per-operation
OwnerRez autopilot (the 34-row map; `destructive` flag is a natural axis) +
keep-vs-revert the dormant dispatch (F-057) + ratify Sarah draft-and-approve
into D-001. No arming of any kind before this is recorded.

**Then:** (2) If D-019 grants any autopilot: arming fix session (release path)
— `autonomous_operations` per-op extension if a subset is granted, policy edit
via the sanctioned path with backup; if D-019 reverts: removal fix session.
(3) F-001 session (creative/landing-review invariant + regression + F-045
briefs, then Meta autonomous-activation arming per the invariant-first order).
(4) F-014 rebuild + P2/P3 batch (now incl. F-052 fallback, F-053, F-054, F-055,
F-056, F-019 threshold, F-047, F-048/49/50, F-032(c), F-042/43/46, F-039).
(5) QC-6c CANARY (D-004 first). (6) F-031 drill slot (D-006 window; F-013 gated
on it). (7) **QC-8** — OPEN with the F-051 live verification (`!wa` fixture
battery in a quiet channel) + F-051 ack-corroboration ledger pull; then Sarah
email (audits the D-019-final config), Meta DM quarantine re-verify, Sarah
Coach. (8) **QC-9** (OwnerRez + Paloma) — the RO map is the audit target; note
the surface is production-unfired. Definition-of-Done #3 note: F-051 must reach
verified-fixed (or accepted-risk with the advisory) and the F-031 drill must
run before baseline stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ 1dd627ed (runtime baseline 1dd627ed; newest deploy
record 2026-08-17T17-58-54-930Z completed; policy sha aa71f387 un-armed). Then
`cd ~/qc-worktree`, read qc/STATUS.md + D-019 + the RO map, and hold the D-019
walkthrough with the owner before any other work.
