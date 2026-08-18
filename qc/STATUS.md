# QC status

Updated: 2026-08-18 (PDT) — session 24 (**QC-8b: authorized `!wa` canary →
F-063 discovered (P1); Meta DM quarantine re-verified; QCF058-05 corrected**).
RO/FIXTURE + one authorized CANARY (D-026; zero mutation resulted), no
release-path work, runtime baseline UNCHANGED at `b7f2690`, policy sha
`0dd75080` (fingerprint `match` + `agreement: ok`, verified at start ritual).

**Delivered:** (1) D-026 recorded — F-051(iii) dispositioned OPERATOR GUIDANCE
(owner), owner-phone `!wa` canary authorized and executed; (2) the canary's
command leg failed structurally and became the session's headline finding —
**F-063 (P1): in the deployed gateway (OpenClaw 2026.5), `inbound_claim` never
dispatches for ordinary Slack channel conversations; only command surfaces with
a `reply_dispatch` twin work (email, accounting×3, task-list, reservation).
`!wa`, `!meta confirm`, `!ownerrez confirm`, `!receipt confirm`,
`!review resolve`, `!help`, and the F-058 unknown-command fallback are twinless
and therefore DEAD as Slack commands** (QC8-05, E-QC8-05: dist single-dispatch-
site proof + absent binding store + the repo's own PR #28 comment + live
two-attempt canary with zero runs + plugin/config exonerated by fixture sim);
fail-closed HELD throughout (0 sends, 0 effects, model path refused);
(3) **Meta DM quarantine re-verified at b7f2690** (QC8-06 PASS — policy,
gateway config, render patch, canonical guard list, armed-patch refusal probe,
validator tests, renderer marking); (4) **QCF058-05/E-F058-06 live-`!help`
claim attribution OVERTURNED** (QC8-07 — the evidence was a non-discriminating
`delivered reply` line; F-051's live positive reverts to UNMET; the offline
renderer verification QCF058-03 stands untouched).

**Canary reconciliation (clean):** residue = meta_messages rows 61/62 (owner
test-identity inbounds, self-marked as QC tests, attached to the pre-existing
test lead; lead_created=0), their Slack forwards, and 4 model_tool
`whatsapp.status.read` reads. 0 outbound rows, 0 whatsapp effects,
`whatsapp.reply` remains at exactly 1 run ever (2026-08-12).

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1–#7 COMPLETE + **QC-8a/8b
DONE in part** (WhatsApp gate battery, Meta webhook probes, Meta DM re-verify,
canary → F-063; **QC-8c remains**: Sarah Email + Sarah Coach + post-F-063-fix
live legs) (runtime baseline b7f2690; prod main b7f2690; policy sha 0dd75080
ARMED marketing campaign_activate per-op only — unchanged, fingerprint `match`
+ agreement `ok`)

## ⚠️ Standing advisory — REWRITTEN this session (F-063; supersedes the F-051(iii) wording)

**Until the F-063 fix deploys, these Slack commands DO NOT EXECUTE AT ALL:**
`!wa`, `!meta confirm`, `!ownerrez confirm`, `!receipt confirm`,
`!review resolve`, `!help` (typed text reaches Sol, which refuses or
improvises — it cannot run them; every refusal is fail-closed, nothing sends).
Operationally that means right now: **no guest-bound WhatsApp send is possible
by any path** (inbound WhatsApp keeps flowing normally); OwnerRez mutations
can be proposed but not confirmed via Slack; Meta pause/budget/landing
proposals cannot be confirmed via Slack (armed autonomous activation with
recorded receipts is unaffected); manual reviews are resolvable only via the
owner-directed terminal endpoint (D-017 precedent). **Still working:**
`!email reply/confirm/classify`, accounting reads/statement intake, task
list, reservation reads (these ride `reply_dispatch` twins), all system
autonomics, and all interactive buttons so far as tested. The D-026
quiet-moment guidance still applies to the working surfaces; it cannot revive
the dead ones.

## Owner follow-ups

**⚠️ NEW this session (QC-8b):**

1. **Your `!wa` didn't fail because of you.** Both attempts were correctly
   typed; the command layer they rely on is structurally unreachable in the
   running gateway (F-063 above). Nothing was sent, nothing needs cleanup;
   your two test texts are ordinary inbound rows marked as QC tests.
2. **F-063 needs a dedicated P1 fix session (D-008)** — repo-local fix shape
   already identified (add `reply_dispatch` twins for the seven twinless
   command surfaces; the wrapper pattern exists ×6 in the same plugin file),
   full release path + regression tests, then the live quiet-channel battery
   (the D-026 canary design finishes F-051's corroboration leg there). Say
   the word and the next session runs it.
3. **A prior "verified live" claim was corrected:** the 2026-08-17 live
   `!help` was very likely Sol answering, not the command handler (QC8-07);
   the F-058/F-062 offline render verifications are unaffected. Recorded as
   an honest evidence correction, not buried.

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

Open P1s: **F-051** (closure now = F-063 fix + live mutation-class battery;
(iii) dispositioned via D-026) and **F-063** (new this session — the
structural cause; fix session queued). Open P2s: F-013 (gated on F-031
drill), F-023, F-025, F-006, F-029, F-033, F-035 (remainder), F-036 (three
writers remain), F-040, F-044, F-052 (**live Slack leg re-blocked by F-063 +
needs the next genuine review — zero open reviews exist today**), F-059,
F-061. Open P3s: F-019 (browser page-JS leg = QC-6c CANARY) — and nothing
else. Housekeeping: `~/fix-worktree` carries merged branch (removable);
1 pending gmail email_reply_proposal (2026-08-14, inert — do NOT confirm it
as a test; it would send a real email); goldroute co-tenant out of scope.

## Next

**(1) F-063 fix session (P1, dedicated, D-008; owner authorization required
on the Authorizations line).** Scope: `reply_dispatch` twins for the seven
twinless command surfaces in `openclaw-plugins/resort-workflows/index.js`
(pattern: `createEmailReplyDispatchHandler` wrapping the claim handler at the
pre-model boundary; same for whatsapp/marketing/ownerrez/receipt/manual-
review/help/unknown-fallback), regression tests per surface (claims at the
reply_dispatch boundary: prefixed + wrapped + bare shapes — reuse the F-051
suite fixtures), full release path, post-deploy gateway kickstart, then the
LIVE battery: owner-typed `!help` (read) and the D-026 owner-phone `!wa`
canary rerun (rows 61/62 remain valid reply targets) — which simultaneously
closes F-051's live-corroboration leg. Also in scope: the D-026 durable
quiet-moment documentation (COMMANDS.md prose + docs/commands pages).

**(2) QC-8c — Sarah Email + Sarah Coach (RO/FIXTURE, unaffected by F-063).**
Sarah Email audit per D-019 standing rule (draft-and-approve, both providers;
auto-send dormant + policy-gated must stay so): one Slack root per provider
conversation, conservative CRM inquiry logic, immutable proposal + same-user
confirm, execute-once, Gmail-Sent/OwnerRez readback, retry-without-second-
send, mailbox reads never mark read, activity reads report live vs ledger
separately. Sarah Coach: suggestion-only, voice-corpus retrieval, NO send
path, outcome/edit capture. (The `!email` surface's twin makes its live legs
testable now if wanted.)

**Then:** (3) QC-6c CANARY (D-004 first — still unanswered and load-bearing).
(4) F-031 drill slot (D-006 window; F-013 gated). (5) QC-9 (OwnerRez +
Paloma) — NOTE: QC-9's Slack-confirmation legs also depend on the F-063 fix.

Definition-of-Done #3 note: two open P1s (F-051, F-063 — same fix session
closes the path to both). The F-031 drill must still run before baseline
stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ b7f2690 (policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged;
`node scripts/policy-fingerprint.js check` prints `match` + `agreement: ok`).
Then `cd ~/qc-worktree`, read qc/STATUS.md. If the owner authorizes the F-063
fix session (BUSINESS + OUTAGE on the Authorizations line, D-020/D-021
precedent), open with the fix scope above; otherwise run QC-8c (RO/FIXTURE).

**⚠️ Standing QC-executor rules:** (QC8-INC-01) never `pkill -f` a shared
substring — kill FIXTURE processes only by exact recorded PID, match fixture
servers by non-prod port. (QC8-07, new) a claim-path "verified live" needs a
DISCRIMINATING artifact — a ledger run, a claim log line, or byte-identical
deterministic output; a delivery line or "the bot replied" proves nothing
about WHICH path replied.

Method notes worth keeping (session 24):

- **The canary did exactly what canaries are for.** The authorized send never
  happened — and that refusal, traced to its mechanism, was worth more than a
  green send: it exposed that the flagship human command gate's AVAILABILITY
  rested on a gateway dispatch path that doesn't exist for ordinary channels,
  and that a prior live verification was misattributed.
- **Trace the dispatch, not just the handler.** F-051's fixes made the
  handlers correct; nobody had proven the HOOK fires. The dist grep that
  found a single `inbound_claim` call site (plugin-bound only) reframed three
  findings at once. The repo even knew — a PR #28 comment said so — but the
  knowledge lived in one file and never became an inventory fact.
- **"The bot replied" is the weakest possible evidence.** Both the claim path
  and the model path end in the same `delivered reply` log line. QCF058-05
  passed on that line; today's identical line pattern wrapped Sol prose. The
  discriminators that actually worked: run-ledger rows, model_tool run
  fossils, session bootstrap lines, and reply CONTENT.
- **Exonerate before you accuse.** The fixture sim with the REAL config
  (stubbed execute) cleared the plugin and config in one step, collapsing the
  search space to the gateway — and turned a "maybe config drift" hand-wave
  into a two-sided proof.
