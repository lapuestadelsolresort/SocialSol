# Owner decisions

Seeded from QC Plan v3 §11. D-001 and D-002 block QC-0 exit; D-011 blocks part of QC-7a. Answers recorded here are the authority; runtime/docs/policy are reconciled *to* this file.

## D-001 — Autonomy matrix — PARTIALLY RECORDED (blocks QC-7; informs QC-6/8)

**Recorded 2026-08-15 (owner):**

- **WhatsApp guest sends — human command required.** A human types `!wa` in Slack; no guest-bound WhatsApp message sends without that human-typed command, covering all guest-bound WhatsApp outbound including any Regina reactivation of WhatsApp-provenance contacts. This is the invariant QC-8 attempts to violate.
- **Paulina cold email — full autopilot; auto-send authorized.**
- **Regina reactivation email — full autopilot; auto-send authorized.**
- All suppression, verification, provenance, cap, and fail-closed gates bind unchanged under autopilot. Autonomy is not gatelessness.
- **Meta DMs — owner does not recognize this feature; intended state is disabled/nonexistent** (see D-002 and QC-1 T7).

**Recorded 2026-08-16 (owner, in-session, session 13 continuation):**

- **Meta campaign activation — AUTONOMOUS authorized.** The system may activate a Meta
  campaign without per-action human approval. As built, activation is human-confirmed
  (`marketing.change.propose` → exact `!meta confirm`, same-proposer) and
  `meta.campaign.autonomous` permits pause/budget-decrease only — so this grant EXCEEDS
  the built surface. Recorded as intent (D-013 precedent): the arming change goes
  through the config/release path in a fix session, and the F-001 sequencing decision
  (invariant-first vs accepted-risk) is nailed down in the walkthrough below.
- **Meta per-campaign budget increase — AUTONOMOUS authorized, bounded by an
  owner-approved AGGREGATE budget.** The total daily budget across all Meta/IG
  campaigns is the owner's decision; the system may never raise the aggregate on its
  own. Mechanism as built: `optimizer_config.budget_cap_daily` (80.00 USD/day at
  recording time) enforced at budget-increase preflight against the projected ACTIVE
  total (verified QC6-02). Cap value ratification + change procedure in the
  walkthrough below.
- **QBO writes — FULL AUTOPILOT authorized.** (`qbo.write` already live in policy;
  duplicate guards, `requestid`, write/readback, ambiguous-failure review all bind.)
- **OwnerRez mutations — FULL AUTOPILOT authorized.** As built: immutable proposal +
  same-user confirm + 15-min expiry + fresh precondition + execute-once + readback.
  Grant exceeds the built surface → recorded as intent; arming (removing per-action
  confirm) via the config/release path in a fix session; every preflight/readback/
  manual-review gate binds unchanged.
- **Postiz publishing — FULL AUTOPILOT authorized** for the sanctioned durable-workflow
  surface (`social.publish_routine` / `social.publish_due` / `social.content.publish`
  with recover-before-create, readback, and double-post guards — verified QC6-09; the
  routine/due pair is already autonomous as built). Whether the F-035(c) uninventoried
  gateway-cron `auto-organic-ig-post` job is ALSO sanctioned is decided in the
  walkthrough below — this grant does not implicitly bless un-inventoried producers.
- **Regina Airbnb-thread contacts — FULL AUTOPILOT authorized.** As built (per plan
  §9 QC-7) no send path is expected to exist for Airbnb-thread contacts; QC-7 verifies.
  Grant recorded as intent; any path that is built/armed goes through the release path
  with all suppression, provenance, language-exclusion, already-contacted, and cap
  gates binding.
- **Sarah guest-correspondence replies — AUTO-SEND authorized.** As built: immutable
  proposal + same-user confirmation. Grant exceeds the built surface → recorded as
  intent; arming via the config/release path; provider selection from the inbound
  record, execute-once, Gmail-Sent/OwnerRez readback, and retry-without-second-send
  all bind unchanged. Scope confirmation in the walkthrough below.
- **Unchanged:** WhatsApp guest sends keep the human-typed `!wa` invariant (including
  any Regina reactivation of WhatsApp-provenance contacts). Autonomy is not
  gatelessness: every suppression, verification, provenance, cap, and fail-closed gate
  binds identically under autopilot, for every row above.
- **Executor note (owner's stated premise, to be verified in QC-7):** the owner
  expects existing workflows to already carry these authorities. Verified state at
  recording time: QBO writes and routine/due publishing are live-autonomous as built;
  Meta activation, per-campaign budget increase, OwnerRez mutations, and Sarah replies
  are built confirm-gated (grant exceeds build → arming = fix-list items); Regina
  Airbnb-thread has no known send path (grant exceeds build → build+arm if/when
  wanted). Each gap is a D-001-vs-runtime discrepancy to disposition in QC-7's
  reconciliation (F-005), fix-listed per D-008 — not silently armed.

**Walkthrough sub-points — ANSWERED same session (owner, 2026-08-16):**

- **Autonomous Meta pause/decrease — RATIFIED as built.** The nine-condition safety
  net (verified QC6-03) is intended behavior; stays live; QC-7 reconciliation records
  the row as MATCHED.
- **Aggregate cap — RATIFIED at 80.00 USD/day; changes are OWNER-ONLY.** Any request
  to change `optimizer_config.budget_cap_daily` routes to the owner; the system never
  raises the aggregate autonomously.
- **Autonomous-activation arming order — INVARIANT FIRST.** Autonomous activation
  arms only in/after the F-001 fix session: the machine-enforced creative/landing-
  review invariant + regression test (and committed briefs per F-045 for governed
  campaigns) land BEFORE the human `!meta confirm` backstop is removed.
- **Regina Airbnb-thread — GRANT-ONLY for now.** Authority recorded; nothing is
  built/armed until the owner requests the feature; QC-7 verifies no send path exists
  (as designed).
- **Sarah auto-send scope — ALL inbound guest-correspondence replies, BOTH providers
  (Gmail + OwnerRez).** Arming via the release path; every provenance/readback/
  no-second-send gate binds.
- **F-035(c) `auto-organic-ig-post` gateway-cron — RETIRE.** The un-inventoried cron
  job is NOT sanctioned; it gets disabled in a fix session and organic IG posting
  moves onto the sanctioned autonomous `social.*` workflow surface. (Partial F-035
  disposition; the inventory/manifest work and the other cron jobs' dispositions
  remain with F-035.)

**D-001 is now FULLY RECORDED — owner sign-off 2026-08-16 ("Confirmed — D-001
complete"). QC-7 gate satisfied.** Arming changes implied by grants that exceed the
built surface (Meta autonomous activation [after F-001], OwnerRez mutation autopilot,
Sarah auto-send both providers) are fix-list items through the config/release path
(D-008); F-005 closes only after QC-7 reconciles runtime/docs/policy to this matrix
and dispositions every discrepancy.

## D-002 — Transport authorization audit — PARTIALLY RECORDED (blocks QC-0 exit for recorded rows)

**Recorded 2026-08-15 (owner):**

- WhatsApp automation and its Slack integration — **authorized**; an important part of the current workflow.
- Sarah email automation (the outbound email surface Paulina and Regina send through) — **authorized**; auto-send intended.
- Squarespace commerce — **authorized**; intent is full integration with maximum read/write capability. Authority boundaries in QC-5 still apply: Squarespace never creates or edits OwnerRez bookings and never represents Airbnb/Vrbo payouts.
- Meta DM path — **owner does not recognize this as a feature**; if QC-1 T7 finds any Meta DM send path, open F-020, quarantine, and stop for an owner decision.
- **Meta DM disposition recorded 2026-08-15 (owner, after T7 evidence): QUARANTINE.** Intended state = disabled. Remove `meta.dm.reply` from `live_workflows` via the config/release path in a dedicated fix session and verify `!dm` receives the shadow-mode refusal. Inbound DM forwarding to Slack may remain. (F-020 closure path.)
- **F-020 fix-session authorization recorded 2026-08-15 (owner):** BUSINESS (release-path deploy of the policy change) and OUTAGE (gateway reload) authorized for the dedicated quarantine fix session, scoped to F-020 only, including the shadow-refusal verification step. Executed under D-008 (confirmed).

- **Cal.com inbound booking webhook recorded 2026-08-15 (owner):** recognized/authorized surface. Currently dormant-by-config (`secrets/calcom.json` absent → every request 503 fail-closed); fail-closed-by-config accepted as the interim control; mounted-route violation probes deferred to QC-10 (QC2B-12). Meta inbound-webhook mounted-route probes assigned to QC-8 the same day (QC2B-10).

- **Owner cash-flow command surface recorded 2026-08-16 (owner, in-session): AUTHORIZED AS BUILT.** CLI report + the enabled chat-agent plugin (gated to one agent) both intended; the local-only `--apply-reconciliation` link writer stays available. Verified state at decision time: GET-only OwnerRez client, deterministic report, fail-closed plugin, numbers provider-verified (QC5-05). The CLI's writable-DB-open vs read-only claim is F-042 (P3 fix-list; RO handle proven sufficient).

**D-002 is now fully recorded — no open rows.**

- **QC-5 phase-boundary authorization recorded 2026-08-16 (owner, in-session): agent-run END-TO-END** (push, PR create, merge, docs-only fast-forward of production main), BUSINESS-scoped to this boundary only; owner-run push fallback if the permission classifier blocks; ancestry + incoming-files proofs and post-ff runtime-baseline verification required per the QC3B-13/QC4B-04 pattern.

## D-003 — Max plan tier and usable session length — RECORDED 2026-08-15

**Owner:** Max 20x; long sessions OK (2+ hours fine). Phases may run as single large sessions; the a/b splits remain available as fallbacks, and the ~70%-budget guardrail (§8) still applies.

## D-004 — Blackout windows — OPEN

Live campaigns, warmup ramps, guest quiet hours; days/times when CANARY/OUTAGE/BUSINESS actions are forbidden.

## D-005 — Reconciliation month for QC-4 — RECORDED 2026-08-15

**Owner:** July 2026 (most recent fully closed month).

## D-006 — Restore-drill and offsite-retrieval approval — RECORDED 2026-08-15

**Owner (2026-08-15; owner's note dated "2026-08-__", received and recorded 2026-08-15):**

- **Drill windows:** weekdays 10:00–16:00 PT; never during active sends or guest quiet hours.
- **Offsite retrieval:** approved, read-only, anytime.
- **Restores:** disposable copies in scratch space only.

**Targets (max data loss / max time to recover):**

| Store | RPO | RTO |
|---|---|---|
| CRM DB (incl. campaign registry) | ≤24h | ≤4h |
| paloma tasks.db | ≤24h | ≤8h |
| workflow/policy.json + openclaw config | ≤24h | ≤2h |
| accounting inbox/archive | ≤24h | ≤24h |
| warmup state | ≤7d | ≤24h (or accepted loss + re-ramp) |
| secrets/recovery material | zero loss | ≤4h |
| media originals | ≤7d | ≤72h |
| Chroma | rebuildable — no targets; verify documented rebuild path | — |

**Executor interpretation applied (2026-08-15, conservative; owner may widen):** the weekday 10:00–16:00 PT window governs restore drills *including* their disposable-restore step (decrypt/restore/verify/RTO timing); offsite retrieval alone (fetch + read-only verification of the retrieved artifact) is authorized anytime; any restore, whenever performed, goes only to a disposable copy in scratch space. QC-3b session of 2026-08-15 (Saturday, outside the window) therefore performs retrieval + all RO audit work; the timed restore drill runs in the next window (Mon 2026-08-17 10:00–16:00 PT) after checking active sends and guest quiet hours.

**Window widening recorded 2026-08-16 (owner, in-session):** owner approved the rule change and directed the QC-3b timed off-host-format restore drill to run now (Sunday 2026-08-16, ~07:45 PDT — outside the weekday 10:00–16:00 window). Scope: this drill session; all other D-006 terms unchanged — live-state preflight (active sends / queued work / deploy lock) still required before the restore step, restores remain disposable/scratch-only, retrieval remains RO-anytime. Owner also independently confirmed seeing the CRM backup artifacts in Google Drive (corroborates QC3B-06/07 offsite evidence).

## D-007 — Sign-off roles — OPEN (partial)

Jason = business authority. Sarah = guest and email UX surfaces. Accounting reconciliation validator = ?

## D-008 — Fix policy — RECORDED 2026-08-15

**Owner (2026-08-15): confirmed as proposed.** P0 contained immediately with explicit authorization; P1 fixed in a dedicated session through the full release path; P2/P3 batched; every fix carries a regression test and post-deploy production verification.

## D-009 — Test identities and markers — RECORDED 2026-08-16

**Owner (2026-08-16, in-session, session 13 continuation; walkthrough per the
D-006-before-QC-3b pattern):**

- **Channel marker — dedicated `#qc-scratch` channel** (chosen over the `[QC TEST]`
  prefix). QC-authored test messages post there. Creating the channel + its
  channel-policy/capability entries goes through the config/release path →
  **fix-list item** (prerequisite only for CANARYs that need QC-authored Slack
  posts). Nuance recorded: system-routed side effects of canary events (e.g., a
  test WhatsApp inbound surfacing in `#whatsapp` via normal forwarding) land in
  production channels BY DESIGN — the canary exercises the real path; those
  artifacts are identified by the allowlisted test identities and handled by each
  CANARY's written cleanup/reconciliation plan, never redirected.
- **Allowlisted test email — `jason@lapuestadelsolresort.com`** (owner-supplied
  in-session). Used by QC-7's planted do-not-contact/suppression test and any
  email CANARY; every send still requires session-level CANARY approval. This
  address string is a deliberately committed test identity (sanctioned for §4.1
  sweeps).
- **Allowlisted test phone — the owner's personal WhatsApp number.** The raw
  number enters only CANARY-session config and `~/qc-evidence/` (never committed
  text — aliased per §4.1); supplied by the owner at session time. Lead/contact
  rows it creates are flagged and reconciled per the session's cleanup plan.
- **Browser-load funnel leg — named home: dedicated `QC-6c` CANARY session**
  (chosen over folding into QC-10). Schedulable any time after QC-7 in a suitable
  window. Scope: controlled browser loads per destination — including the two
  zero-delivery ad variants (F-019) — proving deployed page JS → session/UTM
  capture → CTA click → `wa_ref` linkage; then the test-phone WhatsApp leg proving
  signed inbound → durable workflow → lead/attribution → CAPI eligibility; with a
  written cleanup/reconciliation plan and synthetic-session marking so QC visits
  are excludable from metrics (mechanics designed in the session plan; the
  existing `testlv-` convention is the model). Requires session-level CANARY
  authorization per §5; also shakes out the D-009 identity machinery QC-7's
  planted-contact test reuses.

## D-010 — Corporate Intelligence scope — OPEN (confirm)

Boundary/no-leakage check only; content audited separately under privileged controls.

## D-012 — Paloma scheduled services (paloma-followup / paloma-scan / paloma-summary) — RECORDED 2026-08-15

**Owner (2026-08-15): INSTALL them.** The scheduled half is wanted. Adopt the trio into the sanctioned install path in the F-016 fix session; QC-9 then tests them. (Context: committed + rendered every deploy but never installed — F-016b, E-QC1B-14.)

## D-011 — Paulina email-reply confirmation semantics — RECORDED 2026-08-15

**Owner:** Non-expiring, anywhere in channel — the current implementation is the intended behavior. The stale 15-minute/same-thread doc gets corrected through the release path; QC-7a then tests the ratified contract.

## D-013 — QC-4 accounting authorizations and dispositions — RECORDED 2026-08-16

**Owner (2026-08-16, in-session):**

- **QBO read-only API access authorized for QC-4b and subsequent QC sessions** (SELECT
  queries + entity GETs, no entity writes), accepting the incidental token refresh through
  the sanctioned locked+atomic path (qbo_push.py QBOClient) that a stale access token
  triggers — the same refresh qbo-keepalive performs weekly. Raw QBO data stays in
  ~/qc-evidence (never Git); aliases in committed text.
- **receipt.owner_expense.reconcile: intended state is LIVE.** Owner's stated default
  posture: surfaces should have as much read/write capability as possible within
  reasonable limits; when intended state is unknown, default to read/write live. Recorded
  as intent — the arming change (live_workflows addition) still goes through the
  config/release path in a fix session (D-008), and every gate/suppression continues to
  bind (autonomy is not gatelessness). Fix-list item added.
- **kapital-tests stays scheduled** (Mon 08:00) until the F-014 fix session — status-quo
  risk accepted for the interim.

**D-013 addendum (owner, 2026-08-16, in-session):** QC-4 phase-boundary merge authorized
agent-run END-TO-END — push, PR create, merge, and docs-only fast-forward of production
main (BUSINESS-scoped, this boundary only; ancestry + incoming-files proofs and post-ff
runtime-baseline verification still required, per the QC2B-14/QC3B-13 pattern).

## D-014 — F-044 external paid stream + QC-6 phase boundary — RECORDED 2026-08-16

**Owner (2026-08-16, in-session, QC-6 session 13):**

- **F-044 external paid Meta stream (`sf_full_resort_march_2026`) — RECOGNIZED: "Yes, I
  run it."** The owner runs this campaign from an ad account outside the system token's
  reach. F-044 downgrades P1 → P2 (governance blind spot, not unauthorized spend): the
  spend is owner-known but invisible to the registry, budget cap, daily paid report,
  autonomy safety net, and tracker-liveness destination checks (CAPI is already
  correctly excluding it). **Still open for a later owner decision:** register the
  campaign (registry entry/alias so reporting + caps + liveness see it, and/or system
  credentials gaining read access to that account) vs. accepted-risk in writing.
  F-010's unknown ("is the legacy account spending?") resolves to: an owner-run
  outside-system account is actively spending; system-side dormancy conclusions
  unchanged (no system path to it).
- **QC-6 phase-boundary merge authorized agent-run END-TO-END** — push, PR create,
  merge, docs-only fast-forward of production main (BUSINESS-scoped, this boundary
  only; owner-run push fallback if the permission classifier blocks; ancestry +
  incoming-files proofs and post-ff runtime-baseline verification required, per the
  QC5-07/QC4B-04 pattern).

## D-015 — F-047 Paulina edit-override consent-bypass severity — RECORDED 2026-08-16

**Owner (2026-08-16, in-session, QC-7a session 14): keep it a P2.**

F-047 (Paulina edit-override send-time carve-out downgrades suppression [item 1] and
do_not_contact [item 2] to advisory when an `edit_override` marker is present, allowing a send
to a suppressed/DNC contact — reproduced in FIXTURE case D, QC7A-03) stays **P2**, not P1. It
remains a D-008 P2-batch fix-list item: scope the send-time carve-out to content items 6/7 only,
always enforce items 1-5 at send regardless of edit_override, plus a regression test
(suppressed+edit_override → cancelled, not sent). Reachability is bounded (requires a prior human
edit that trips the content gate, then a post-edit suppression before the scheduled send; one
email per override row; campaign not paused; 5 edited drafts ever, all terminal; not fired) — the
compensating context supporting P2.

## D-016 — Fix session #1 start-of-session answers (F-031/F-032 residuals + channel bindings + D-009 channel) — RECORDED 2026-08-17

**Owner (2026-08-17, in-session, fix session #1):**

- **F-031(i) — pre-rotation backup key ESCROWED off-host NOW.** Owner ran the pbcopy
  runbook (separate Terminal, never through the agent session) and stored the
  pre-rotation passphrase in their off-host password manager. The archive half of the
  F-031 escrow gap closes owner-side; the escrow-retrieval drill (D-006 window) and
  optional archive re-encrypt remain the named closure steps.
- **F-031(ii) — current backup passphrase confirmed stored off-host (password manager).**
  Post-rotation artifacts are no longer single-homed.
- **F-032(d) — warmup state: ACCEPTED LOSS + RE-RAMP** per D-006's explicit option.
  Accepted-risk row; no backup producer built for warmup.
- **F-032(e) — media originals: offline copy ATTESTED to exist** (owner-maintained).
  Consequence: the checksum-verification control lands with this session's manifest
  work (media-backup-verify job); first full verify runs when the owner supplies the
  mounted copy (drill session at the latest).
- **squarespace-report bizevent notices → `business-intel`** (policy channel). The
  installed plist's binding to the reengager-regina channel ID is dispositioned as a
  hand-install error, corrected by the converged install this session.
- **squarespace-report housekeeping notices → owner-designated `#housekeeper` channel**
  (ID supplied in-session; registered in the runtime channel policy as `housekeeper`
  via the sanctioned config path; renderer follows the policy name). Neither the
  previously installed out-of-policy ID nor `receipts-housekeeper` is the intended
  destination.
- **D-009 #qc-scratch channel CREATED by owner** (ID supplied in-session; bot account
  invited). Channel-policy entry lands via the sanctioned config path this session.

## D-017 — Claim-interception outage: scope, channels, and resolution transport (fix session #1) — RECORDED 2026-08-17

**Owner (2026-08-17, in-session, fix session #1):**

- **Review-resolution channels — BOTH options:** add `prospector-paulina` to
  `write_notifications.channel_ids` (immediate unblock; server reads policy fresh)
  AND make `business-intel` plugin-bound so the configured fallback is reachable
  (renderer change: write_notifications channels render workflow-only — PR #78).
- **Scope extension AUTHORIZED:** the claim-handler fixes (channel-id prefix
  normalization PR #78; metadata-wrap command parsing PR #79) added to today's
  BUSINESS release-path work — `!wa` had been failing closed since 2026-08-15 and
  the outage blocked resolving the review that gated the deploy. Both PRs
  agent-run except merges (classifier block → owner-run merges, precedent
  QC3B-13 fallback).
- **Owner-directed terminal review resolution AUTHORIZED:** after five failed
  Slack attempts (F-051 layers, ending at gateway event-coalescing), the owner
  authorized resolving review 3ce3ad0f… via the server's resolve endpoint
  (control-plane bearer token; same atomic path + audit event;
  resolved_by = owner's Slack id; context = business-intel + the slack command
  entrypoint label as transport claim). Recorded honestly as
  terminal-transport-under-owner-direction; the Slack path remains F-051/F-052
  closure work.
- **Out-of-band policy edit ATTRIBUTED to the owner:** the 07:05–08:29 hand edit
  of policy.json (write_notifications gaining business-intel) was the owner
  troubleshooting; recorded (F-055), content superseded by this decision's
  channel list.

## D-015 — F-047 severity + QC-7 phase boundary — RECORDED 2026-08-16

**Owner (2026-08-16, in-session, QC-7b session 15):**

- **F-047 (Paulina edit-override consent-bypass) — CONFIRMED P2.** Bounded and
  compensated (requires a prior human edit, one email per override row, 5 edits ever
  all terminal, never fired). Fix lands in the D-008 P2/P3 batch: scope the send-time
  carve-out to content items 6/7 only, items 1-5 always enforce at send time, plus a
  regression test (suppressed+edit_override → cancelled). QC-7b evidence that Regina
  is NOT affected (auto-send.js has no carve-out; FIXTURE case A3) recorded with the
  finding.
- **QC-7 phase-boundary merge authorized agent-run END-TO-END** — push, PR create,
  merge, docs-only fast-forward of production main (BUSINESS-scoped, this boundary
  only; owner-run push fallback if the permission classifier blocks; ancestry +
  incoming-files proofs and post-ff runtime-baseline verification required, per the
  QC4B-04/QC5-07/QC6-11 pattern).

## D-018 — Session 17 (Sarah/OwnerRez arming fix session) authorization + F-051 interim report — RECORDED 2026-08-17

**Owner (2026-08-17, start-of-session, session 17):**

- **BUSINESS + OUTAGE AUTHORIZED**, scoped to the Sarah/OwnerRez arming fix session
  (Sarah guest-correspondence auto-send both providers + OwnerRez mutation autopilot,
  per the D-001 grants): full release path agent-run — branch, tests, PR create, CI
  verify, fast-forward of production main, deploy including crm/worker restarts and
  any gateway reload. Merges owner-run via `! gh pr merge N --merge` if the permission
  classifier blocks (QC3B-13/QCFS1-01 precedent). Every D-001 gate-binding term holds:
  arming removes per-message/per-action human approval only; suppression, provenance,
  preflight, execute-once, readback, and manual-review gates bind unchanged.
- **F-051 interim (STATUS start-of-session ask): owner attempted exact Slack
  command(s) since the 0af5583 deploy and the bot ACKNOWLEDGED.** Recorded as an
  interim positive signal for the deployed (i)+(ii) fixes; corroborating ledger/log
  evidence is pulled read-only this session (evidence row). Formal F-051 closure still
  rides QC-8's quiet-channel exact-command battery + the (iii) coalescing disposition.

**Arming-scope walkthrough (owner, 2026-08-17, in-session — D-001 addendum):**

- **Sarah/email auto-send scope — WHOLE `email.reply` surface.** Auto-send (no
  `!email confirm` step) applies to guest correspondence in #sarah-email (Gmail +
  OwnerRez threads) AND to outreach-reply threads in #prospector-paulina. Widens the
  D-001 Sarah row's "guest-correspondence" letter to the full built surface —
  consistent with Paulina/Regina full autopilot on the same transport. The human
  still authors every reply (`!email reply <text>`); arming removes only the second
  confirmation command.
- **OwnerRez FULL AUTOPILOT semantics — CONFIRMED: execute immediately.** When an
  allowlisted (`restricted_capabilities.ownerrez.write.users`) user has Sol create a
  mutation proposal, it executes at once — preflight snapshot, fresh-precondition
  assert, execute-once effect, provider readback, and reservations-channel
  notification all bind unchanged; no `!ownerrez confirm` paste. Manual confirm stays
  functional as a fallback for any pending proposal.
- **Live verification — email canary THIS SESSION** after deploy + policy arming:
  owner emails Sarah's address from the D-009 test identity
  (jason@lapuestadelsolresort.com), then issues a real `!email reply` in
  #sarah-email; proves the armed path with zero real guests. OwnerRez live canary
  defers to QC-9 (fix-before-audit: QC-9 audits the final armed config).

**SUPERSEDED IN PART — owner instruction later the same day (2026-08-17, session
17b):** after the PR #80 code deploy (runtime baseline 1dd627ed) but BEFORE the
policy arming step ran, the owner ordered a full stop on arming and an RO
investigation instead. The owner's newly stated intended state: **Paulina
auto-send ENABLED; Regina auto-send ENABLED; Sarah guest-correspondence replies
DRAFT-AND-APPROVE (human confirms each send; no auto-send path on either
provider)** — this supersedes this addendum's "whole surface" Sarah grant and
the OwnerRez immediate-execution arming, pending a per-operation decision
(D-019). Consequences executed in-session: the staged armed-policy candidate was
deleted; runtime policy.json proven untouched (sha aa71f387, mtime 08:29);
neither confirm workflow is in autonomous_workflows; the email canary is
CANCELLED (not merely deferred) unless D-019 revives it. The deployed PR #80
dispatch code remains dormant and policy-gated → F-057, dispositioned in D-019.

## D-019 — Per-operation OwnerRez autopilot matrix + dormant-dispatch disposition — OPEN (2026-08-17)

Input: `qc/RO-2026-08-17-email-autonomy-ownerrez-mutation-map.md` (34 fixed
operations; shared gate chain; `destructive` flag as a natural decision axis;
zero production usage to date). The owner decides:

1. Which of the 34 OwnerRez operations (if any) get autopilot vs stay
   confirmation-gated. Note: today's arming switch (`autonomous_workflows`) is
   per-WORKFLOW — arming `ownerrez.mutation.confirm` arms all 34 at once; a
   per-operation grant requires a small code extension (e.g. an
   `autonomous_operations` allowlist checked against operationId in the
   dispatch step) through the release path.
2. Whether the dormant PR #80 auto-confirm dispatch steps (email + ownerrez)
   stay in place as the arming mechanism for whatever is granted, or are
   reverted via the release path (F-057).
3. Whether Sarah draft-and-approve is now the standing D-001 row (recommend:
   yes, recorded as such — it matches the deployed behavioral state).
