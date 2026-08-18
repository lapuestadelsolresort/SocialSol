# QC status

Updated: 2026-08-18 (PDT) — session 25 (**F-063 fix session: reply_dispatch
twins deployed @ ba47469, live battery PASSED — F-063, F-051, F-052 all CLOSED
verified-fixed; F-064 opened (P3); D-027 recorded**). BUSINESS + OUTAGE
consumed as authorized (full release path; merges/ff owner-run via `!` after
classifier blocks — D-020/D-021 precedent). Runtime baseline b7f2690 →
**ba47469** (PR #91), policy sha `0dd75080` UNCHANGED (fingerprint `match` +
`agreement: ok` at the new SHA via release:check).

**Delivered:** (1) PR #91 `fix/f063-reply-dispatch-twins` — seven
`reply_dispatch` twins (whatsapp / marketing / ownerrez / receipt /
manual-review / help / unknown-fallback; meta-dm deliberately twinless, F-020
quarantine preserved) + 9 regression tests (plugin suite 139/139; full
`check:stack` green; registration ladder pinned) + the D-026 quiet-moment
prose on all 8 command surfaces; (2) full release path: CI verify pass, merge
+ prod ff owner-run via `!`, ancestry + incoming-files proofs, `release:check`
green, deploy record 2026-08-18T15-12-25-648Z (steps 1–10 completed; step 11
workflow_health red SOLELY on a pre-existing review — see F-064 — post-
resolution rerun exit 0 all-zeros), gateway kickstart (PID 43276→15064,
plugin loaded from the new source); (3) **LIVE battery (owner-typed, D-026
design): `!help` claimed with zero preceding agent bootstrap; `!wa 62 …`
produced durable run 8103063a (`slack_whatsapp_command`, actor-bound) with a
Twilio effect verified accepted→sent→delivered→READ to the owner's test
phone (`whatsapp.reply` now 2 runs ever); `!review resolve` resolved a
GENUINE review (70c0a77a) with a second-exact DB/log match — plus an
unplanned fail-closed 403 negative in a non-permitted channel** (QCF063-02);
(4) the genuine review was this morning's `paulina.daily` SQLITE_BUSY
(F-064, P3, new) — resolution unblocked the cadence (next cycle completed
15:42:14).

**Milestone: ZERO open P0/P1 findings for the first time in this QC effort.**

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1–#8 COMPLETE + QC-8a/8b
DONE in part (**QC-8c remains**: Sarah Email + Sarah Coach; the post-F-063-fix
live legs are now DONE — they were this session's battery) (runtime baseline
ba47469; prod main ba47469; policy sha 0dd75080 ARMED marketing
campaign_activate per-op only — unchanged, fingerprint `match` + agreement
`ok`)

## Standing advisory — REWRITTEN this session (supersedes the F-063 outage wording)

**The Slack exact-command layer is FULLY OPERATIONAL at ba47469.** All
previously dead commands now execute: `!wa` (guest-bound WhatsApp sends are
possible again — human-typed command, D-001 invariant intact and live-proven),
`!meta confirm`, `!ownerrez confirm`, `!receipt confirm`, `!review resolve`,
`!help`, and unknown-`!` guidance. What remains as a permanent operating rule
(D-026, now durable prose on every command surface): **type exact commands
top-level, unmentioned, in a quiet moment; if the bot does not acknowledge
within ~30s the command did NOT execute — check state before retyping any
mutation command** (gateway coalescing can still swallow a message typed
mid-turn; no handler can rescue that case). Note for review resolutions
specifically: the command is CLAIMED in any controlled channel but the server
only AUTHORIZES resolution from the review's own channel or a
`write_notifications` channel (prospector-paulina / business-intel) — a
wrong-channel attempt refuses fail-closed with `workflow_http_403`.

## Owner follow-ups

**NEW this session:**

1. **Everything you typed worked and nothing needs cleanup.** The `!wa` test
   message went to your own phone (read receipt captured); the review you
   resolved was a real one (this morning's Paulina database-lock hiccup) and
   resolving it was the correct operator action — Paulina's pipeline resumed
   on the next 5-minute cycle. The 403 in #whatsapp was the authorization
   gate working correctly (and my instruction error — recorded in D-027).
2. **F-064 (P3, new):** rare 5-minute-grid DB contention can fail a
   `paulina.daily` cycle and open a blocking review (1 occurrence vs 181
   clean runs that day; fail-safe worked; resolution is now a one-line Slack
   command). Monitoring only — no action needed unless it recurs.

**Still open from earlier sessions (unchanged):** weekly accounting control
legitimately red until F-061 is worked (next fire Mon 2026-08-24 08:00 PT);
campaign approvals still unrecorded (nothing can auto-activate);
policy-fingerprint discipline after any hand edit; un-arm procedure for
marketing activation in F001-FIX evidence; pre-scrub bundle + workspace-resort
archive deletions are owner-anytime calls.

## Blockers

None for QC-8c (RO/FIXTURE). Open D-rows: D-004 (blackout windows —
load-bearing at QC-6c/QC-10), D-007 (accounting validator), D-010 (CI scope
confirm).

Open P1s: **NONE** (F-051 and F-063 closed this session). Open P2s: F-013
(gated on F-031 drill), F-023, F-025, F-006, F-029, F-033, F-035 (remainder),
F-036 (three writers remain), F-040, F-044, F-059, F-061. Open P3s: F-019
(browser page-JS leg = QC-6c CANARY) and F-064 (monitor-only). Housekeeping:
`~/fix-worktree` carries merged branch `fix/f063-reply-dispatch-twins`
(removable); 1 pending gmail email_reply_proposal (2026-08-14, inert — do NOT
confirm it as a test; it would send a real email); goldroute co-tenant out of
scope.

## Next

**(1) QC-8c — Sarah Email + Sarah Coach (RO/FIXTURE).** Sarah Email audit per
D-019 standing rule (draft-and-approve, both providers; auto-send dormant +
policy-gated must stay so): one Slack root per provider conversation,
conservative CRM inquiry logic, immutable proposal + same-user confirm,
execute-once, Gmail-Sent/OwnerRez readback, retry-without-second-send,
mailbox reads never mark read, activity reads report live vs ledger
separately. Sarah Coach: suggestion-only, voice-corpus retrieval, NO send
path, outcome/edit capture. The `!email` surface's live legs are testable
at will now (twin + F-063 fix both deployed).

**Then:** (2) QC-6c CANARY (D-004 first — still unanswered and load-bearing).
(3) F-031 drill slot (D-006 window; F-013 gated). (4) QC-9 (OwnerRez +
Paloma) — its Slack-confirmation legs are now UNBLOCKED by the F-063 fix.

Definition-of-Done #3 note: zero open P0/P1 as of this session. Remaining for
baseline: QC-8c, QC-6c, QC-9, QC-10 (incl. the F-031 drill before the stamp),
and P2/P3 residual dispositions (owner + due date per DoD #10).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ ba47469 (policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged;
`node scripts/policy-fingerprint.js check` prints `match` + `agreement: ok`).
Then `cd ~/qc-worktree`, read qc/STATUS.md, and run QC-8c (RO/FIXTURE — no
special authorization needed).

**⚠️ Standing QC-executor rules:** (QC8-INC-01) never `pkill -f` a shared
substring — kill FIXTURE processes only by exact recorded PID, match fixture
servers by non-prod port. (QC8-07) a claim-path "verified live" needs a
DISCRIMINATING artifact — a ledger run, a claim log line, byte-identical
deterministic output, or bootstrap-absence in the detailed gateway log; a
delivery line alone proves nothing. (QCF063-02, new) the claim surface and
the server-side authorization surface are different controls — a command
being CLAIMED everywhere does not mean it is AUTHORIZED everywhere; verify
both when writing operator instructions.

Method notes worth keeping (session 25):

- **The health gate did its job twice.** Step 11 failing on a pre-existing
  review was the gate refusing to bless a deploy while ANY review was open —
  and the honest path (document, resolve via the newly-fixed surface, rerun
  green) produced stronger evidence than a clean first pass would have.
- **A genuine incident beats a synthetic canary.** The morning's SQLITE_BUSY
  review arrived unprompted and became the F-052 live vehicle the plan had
  been waiting weeks for — fix-then-verify on real operational state.
- **The 403 was found by the owner doing the natural thing.** Typing the
  command in both channels exposed a control boundary (claim ≠ authorize)
  the executor's instructions had blurred. Owner-driven variation is a test
  generator; record what it finds.
