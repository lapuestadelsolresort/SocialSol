# QC status

Updated: 2026-08-17 (PDT) — session 21 (F-058 command surface, D-023). **F-058
CLOSED verified-fixed; runtime baseline MOVED `b9ea4fe` → `15a41d6`** (PR #88, CI
verify green on the PR *and* on merged main before `release:check`, merge and
fast-forward both agent-run with no classifier block, deploy record
2026-08-18T02-44-26-838Z completed 11/11, gateway reloaded 96571 → 8184).

**The system now documents its own controls.** `scripts/generate-command-docs.js`
renders a delimited block into eight per-surface command references plus the
53-row catalog in `workflow/README.md`, and `npm run check:docs` runs inside
`check:stack` — so CI and every deploy fail when the committed blocks and the
registry disagree. Generation reads the registry, never runtime policy: the
deploy runs `check:stack` with `RESORT_WORKFLOW_POLICY_PATH` pointed at a
nonexistent file, so a policy-derived document could not be reproduced
byte-identically. Adding a workflow whose capability belongs to no surface fails
the check until a surface is assigned or the absence of an operator surface is
recorded — so a new workflow forces a docs change rather than quietly escaping
documentation.

**`!help` owns the other half.** What is armed *right now* is runtime state and
deliberately absent from the documents; `!help` answers it from
`/api/workflows/definitions?channel=`, which now scopes to one channel's
capabilities so the help surface no longer guesses which workflows a channel may
run — guessing is exactly what the hand-written docs got wrong. Verified at the
deployed SHA against live policy: its live-marked set equals `live_workflows`
**exactly, compared in both directions**.

**F-051 moved without being touched.** The owner typed `!help` in the social
channel and it claimed and replied — the **first live exact-command
(`^!`-anchored) success since the interception outage**, whose last claim of that
class was 2026-08-14 15:06 PDT. That satisfies F-051's "one live exact-command
success in a quiet channel" criterion; only the (iii) coalescing disposition
remains before it closes.

**Two corrections to F-058's own text (plan §2 — reality wins), recorded in
D-023:** `!raw` was a false positive — every hit is `if (!raw)`, a variable
negation — so seven Slack commands exist, not eight. And "`!help` renders only
policy-live workflows" could not be applied literally: shadow mode gates only
external-mutation step classes, so none of the 21 read workflows is in
`live_workflows` and a literal reading would have hidden from `!help` exactly the
workflows operators use most.

**One new finding: F-062 (P3), already dispositioned.** The social channel's
policy entry grants 7 capabilities including `crm.write`/`crm.read`, so `!help`
truthfully lists seven automatic sync/webhook/read workflows as things the
channel "can run" — 19 rows where the generated document lists 12. Docs are
surface-scoped repo truth, `!help` is capability-scoped runtime truth, and an
operator cannot tell that from either. **D-024: fix by presentation (group the
automatic ones under their own heading), not by narrowing the runtime capability
lists** — the demonstrated problem is confusion, not reachable risk, and a policy
narrowing would edit the highest-consequence file in the system to answer a
least-privilege question nobody has raised. It gets its own session if ever
wanted.

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1/#2(17)/#3(F-001)/#4(F-014)/#5(P2/P3 batch)/#6(F-058) COMPLETE (runtime baseline 15a41d6; prod main 15a41d6; policy sha 0dd75080 ARMED: marketing campaign_activate per-op only — unchanged this session, fingerprint still `match`)

## ⚠️ Standing advisory (until F-051(iii) dispositioned)

**Exact Slack commands (`!wa`, `!email confirm`, `!review resolve`, `!receipt
confirm`, `!meta confirm`, `!ownerrez confirm`) can be silently swallowed if
typed while the channel's agent (Sol) is mid-reply** — the gateway coalesces
them into the next message's history and no interception fires. Until verified
fixed: type commands top-level, unmentioned, in a quiet moment; if the bot
doesn't acknowledge within ~30s, the command did NOT execute — check before
retyping mutation commands. (Owner reported one post-0af5583 command WITH ack —
interim positive, D-018. **Session 21: an owner-typed `!help` claimed and replied
at 20:23 PDT — the first `^!` success since the outage, so the interception path
itself is proven working at 15a41d6.** The swallow risk that remains is (iii)
coalescing only: a command typed while Sol is mid-reply still never becomes an
inbound event. Ledger corroboration deferred to QC-8.)

*(The June/July Kapital statement advisory is RETIRED — F-039 closed. Re-posting
a pre-August statement no longer creates duplicate fee Purchases; the matcher
recognizes the legacy embedded format.)*

## Owner follow-ups

**New this session (F-058):**

1. **Never hand-edit inside `BEGIN GENERATED` / `END GENERATED` markers.** Eight
   command references plus `workflow/README.md` carry them. Run
   `npm run docs:commands` and commit; `npm run check:docs` (inside
   `check:stack`) fails the build otherwise.
2. **`!help` works in every channel the plugin is bound to** and is the honest
   answer to "what is armed right now" — the documents deliberately do not
   answer that.
3. **A `!`-prefixed message in a controlled channel now always gets a
   deterministic answer** instead of Sol improvising. Typing `!sent` / `!skip` /
   `!defer` in a Regina thread finally says "operator terminal only" and names
   the real script (F-048).
4. **F-062 is decided — no call needed** (D-024). `!help` gets a grouped list
   (asked-for vs runs-automatically); runtime capability lists stay as they are.
   It rides the P3 hygiene batch as the one code change in it.

**Still open from the P2/P3 batch:**

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

Open P1s: **F-051 only** (fixes deployed; **live exact-command verify DONE
2026-08-17 20:23 PDT — QCF058-05**; only the (iii) coalescing disposition remains
— QC-8 opener).
Open P2s: F-013 (gated on F-031 drill), F-023, F-025, F-006, F-029, F-033,
F-035 (remainder), F-036 (three writers remain), F-040, F-044, F-052
(**engine half closed; live Slack-path verification rides QC-8**), F-059,
F-061.
Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038,
**F-062 (new)**, F-019 (**threshold closed; browser page-JS leg is QC-6c
CANARY**). F-058 CLOSED this session.
Housekeeping: `~/fix-worktree` carries `fix/f058-command-surface` and
`~/fix-worktree2` carries `fix/p2p3-batch-workflow` (both merged, removable);
1 pending gmail email_reply_proposal exists (inert). A third `crm/server.js`
(pid 6989, Aug 7) belongs to the separate `workspace-goldroute` project on port
3458 with its own DB — not a SocialSol producer, out of scope, verified during
the F-058 post-deploy sweep.

## Next

**(1) The remaining P3 hygiene batch** — F-024, F-026, F-027, F-028, F-030,
F-034, F-037, F-038, F-021, and **F-062** — most of them one-liners (chmod, rm, a
policy key removal, doc alignment). **F-062 is the only code change in the
batch** and its shape is already decided (D-024, Option A): group `!help`'s
workflow list under two headings — workflows a person can ask for in this
channel, and workflows that run automatically and appear only because the channel
holds the capability — with a line saying so. Presentation only: no policy
change, no capability change, and the states each workflow reports must not
change. Re-verify with the F-058 both-directions live-set assertion (QCF058-03)
still holding at the deployed SHA.

**Then:** (2) QC-6c CANARY (D-004 first). (3) F-031 drill slot (D-006 window;
F-013 gated on it). (4) **QC-8** — now opens *lighter*: F-051's live
exact-command leg is done (QCF058-05), so the opener is the `!wa` fixture
battery plus the F-051(iii) coalescing disposition and its ack-corroboration
ledger pull, then Sarah email (audits the standing draft-and-approve config per
D-019), Meta DM quarantine re-verify — note `!help` now renders `meta.dm.reply`
as quarantined, which is itself a re-verify surface — and Sarah Coach.
(5) **QC-9** (OwnerRez + Paloma) — the RO map is the audit target; all 34
mutations confirmation-gated per D-019.

Definition-of-Done #3 note: F-051 is still the only open P1, and it is one
disposition away from closing. The F-031 drill must still run before baseline
stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ 15a41d6 (runtime baseline 15a41d648c48; newest deploy
record 2026-08-18T02-44-26-838Z completed 11/11; policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged, standing state, and
`node scripts/policy-fingerprint.js check` should print `match`). Then
`cd ~/qc-worktree`, read qc/STATUS.md + D-024, and begin the P3 hygiene batch
with its authorization stated on the Authorizations line (BUSINESS for the
release path; the batch is doc/config hygiene plus the one `!help` presentation
change for F-062). Note the gateway reload: `!help` lives in the plugin, and
`release:deploy` restarts only crm + worker, so the batch needs
`/bin/launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` after the deploy
and a plugin-load check, exactly as this session did.

Session-notes (classifier, session 21 / F-058): **no classifier blocks at all**
— the push, PR create, merge, fast-forward, deploy, and the gateway kickstart
were every one agent-run. Third session running with no owner-run fallback. The
only owner action needed was typing `!help` into Slack, which is not a
permissions matter: a bot-posted message cannot exercise the interception path
at all, because rendered channel configs set `allowBots: false`.

Method notes worth keeping (session 21):

- **Generate from the source the checker can reach.** The docs had to derive
  from the registry rather than the runtime policy, because the deploy runs
  `check:stack` with the policy path deliberately pointed at nothing. Getting
  that wrong would have produced a check that passes locally and fails only in
  production's own deploy.
- **A finding is a hypothesis about code that has since moved — twice over
  here.** `!raw` never existed (a grep artifact), and the "only policy-live
  workflows" criterion, applied literally, would have hidden every read
  workflow. Both were caught by reading current code rather than the finding
  text. Third consecutive session where that habit changed the design.
- **Make the docs testable, not just generated.** Every documented command
  string is fed to the real parser in the test suite. The threaded `!wa` case
  failed on the first run — proof the assertion has teeth rather than
  restating what the generator just produced.
- **The drift check was proven to fail before being trusted** (the F-056
  discipline from last session, reapplied): one generated cell flipped, exit 1
  with the right message; restored, exit 0.

Method notes worth keeping (session 20):

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
