# QC status

Updated: 2026-08-18 (PDT) — session 26 (**QC-8c COMPLETE: Sarah Email + Sarah
Coach audited RO/FIXTURE — with that, QC-8 is the first fully COMPLETE
guest-communications phase; F-065 opened (P3, doc-only); still ZERO open
P0/P1**). No authorizations consumed (blank line honored: RO + FIXTURE only);
zero production mutations — all tests ran in a scratchpad fixture clone
(removed after), prod verified clean at ba47469 before and after. Policy sha
`0dd75080` unchanged (fingerprint `match` + `agreement: ok` at session start).

**Delivered (QC8-08…QC8-14, E-QC8C-01…06):** (1) Sarah Email full contract
trace at ba47469 — provider-from-inbound-record, immutable non-expiring
proposal, same-user/same-channel/exact-hash confirm with atomic flip,
execute-once effect + replay guard, Gmail-Sent/OwnerRez readback, projection
retry without resend, never-mark-read BY SCOPE (gmail.readonly polls, zero
modify calls), activity reads reporting live Gmail vs ledger coverage
separately, conservative CRM inquiry filter with Spam visibility-only;
(2) D-019 standing rule verified live: `email.reply.confirm` live but NOT
autonomous (dormant auto-send stays policy-gated), gateway liveWorkflowNames
== policy live set both directions (32=32), email capabilities on exactly the
two email channels, `email.send` user-restricted; (3) ingestion topology:
5-min unified poller healthy (318 runs, exit 0, canonical template chain,
legacy scanner absent), OwnerRez ingest idempotent, UNIQUE dedupe backstop,
one-Slack-root-per-conversation via serialized outbox + root election +
`email_slack_root_pending` hold, DB-path contract converges on one inode;
(4) ledger sweep: 3 historical send chains all verified-by-readback,
execute-once held everywhere, ZERO auto-confirm-trigger runs ever, 427
email_threads with zero backlog, both providers fresh; (5) **unplanned live
passive canary:** the owner typed `!email reply` twice this morning (09:20/
09:26 PDT) — both runs completed `awaiting_explicit_confirmation` with
`autonomous_workflow_denied`, zero sends: a live-production proof of the
D-019 dormancy gate on genuine owner-typed events at ba47469; (6) FIXTURE
battery 148/148 in an isolated clone, including 3 QC-authored negatives that
closed real coverage gaps (wrong hash / wrong user / re-confirm after
completion — all refused, zero-or-one send held); (7) Sarah Coach:
suggestion-only proven structurally (no send capability anywhere in its
chain), voice corpus live (Chroma v2, sarah_voice_corpus 1,252 docs),
outcome/edit capture correct — and the whole surface DORMANT in production
(zero guest.reply.draft runs, zero thread-log rows, latest draft 2026-05-25).

## Phase ledger — QC-0…QC-8 COMPLETE + fix sessions #1–#8 COMPLETE (runtime
baseline ba47469; prod main ba47469; policy sha 0dd75080 ARMED marketing
campaign_activate per-op only — unchanged). Remaining: QC-9, QC-6c (CANARY,
D-004-gated), F-031 drill (D-006 window), QC-10 + P2/P3 residual dispositions.

## Standing advisory (unchanged from session 25)

The Slack exact-command layer is FULLY OPERATIONAL at ba47469. Quiet-moment
rule (D-026) binds for all mutation commands. `!review resolve` is CLAIMED in
any controlled channel but AUTHORIZED only from the review's own channel or a
`write_notifications` channel (prospector-paulina / business-intel) — wrong
channel refuses fail-closed `workflow_http_403`. (The generated docs still
overstate this — F-065.)

## Owner follow-ups

**NEW this session:**

1. **Your two `!email reply` drafts from this morning are pending and inert**
   (created 09:20/09:26 PDT in #sarah-email, before you asked "how about
   now?"). Nothing was sent — that's the draft-and-approve design working.
   They never expire; each sends ONLY if you (the same user) paste its exact
   emitted `!email confirm <id> <hash>` line in that channel. Leaving them
   pending is completely safe; paste a confirm line only if you actually want
   that email to go out. (Same for the older 2026-08-14 pending draft.)
2. **F-065 (P3, doc-only):** all eight generated command docs say `!review
   resolve` works "from any controlled channel" — the claim/authorize
   conflation QCF063-02 disproved. Fix rides the next docs batch; the
   standing advisory above has the correct wording.
3. **Sarah Coach is built, tested, and unused since May** (zero production
   drafts through the workflow, empty `!sent`/`!edit` log). No action needed —
   just flagging that the surface is available if you want it.
4. **OwnerRez replies have never been sent live** (all three historical email
   sends were Gmail). The path is fixture-proven end-to-end; its first genuine
   use doubles as the live positive when the need arises.

**Still open from earlier sessions (unchanged):** weekly accounting control
legitimately red until F-061 is worked (next fire Mon 2026-08-24 08:00 PT);
campaign approvals still unrecorded (nothing can auto-activate);
policy-fingerprint discipline after any hand edit; un-arm procedure for
marketing activation in F001-FIX evidence; pre-scrub bundle + workspace-resort
archive deletions are owner-anytime calls; `~/fix-worktree` carries merged
branch `fix/f063-reply-dispatch-twins` (removable).

## Blockers

None for QC-9's RO/FIXTURE core. Its live Slack-confirmation legs (any real
`!ownerrez confirm`) are BUSINESS-class — session authorization required when
that leg is reached. Open D-rows: D-004 (blackout windows — load-bearing for
QC-6c and QC-10), D-007 (accounting validator), D-010 (CI scope confirm).

Open P1s: **NONE**. Open P2s: F-013 (gated on F-031 drill), F-023, F-025,
F-006, F-029, F-033, F-035 (remainder), F-036 (three writers remain), F-040,
F-044, F-059, F-061. Open P3s: F-019 (browser page-JS leg = QC-6c CANARY),
F-064 (monitor-only), F-065 (docs batch). Housekeeping: 3 pending
email_reply_proposals (all inert, see follow-up 1 — do NOT confirm as tests;
each would send a real email); goldroute co-tenant out of scope.

## Next

**(1) QC-9 — OwnerRez and Paloma operations (RO/FIXTURE core).** Per plan §9:
OwnerRez webhook subscription manifest reconciled dynamically; auth, durable
acknowledgment, idempotency, retry, message projection; contact sync verified
independently from occupancy (CRM is not a booking mirror — occupancy reads
go to OwnerRez direct); mutation catalog: fixed 34 operations, restricted
users, immutable proposal + 15-min expiry + same-user confirm + fresh
precondition + execute-once + operation-specific readback + notification +
ambiguous-result review (all confirmation-gated per D-019 item 1); Paloma:
dedicated identity, joined-channel membership, immediate delivery vs
ten-minute reconciliation as separate paths, source-timestamp idempotency,
checkpoint semantics, task lifecycle, retry, bilingual responses, weekly
follow-up/summary; `paloma/data/tasks.db` recovery-matrix row (QC-3
dependency). Live `!ownerrez confirm` legs: stop and ask (BUSINESS).

**Then:** (2) QC-6c CANARY (D-004 first — still unanswered and load-bearing).
(3) F-031 drill slot (D-006 window). (4) QC-10 (incl. the F-031 drill before
the stamp) + P2/P3 residual dispositions (owner + due date per DoD #10).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ ba47469 (policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged;
`node scripts/policy-fingerprint.js check` prints `match` + `agreement: ok`).
Then `cd ~/qc-worktree`, read qc/STATUS.md, and run QC-9 (RO/FIXTURE — live
confirm legs need session authorization).

**⚠️ Standing QC-executor rules:** (QC8-INC-01) never `pkill -f` a shared
substring — kill FIXTURE processes only by exact recorded PID, match fixture
servers by non-prod port. (QC8-07) a claim-path "verified live" needs a
DISCRIMINATING artifact — a ledger run, a claim log line, byte-identical
deterministic output, or bootstrap-absence in the detailed gateway log; a
delivery line alone proves nothing. (QCF063-02) the claim surface and the
server-side authorization surface are different controls — verify both when
writing operator instructions.

Method notes worth keeping (session 26):

- **Check the ledger before assuming a quiet system.** The owner exercised
  the surface under audit DURING the session (two `!email reply` drafts);
  the sweep caught them as unplanned passive-canary evidence — genuine
  owner-typed events beat synthetic ones, and a QC session is not a frozen
  lab. An ambiguous owner message ("how about now?") plus fresh ledger rows
  would have connected sooner had the sweep run earlier.
- **Never-mark-read proved by scope beats proved by absence.** The Gmail
  poller authenticates with gmail.readonly — the API itself cannot mutate
  read state, a stronger guarantee than "no modify call found".
- **Coverage gaps hide behind adjacent tests.** The suite tested wrong
  CHANNEL but not wrong USER or wrong HASH on the email confirm; the three
  ten-minute fixture negatives closed the gap and belong upstream in a
  future batch (noted in E-QC8C-06).
