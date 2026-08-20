# QC status

Updated: 2026-08-19 (PDT) — session 27 concluded (**QC-9 COMPLETE — the live
`!ownerrez confirm` leg PASSED both rounds at ba47469: first-ever firing of
the 34-op mutation surface, every gate held live (model-tool propose,
same-user + hash + expiry, execute-once, created/deleted-entity readbacks,
notifications incl. write_notifications mentions), and cleanup is proven by
HASH EQUALITY — the provider tag-definition snapshot after the delete is
byte-identical to the pre-canary baseline. F-069 severity revised P2→P3 (the
literal-input retry succeeded; instruction-only gap). Post-canary sweep found
a PRE-EXISTING SQLITE_BUSY review blocking the scheduled contact sync ~24h →
F-064 RAISED P3→P2; resolution command handed to the owner below**). Authorization consumed this session: the Authorizations line
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

## Phase ledger — QC-0…QC-9 COMPLETE + fix sessions #1–#8 COMPLETE (runtime
baseline ba47469; prod main ba47469; policy sha 0dd75080 ARMED marketing
campaign_activate per-op only — unchanged). Remaining: QC-9 phase-boundary
batch-merge (needs owner authorization — Amendment 3 pattern), QC-6c CANARY
(D-004-gated), F-031 drill (D-006 window), QC-10 + P2/P3 residual
dispositions (now incl. F-064 P2 grid-contention fix, F-066 Paloma trio,
F-069 propose-instruction fix).

## LIVE LEG — COMPLETE (QC9-09; runbook retired)

Round A: proposal caa17fd1… → owner confirm → execute-once → provider 200,
created tag definition 40041, verified_by_readback. Round B: proposal
ead7b569… → owner confirm → provider 204, deleted-entity readback; provider
snapshot after delete byte-identical to the before baseline (sha 265a7c98…
both). Surface history = exactly the canary pair. Attempt-1 agent refusal is
F-069 (now P3); one wrong-window paste (QC terminal, `command not found`)
was harmless and is recorded in QC9-09.

## Owner follow-ups

**NEW this session:**

1. **ACTION NEEDED — unblock the contact sync (5 seconds):** a SQLITE_BUSY
   failure yesterday 6:26 PM PDT opened review 2a5467cd… and the 15-minute
   OwnerRez contact-sync poll has been fail-closed-blocked since (webhook
   syncs kept data flowing — nothing lost; QC9-10). In **#business-intel**,
   quiet moment, paste:
   `!review resolve 2a5467cd-fba2-4eb0-9d08-896e1ad37195 not-sent`
   ("not-sent" is correct: the failed step was a local sync write; nothing
   external happened; the next poll re-syncs idempotently.) This is the
   second SQLITE_BUSY cadence-block in 2 days → F-064 raised to P2; the
   busy_timeout/grid-de-phasing fix is now due in the next fix batch.
2. **The canary succeeded end-to-end and cleaned up after itself** —
   OwnerRez is byte-identical to its pre-canary state. Attempt 1's refusal
   is F-069 (revised to P3): Sol lacks the operation catalog / propose
   input contract in anything it can see; until the fix lands, propose asks
   should use the literal form (workflow + input JSON, QC9-09 pattern).
   Sol's "file an infrastructure gap to add TagDefinitions_Post" offer
   remains factually wrong — decline it.
3. **Paloma's scheduled trio has been silently broken since install
   (F-066, P2)** — the Monday follow-up/summary posts you may have expected
   yesterday never happened, and the 4h scan has failed every run. Task
   capture is unaffected (the 10-minute reconciliation + real-time delivery
   are healthy — live-verified today). Fix rides the next P2 batch.
4. **Paloma joined #common-areas but real-time monitoring isn't converged
   there (F-067, P3)** — tasks in that channel are caught by the 10-minute
   sweep only, and task-list questions there get no deterministic report.
5. `meta-ads-geo-audit` gateway cron (resort agent) shows lastStatus=error —
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

None for the committed work. The QC-9 phase-boundary merge awaits an owner
authorization (past pattern: agent-run end-to-end, owner-run `!` fallback on
classifier blocks). Open D-rows: D-004 (blackout windows — load-bearing for
QC-6c and QC-10), D-007 (accounting validator), D-010 (CI scope confirm).

Open P1s: **NONE**. Open P2s: F-013 (gated on F-031 drill), F-023, F-025,
F-006, F-029, F-033, F-035 (remainder; + two new observations: resort cron
`meta-ads-geo-audit` lastStatus=error, chronic gateway memory-pressure
warnings), F-036 (three writers remain), F-040, F-044, F-059, F-061,
**F-066 (new)**, **F-064 (raised P3→P2 on recurrence)**. Open P3s (delta):
F-069 (revised P2→P3; instruction fix queued). Open P3s: F-019 (browser page-JS leg =
QC-6c CANARY), F-064 (monitor-only), F-065 (docs batch; + one-line rider:
`!help` renders the inert-but-functional `ownerrez.mutation.propose` as
"shadowed"), **F-067 (new)**, **F-068 (new)**.

## Next

**(DONE 2026-08-19 evening, D-029)** Phase-boundary merge executed agent-run
end-to-end: PR #92 (19 qc commits since the QC-7 boundary) → CI verify PASS →
merged e04c2a8 → docs-only ff of production main; ancestry + incoming-files
(8 qc/ files only) + code-identity (non-qc diff vs ba47469 EMPTY) + fingerprint
match + healthz 200 all proven. One honest incident: the FIRST CI run FAILED on
check-secrets — F-067's committed text carried a raw Slack channel id (§4.1
violation, executor error); the id was scrubbed to an evidence pointer and CI
passed — the scanner control worked exactly as designed. Review 2a5467cd was
owner-resolved (confirmed_not_sent) and the contact sync RESUMED (first run
completed 2026-08-20 01:56:57Z, back on 15-min cadence).

**(1) QC-6c CANARY** — blocked on D-004 (blackout windows; still unanswered
and load-bearing).

**Then:** (2) F-031 drill slot (D-006 window). (3) P2 fix batch per D-008 —
now carrying F-064 (grid contention, DUE), F-066 (Paloma trio), F-069
instruction fix, F-067 converge. (4) QC-10 (incl. the F-031 drill before the
stamp) + P2/P3 residual dispositions (owner + due date per DoD #10).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ ba47469 (policy sha 0dd75080 unchanged;
`node scripts/policy-fingerprint.js check` prints `match` + `agreement: ok`).
Expected HEAD after this boundary: e04c2a8 (docs-only merge of PR #92;
serving code byte-identical to ba47469 — runtime baseline unchanged). Then
`cd ~/qc-worktree`, read qc/STATUS.md, and take Next item (1): QC-6c needs
D-004 answered first; otherwise the P2 fix batch is the ready-to-run item.

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
