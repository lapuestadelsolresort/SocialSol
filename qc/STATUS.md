# QC status

Updated: 2026-08-20 (PDT) — session 28 concluded (**RO-only session: D-004
ANSWERED and recorded (CANARY/OUTAGE/BUSINESS = weekdays 10:00–16:00 PT only,
never during active sends or guest quiet hours, live-state preflight per
action, §5 session authorization still required) + QC-6c RO prep COMPLETE —
the canary session plan/runbook is committed at
`qc/QC6C_CANARY_SESSION_PLAN.md` and the full funnel contract is pinned at
e04c2a8 with file:line evidence (QC6C-00, E-QC6C-00). QC-6c is now blocked
ONLY on an Authorizations-line CANARY grant + a D-004 window slot.**).
Authorization consumed this session: none — the Authorizations line was blank;
everything ran RO (one working-tree restore of a committed qc/ file; zero
production writes; prod verified clean at e04c2a8 with policy sha `0dd75080`
fingerprint `match` + `agreement: ok`).

Session-start facts (ritual, all green): prod clean on main @ **e04c2a8** —
exactly the expected post-boundary HEAD; `git diff --stat ba47469 e04c2a8 --
. ':(exclude)qc'` EMPTY (serving code byte-identical to runtime baseline
ba47469); branch tip 246d194 in sync with origin. One working-tree anomaly:
`qc/STATUS.md` was deleted (uncommitted) from the worktree — **owner
confirmed in-session the deletion was their own action**; restored from HEAD
(`git checkout -- qc/STATUS.md`), worktree clean, no finding.

**Delivered (session 28):** (1) **D-004 recorded** in qc/DECISIONS.md
(unblocks QC-6c scheduling, F-031 drill scheduling, QC-10 drills);
(2) **QC-6c canary plan** committed — synthetic marking `qc6c-<uuid4>` sid
prefix on the REAL deployed pages (px.js/sq-tracker.js adopt a pre-seeded
`sessionStorage['lpds_sid']`; server re-derives wa_ref from the sid so a
stored `whatsapp_ref` is end-to-end proof), destination set = registry-derived
ACTIVE destinations force-including both F-019 zero-delivery variants
(main-site `retarget_video`; villas `corporate_retreats_video/king-suite`),
robots.txt same-origin seeding (zero stray sessions), one owner-phone inbound
(D-009 identity; pre-existing test lead reused → `lead_created=0`), **CAPI
double-guarded by construction** (`leadCreated AND isMetaAttributed` — QC UTMs
qc-canary/qc are ineligible on two axes; expected recorded skip
`not_new_meta_attributed_lead`), testlv--precedented mark+DELETE cleanup with
before/after reconciliation asserts, abort/stop-the-line criteria, and pass
criteria that close F-019's residual leg.

## Phase ledger — QC-0…QC-9 COMPLETE + fix sessions #1–#8 COMPLETE (runtime
baseline ba47469; prod main e04c2a8 = docs-only boundary merge, serving code
identical; policy sha 0dd75080 ARMED marketing campaign_activate per-op only —
unchanged). Remaining: **QC-6c CANARY (plan committed, D-004 satisfied —
needs only the session grant)**, F-031 drill (D-006 window), P2 fix batch per
D-008, QC-10 + residual dispositions.

## Owner follow-ups

**Standing (carried; unchanged this session):**

1. Weekly accounting control legitimately red until F-061 is worked (next
   scheduled fire Mon 2026-08-24 08:00 PT).
2. Campaign approvals still unrecorded — nothing can auto-activate (F001-FIX
   evidence carries the un-arm procedure).
3. Policy-fingerprint discipline after any hand edit of policy.json
   (`node scripts/policy-fingerprint.js record` owner-run).
4. **Paloma scheduled trio still broken since install (F-066, P2)** — no
   weekly follow-ups/summaries; capture unaffected (real-time + 10-min cron
   healthy). Fix rides the next P2 batch, which also carries **F-064 (grid
   contention — DUE)**, F-069 (propose instruction surface), F-067
   (#common-areas convergence).
5. `meta-ads-geo-audit` gateway cron lastStatus=error — F-035-remainder
   observation, dispositioned with that finding.
6. Owner-anytime calls: pre-scrub bundle + workspace-resort archive
   deletions; `~/fix-worktree` carries merged branch
   `fix/f063-reply-dispatch-twins` (removable).
7. 3 pending email_reply_proposals remain inert — do NOT confirm as tests.

## Blockers

None for the committed work. Open D-rows: **D-007** (accounting validator
role) and **D-010** (Corporate-Intelligence scope confirm) — neither blocks
QC-6c. **D-004 is CLOSED** (2026-08-20).

Open P1s: **NONE**. Open P2s: F-013 (gated on F-031 drill), F-023, F-025,
F-006, F-029, F-033, F-035 (remainder + two observations), F-036, F-040,
F-044, F-059, F-061, F-064 (raised P3→P2, fix DUE), F-066. Open P3s: F-019
(closes on QC6C-01), F-042 residuals batch, F-065 (docs batch incl. the
`!help` propose-rendering rider), F-067, F-068, F-069 (instruction fix
queued).

## Next

**(1) QC-6c CANARY — execute `qc/QC6C_CANARY_SESSION_PLAN.md`.** All four
gates in the plan's §2 must hold: **Authorizations line grants CANARY for
this plan by name**; weekday 10:00–16:00 PT (D-004); live-state preflight
clean; owner present with the D-009 phone for the single WhatsApp-leg
message. D-004 no longer blocks — the remaining blocker is solely the
session-level grant (per D-028 precedent, an unused grant is consumed, not
carried forward).

**Then:** (2) F-031 escrow-retrieval drill slot (D-006 window, now
schedulable against D-004). (3) P2 fix batch per D-008 — F-064 (DUE), F-066,
F-069, F-067. (4) QC-10 (incl. the F-031 drill before the stamp) + P2/P3
residual dispositions (owner + due date per DoD #10).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ e04c2a8 (serving code byte-identical to runtime
baseline ba47469; `node scripts/policy-fingerprint.js check` prints `match` +
`agreement: ok`, sha 0dd75080). Then `cd ~/qc-worktree`, read qc/STATUS.md,
and take Next item (1) **only if** the session's Authorizations line grants
CANARY for QC-6c and the clock is inside the D-004 window (weekday
10:00–16:00 PT); otherwise stop and ask the owner per the charter.

**⚠️ Standing QC-executor rules:** (QC8-INC-01) never `pkill -f` a shared
substring — kill FIXTURE processes only by exact recorded PID. (QC8-07) a
claim-path "verified live" needs a DISCRIMINATING artifact. (QCF063-02) the
claim surface and the server-side authorization surface are different
controls. (QC9-04) fixture timestamps that feed `new Date()` gates must be
ISO strings. (NEW, session 28) an owner-attributed working-tree deletion of a
committed qc/ file is benign — restore from HEAD and note it; escalate only
unattributed or content-bearing dirt.

Method notes worth keeping (session 28):

- **The canary marks itself through the system's own derivations.** Seeding
  one value (the sid) before page load propagates a QC signature into the
  wa_ref, the CTA href, the WhatsApp message body, and the DB row — every
  layer self-identifies without touching the code under test.
- **Safety by construction beats safety by care:** the CAPI-negative
  invariant holds through two independent gates (pre-existing lead, ineligible
  UTMs) before any procedural discipline is even needed. Design canaries so
  the dangerous path is unreachable, then also verify it stayed unfired.
