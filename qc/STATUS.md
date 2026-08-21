# QC status

Updated: 2026-08-21 (PDT) — session 29 concluded (**RO-only in effect: the
QC-6c CANARY was authorized (D-030) but NOT executed — the Chrome extension
had no instance paired to this account, the owner asked for the necessity
case, and chose to close F-019's browser page-JS residual as ACCEPTED-RISK
(D-031). QC-6c is retired from the queue; its plan file stays as a runbook.
The gate-3 preflight surfaced three unrecorded red daily controls →
F-070 (P3, false-red daily-tests) and F-071 (P2, tracking-health red has
fail-closed the autonomous Meta safety net since 08-18) opened.**).
Authorization consumed this session: D-030 CANARY grant — consumed UNUSED
(D-028 rule). Zero production writes; zero non-RO actions; prod verified
clean at e04c2a8 at start (2026-08-20 08:11 PDT) and at close (2026-08-21
07:36 PDT); policy sha `0dd75080` fingerprint `match` + `agreement: ok`.

Session-start facts (ritual, all green): prod clean on main @ **e04c2a8**,
`origin/main` agrees, `git diff --stat ba47469 e04c2a8 -- . ':(exclude)qc'`
EMPTY; branch tip 043313a in sync with origin; Desktop plan copy byte-identical
to the committed plan. Outer `~/.openclaw` dirt (411 paths) fully attributed —
290 deletions = D-025's F-021 `workspace-resort` archive-then-delete (archive
present, mode 600), `Project_Status.md` deletion already in the QC-0 ritual,
recent mtimes only goldroute co-tenant runtime files — **no new dirt**.

**Delivered (session 29):** (1) D-030 recorded (CANARY grant, consumed
unused) and **D-031 recorded (F-019 residual accepted-risk; QC-6c retired;
revalidation = daily tracker-liveness + genuine-session presence; row reviewed
at QC-10 sign-off)**; (2) gate-3 preflight run and characterized (all clean;
destination set derived RO = 14 == tracker-liveness; 14 `qc6c-` sids minted,
never used, 0 rows ever written); (3) **F-070 + F-071 opened** with file:line
mechanisms; (4) QC6C-01/02, E-QC6C-01/02 recorded; plan file annotated.

## Phase ledger — QC-0…QC-9 COMPLETE + fix sessions #1–#8 COMPLETE (runtime
baseline ba47469; prod main e04c2a8 = docs-only boundary merge, serving code
identical; policy sha 0dd75080 ARMED marketing campaign_activate per-op only —
unchanged). **QC-6c RETIRED (D-031).** Remaining: P2 fix batch per D-008
(now headed by F-064 DUE + F-071 NEW), F-031 drill (D-006 window), QC-10 +
residual dispositions (F-019 accepted-risk row among them).

## Owner follow-ups

**Standing (carried; changes marked NEW):**

1. Weekly accounting control legitimately red until F-061 is worked (next
   scheduled fire Mon 2026-08-24 08:00 PT).
2. Campaign approvals still unrecorded — nothing can auto-activate (F001-FIX
   evidence carries the un-arm procedure).
3. Policy-fingerprint discipline after any hand edit of policy.json
   (`node scripts/policy-fingerprint.js record` owner-run).
4. **Paloma scheduled trio still broken since install (F-066, P2)** — fix
   rides the next P2 batch, which also carries **F-064 (grid contention —
   DUE)**, F-069, F-067, and NEW **F-071 (P2)** + **F-070 (P3 rider)**.
5. `meta-ads-geo-audit` gateway cron lastStatus=error — F-035-remainder
   observation, dispositioned with that finding.
6. Owner-anytime calls: pre-scrub bundle + workspace-resort archive
   deletions; `~/fix-worktree` carries merged branch
   `fix/f063-reply-dispatch-twins` (removable).
7. 3 pending email_reply_proposals remain inert — do NOT confirm as tests.
8. **NEW — the autonomous Meta pause/decrease safety net has been unable to
   act since 2026-08-18** (F-071: tracking-health red → `meta.campaign.
   autonomous` refuses; fail-closed, human `!meta confirm` unaffected, nothing
   can auto-activate). Until the fix batch lands, any needed pause/decrease
   is a human `!meta` action.
9. **NEW — `daily-tests` Slack report is false-red daily since 08-18**
   (F-070); a real failure would currently be indistinguishable at a glance —
   read the failing test name, not the colour, until fixed.
10. **NEW — the 2026-08-20 daily paid report never ran** (`marketing.report.
    daily` Meta API timeout, no retry; 08-21 ran fine). Observation only.

## Blockers

None for the committed work. Open D-rows: **D-007** (accounting validator
role) and **D-010** (Corporate-Intelligence scope confirm). The P2 fix batch
needs a **BUSINESS + OUTAGE** grant on the Authorizations line (D-020/021/
022/025 precedent) — release path + deploy incl. crm/worker restarts.

Open P1s: **NONE**. Open P2s: F-013 (gated on F-031 drill), F-023, F-025,
F-006, F-029, F-033, F-035 (remainder + two observations), F-036, F-040,
F-044, F-059, F-061, F-064 (fix DUE), F-066, **F-071 (NEW)**. Open P3s: F-042
residuals batch, F-065 (docs batch incl. the `!help` propose-rendering rider),
F-067, F-068, F-069 (instruction fix queued), **F-070 (NEW)**. Accepted-risk
residuals awaiting DoD #10 review at QC-10: F-019 (D-031), F-032(d)/(e)
(D-016), F-034(b) (D-025), F-051(iii) (D-026).

## Next

**(1) P2 fix batch per D-008** — scope: **F-064** (SQLITE_BUSY grid
contention — DUE), **F-071** (registry `ad_id` for the brief campaigns or
snapshot-resolved ad; tracking-health green; autonomy gate re-verified),
**F-066** (Paloma scheduled trio), **F-069** (propose instruction surface),
**F-067** (#common-areas convergence), **F-070** (test isolation rider).
Full release path agent-run; merges/ff owner-run via `!` if the classifier
blocks; live-state preflight + stated rollback/abort criteria before the
deploy (plan §5). Requires an Authorizations-line **BUSINESS + OUTAGE**
grant scoped to the batch — if the line is blank, ask first (D-021 precedent).

**Then:** (2) F-031 escrow-retrieval drill slot (D-006 window). (3) QC-10
(incl. the F-031 drill before the stamp) + P2/P3 residual dispositions
(owner + due date per DoD #10; F-019 accepted-risk row reviewed there).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ e04c2a8 (serving code byte-identical to runtime
baseline ba47469; `node scripts/policy-fingerprint.js check` prints `match` +
`agreement: ok`, sha 0dd75080). Then `cd ~/qc-worktree`, read qc/STATUS.md,
and take Next item (1) **only if** the session's Authorizations line grants
BUSINESS + OUTAGE for the P2 fix batch; otherwise stop and ask the owner per
the charter.

**⚠️ Standing QC-executor rules:** (QC8-INC-01) never `pkill -f` a shared
substring — kill FIXTURE processes only by exact recorded PID. (QC8-07) a
claim-path "verified live" needs a DISCRIMINATING artifact. (QCF063-02) the
claim surface and the server-side authorization surface are different
controls. (QC9-04) fixture timestamps that feed `new Date()` gates must be
ISO strings. (session 28) an owner-attributed working-tree deletion of a
committed qc/ file is benign — restore from HEAD and note it. **(NEW, session
29)** an in-terminal ask can block for HOURS — re-read the clock after every
answer before any window-gated action, and record ask-time and answer-time
separately. **(NEW, session 29)** browser canaries need the Chrome extension
paired to the executor's claude.ai account BEFORE the window opens
(`list_connected_browsers` must be non-empty; pairing is per account, not per
machine). **(NEW, session 29)** proportionality: before consuming owner time
on a P3 residual, state the necessity case (severity, what existing evidence
already covers, marginal value, cost) — the owner may prefer accepted-risk
under DoD #10.

Method notes worth keeping (session 29):

- **A preflight is a sweep, not a checkbox.** Reading `job-status.json` for
  the gate-3 "last runs green" check surfaced two controls that had been red
  for three days without a finding — one of them silently disabling an
  autonomy safety net. Every live-state preflight should diff the job-status
  reds against FINDINGS/STATUS and open rows for any unexplained red.
- **Trace a red to its consumer, not just its cause.** `tracking-health`'s
  "missing ad_id" looked like config hygiene until the consumer grep showed
  `meta.campaign.autonomous` refusing on it — that is what made it P2.
