# QC status

Updated: 2026-08-19 (PDT) — session 27 continued (**QC-9 RO/FIXTURE core
COMPLETE at ba47469; F-066 (P2), F-067 (P3), F-068 (P3) opened; live canary
round A attempt 1 executed by the owner and FAILED AT THE AGENT LAYER,
fail-closed → F-069 (P2): Sol refused the valid catalog operation
`TagDefinitions_Post` claiming an "allowed operation set" and "the control is
holding" while the ledger shows ZERO propose runs and ZERO proposals ever —
no control fired; root cause = no model-visible operation catalog or propose
input contract. Runbook v2 (fully explicit phrasing) is below; D-028
authorization remains open for the retry**). Authorization consumed this session: the Authorizations line
granted the `!ownerrez confirm` live leg (D-028); everything else ran
RO/FIXTURE. Zero production mutations by the executor — FIXTURE ran in an
isolated scratchpad clone (removed after), prod verified clean at ba47469 at
session start, policy sha `0dd75080` unchanged (fingerprint `match` +
`agreement: ok`).

**Delivered (QC9-01…QC9-08, E-QC9-01…04):** (1) OwnerRez webhook boundary:
provider subscription manifest reconciled dynamically (24 subs = 8 types × 3
actions, zero dupes, single URL = the mounted durable route), auth/durable-
ack/idempotency/retry code-traced at ba47469 (byte-identical to the D-019 RO
map's read — empty diff), live passive proof (event received 20:28Z →
completed 20:31Z during the audit), 68/68 durable-era events completed;
(2) contact sync proven contact-only (guestless/blocks excluded by
construction; occupancy readers open no DB and go provider-direct; no
duplicate producer — legacy plist not loaded); (3) mutation surface
re-verified at ba47469: 34 fixed ops, full gate chain, confirm live + NOT
autonomous (D-019 holds), 2-user allowlist, ZERO proposals ever
(production-unfired); propose's absence from live_workflows traced
behaviorally inert (all steps SAFE_IN_SHADOW); (4) FIXTURE battery 32/32
shipped + **6 QC-authored negatives closing real gaps** (webhook
missing/wrong/unconfigured auth ×3; wrong acceptance hash; expired proposal;
re-confirm after completion — execute-once held) + plugin suite 90/90;
(5) Paloma: dedicated identity, 13-channel dynamic membership, healthy
10-min gateway cron (failure-alert configured, all 13 checkpoints fresh),
SOUL contract present, anti-future triggers + UNIQUE source_ts backstops,
deterministic bilingual task-report proven by live RO run; (6) **the D-012
scheduled trio is broken end-to-end since install → F-066 (P2)**: scan dies
on missing config + a masked code defect, both weeklies call nonexistent
`openclaw run` and mask the failure (`|| log`), zero watchdog/job-status
coverage; capture unaffected (real-time + cron compensate) but weekly
follow-ups/summaries have never run; (7) F-067 (P3): #common-areas joined
but not converged for real-time delivery/task-replies (cron covers capture);
(8) F-068 (P3): 49 pre-cutover ownerrez_events rows permanently non-terminal
and invisible to the worker (polling paths carried the data; durable era has
zero backlog); (9) tasks.db recovery row confirmed MET (state-backup ok
today 10:45Z) — RECOVERY_MATRIX updated.

## Phase ledger — QC-0…QC-8 COMPLETE + fix sessions #1–#8 COMPLETE; QC-9
RO/FIXTURE core COMPLETE, live confirm leg pending (runtime baseline ba47469;
prod main ba47469; policy sha 0dd75080 ARMED marketing campaign_activate
per-op only — unchanged). Remaining: QC-9 live leg (runbook below), QC-6c
CANARY (D-004-gated), F-031 drill (D-006 window), QC-10 + P2/P3 residual
dispositions.

## LIVE LEG RUNBOOK v2 — owner-typed `!ownerrez confirm` canary (D-028)

Attempt 1 (natural-language ask) was refused by the agent without any tool
call — F-069. Attempt 2 hands Sol the literal tool input so there is nothing
to improvise. Two rounds in **#reservations**. The ASK is a normal
conversational message; the quiet-moment rule (D-026) applies to the exact
`!ownerrez confirm` paste (top-level, unmentioned; no ack in ~30s = did not
execute — check with the executor before retyping). Each confirm must be
pasted within **15 minutes** of its proposal, by the same user who asked.

**Round A (create), attempt 2 — ask Sol:**
```
Sol, please call your resort_workflow tool now with exactly:
workflow: ownerrez.mutation.propose
input: {"operationId": "TagDefinitions_Post", "body": {"name": "QC Canary 2026-08-18", "color": "#888888"}, "reason": "QC-9 live confirmation canary"}
TagDefinitions_Post is one of the 34 operations in the fixed catalog
(crm/lib/ownerrez-mutation-catalog.js); the operation id goes inside
input.operationId — it is not a workflow name. The proposal step writes
nothing to OwnerRez; it returns a confirmation command that only I can
execute.
```
Sol replies with a proposal and an exact `!ownerrez confirm <id> <hash>`
line. Paste that line top-level in #reservations. Expected: completed +
verified-by-readback reply + reservations notification. If Sol refuses
AGAIN: stop — do not coax further; F-069 escalates to
inoperable-via-entrypoint and its fix session inherits this canary as live
verification.

**Round B (cleanup, after the executor verifies round A and reports the
created id):** ask Sol:
`Sol, propose an OwnerRez mutation: operation TagDefinitions_Delete for tag
definition id <ID>. Reason: QC-9 canary cleanup.`
Paste the emitted confirm line. Expected: deleted + readback; provider tag
inventory back to exactly 3 definitions (E-QC9-03 baseline).

Contingencies: provider 4xx → run fails closed, one incident alert fires,
zero state change — stop and report. Timeout/5xx → ambiguous → durable
manual review + 409-block on the surface — resolve only with the executor.
Executor verification after each round: proposal row status, run + effect
`verified_by_readback`, evidence row, provider GET (present → absent),
notification outbox, tag inventory count.

## Owner follow-ups

**NEW this session:**

1. **Canary round A attempt 1 failed at the agent layer (F-069, P2):** Sol
   refused the valid operation, invented an "allowed operation set", and
   claimed "the control is holding" — no control fired (zero runs, zero
   proposals, zero provider calls; fail-closed held). Root cause: nothing
   Sol can see documents the 34-op catalog or the propose input contract.
   **Runbook v2 above gives the literal tool input for the retry** (D-028
   authorization still open for this leg). Sol's offer to "file adding
   TagDefinitions_Post to the supported operations" is factually wrong —
   it is already supported; decline it.
2. **Paloma's scheduled trio has been silently broken since install
   (F-066, P2)** — the Monday follow-up/summary posts you may have expected
   yesterday never happened, and the 4h scan has failed every run. Task
   capture is unaffected (the 10-minute reconciliation + real-time delivery
   are healthy — live-verified today). Fix rides the next P2 batch.
3. **Paloma joined #common-areas but real-time monitoring isn't converged
   there (F-067, P3)** — tasks in that channel are caught by the 10-minute
   sweep only, and task-list questions there get no deterministic report.
4. `meta-ads-geo-audit` gateway cron (resort agent) shows lastStatus=error —
   out of QC-9 scope, recorded as an F-035-remainder observation for that
   finding's eventual disposition.

**Still open from earlier sessions (unchanged):** weekly accounting control
legitimately red until F-061 is worked (next fire Mon 2026-08-24 08:00 PT);
campaign approvals still unrecorded (nothing can auto-activate);
policy-fingerprint discipline after any hand edit; un-arm procedure for
marketing activation in F001-FIX evidence; pre-scrub bundle +
workspace-resort archive deletions are owner-anytime calls; `~/fix-worktree`
carries merged branch `fix/f063-reply-dispatch-twins` (removable); 3 pending
email_reply_proposals remain inert (do NOT confirm as tests).

## Blockers

The QC-9 live leg needs the owner's hands (same-user Slack gates — the
executor cannot and must not type it). Open D-rows: D-004 (blackout windows —
load-bearing for QC-6c and QC-10), D-007 (accounting validator), D-010 (CI
scope confirm).

Open P1s: **NONE**. Open P2s: F-013 (gated on F-031 drill), F-023, F-025,
F-006, F-029, F-033, F-035 (remainder; + two new observations: resort cron
`meta-ads-geo-audit` lastStatus=error, chronic gateway memory-pressure
warnings), F-036 (three writers remain), F-040, F-044, F-059, F-061,
**F-066 (new)**, **F-069 (new — live-canary discovery)**. Open P3s: F-019 (browser page-JS leg =
QC-6c CANARY), F-064 (monitor-only), F-065 (docs batch; + one-line rider:
`!help` renders the inert-but-functional `ownerrez.mutation.propose` as
"shadowed"), **F-067 (new)**, **F-068 (new)**.

## Next

**(1) QC-9 live `!ownerrez confirm` canary — RETRY (runbook v2 above,
attempt 2 with literal tool input)**, owner-typed, then executor verification
(ledger/provider/notification) recorded as QC9-09; that completes QC-9 and
its phase-boundary batch-merge follows (Amendment 3). If Sol refuses again or
the leg is deferred: QC-9 closes RO/FIXTURE-complete with the live leg
riding the F-069 fix session (D-026/D-027 precedent; fresh authorization
grant with that session).

**Then:** (2) QC-6c CANARY (D-004 first — still unanswered and load-bearing).
(3) F-031 drill slot (D-006 window). (4) QC-10 (incl. the F-031 drill before
the stamp) + P2/P3 residual dispositions (owner + due date per DoD #10);
F-066 fix session per D-008 P2 policy.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ ba47469 (policy sha 0dd75080 unchanged;
`node scripts/policy-fingerprint.js check` prints `match` + `agreement: ok`).
Then `cd ~/qc-worktree`, read qc/STATUS.md, and run the QC-9 live leg
(session authorization required) or, if already completed, the QC-9
phase-boundary merge.

**⚠️ Standing QC-executor rules:** (QC8-INC-01) never `pkill -f` a shared
substring — kill FIXTURE processes only by exact recorded PID. (QC8-07) a
claim-path "verified live" needs a DISCRIMINATING artifact. (QCF063-02) the
claim surface and the server-side authorization surface are different
controls. (NEW, QC9-04) fixture timestamps that feed `new Date()` gates must
be ISO strings — SQLite's space format parses as local time and silently
defeats expiry tests.

Method notes worth keeping (session 27):

- **"Loaded" is not "working."** The Paloma trio passed its install-time
  verification (loaded, drift-free) and then failed every functional run;
  only a first-RUN verification would have caught it. F-066's closure
  criterion encodes that.
- **A green exit is only evidence when the script CAN fail.** Both weekly
  wrappers `|| log`-mask their core action; their exit-0 history was
  non-evidence (F-017 class, second occurrence).
- **The same negative-coverage gap repeats across surfaces.** Wrong-hash /
  expiry / re-confirm negatives were missing here exactly as wrong-hash /
  wrong-user / re-confirm were missing on the email surface (E-QC8C-06);
  when a gate chain is cloned between surfaces, its test gaps clone too —
  audit the sibling surface's gaps first next time.
