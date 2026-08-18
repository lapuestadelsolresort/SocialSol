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

**Addendum 2026-08-17 (D-019 supersessions — current standing matrix for these
two rows):**

- **OwnerRez mutations — CONFIRMATION-GATED (all 34 operations).** The
  2026-08-16 FULL AUTOPILOT row is superseded by D-019 item 1: every mutation
  keeps immutable proposal + same-user `!ownerrez confirm` + 15-min expiry +
  fresh precondition + execute-once + readback. No autopilot for any operation.
- **Sarah guest-correspondence replies — DRAFT-AND-APPROVE (standing rule,
  both providers, whole `email.reply` surface).** The 2026-08-16 AUTO-SEND row
  and the D-018 "whole surface" walkthrough answer are superseded by D-019
  item 3. Recorded future intent: auto-send anticipated later; the mechanism
  exists dormant (PR #80 dispatch, policy-gated); arming only by a future
  owner-initiated decision via the D-019 arming procedure.
- All other D-001 rows (WhatsApp `!wa` invariant, Paulina/Regina autopilot,
  Meta rows incl. invariant-first activation order, QBO, Postiz, Regina
  Airbnb-thread grant-only) are unchanged.

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

## D-019 — Per-operation OwnerRez autopilot + dormant-dispatch disposition + Sarah standing rule — RECORDED 2026-08-17

Input: `qc/RO-2026-08-17-email-autonomy-ownerrez-mutation-map.md` (34 fixed
operations; shared gate chain; `destructive` flag as a natural decision axis;
zero production usage to date).

**Owner (2026-08-17, session 17c):**

1. **OwnerRez mutations — KEEP "ALWAYS ASK FIRST" FOR EVERYTHING.** All 34
   operations stay confirmation-gated (agent proposes → human pastes
   `!ownerrez confirm`). NO autopilot granted for any operation. Consequence:
   the `autonomous_operations` per-op extension is NOT built now;
   `ownerrez.mutation.confirm` stays out of `autonomous_workflows`. This
   supersedes D-001's 2026-08-16 "OwnerRez mutations — FULL AUTOPILOT" row.
2. **Dormant auto-confirm machinery — LEAVE IN PLACE, DOCUMENTED.** The owner
   expects to use it in the future when the time is right and wants its
   existence durably documented. It stays deployed and policy-gated (inert
   while neither confirm workflow is listed in `autonomous_workflows`).
   Documentation homes as of this recording: this D-019 record (incl. the
   arming procedure below); the RO map note
   (`qc/RO-2026-08-17-email-autonomy-ownerrez-mutation-map.md`); sarah-email +
   prospector COMMANDS.md (behavior in both modes — with one stale
   parenthetical each to correct, see F-057 residual);
   `workflow/policy.example.json` (residual: currently SHOWS the armed shape —
   to be reverted to the standing un-armed shape so the example matches
   intent). F-057 dispositioned: keep-dormant.
3. **Sarah guest-correspondence replies — DRAFT-AND-APPROVE is the STANDING
   RULE** (human writes and confirms every send, both providers; applies to
   the whole `email.reply` surface, #sarah-email and #prospector-paulina
   reply threads, since the arming switch is per-workflow and nothing is
   armed). **Recorded future intent: auto-send WILL be wanted at some point**
   — nothing more is built now; the future path must stay available, and it
   already exists: the dormant dispatch of item 2 IS the auto-send mechanism,
   already regression-tested. This supersedes D-001's 2026-08-16 "Sarah
   auto-send" row and the D-018 walkthrough's "whole surface" grant.

**Arming procedure for the future (owner-initiated only; BUSINESS
authorization + a fix session):** add `email.reply.confirm` and/or
`ownerrez.mutation.confirm` to `autonomous_workflows` in the runtime
`workflow/policy.json` via the sanctioned edit path (backup copy → candidate
validated with the repo's `validatePolicy` → diff reviewed → atomic mode-600
install; server picks it up by mtime, worker reads policy fresh per step — no
restart). Un-arming is the one-line reverse. Live verification per the D-018
canary design (test identity per D-009). If only a SUBSET of OwnerRez
operations should ever be armed, build the small `autonomous_operations`
allowlist extension first (release path).

## D-020 — F-001 fix session authorization + F-045 brief scope — RECORDED 2026-08-17

**Owner (2026-08-17, start-of-session, F-001 fix session; asked because the
session's Authorizations line was blank):**

- **BUSINESS + OUTAGE AUTHORIZED — FULL SCOPE.** The F-001 fix session runs
  the full release path agent-run (fix branch → tests → PR create → CI verify
  → merge → fast-forward of production main → deploy incl. crm/worker
  restarts), and then — only after the machine-enforced creative/landing-
  review invariant + regression tests land at the deployed SHA — the Meta
  autonomous-activation arming step, per D-001's invariant-first walkthrough
  answer (2026-08-16). Merges/ff owner-run via `!` commands if the permission
  classifier blocks (QCFS2-01 precedent). Every D-001 gate-binding term holds:
  arming removes the per-action human backstop only; preflight, semantic
  brief↔live assert, execute-once, readback, aggregate budget cap
  (80.00 USD/day, owner-only changes), and manual-review gates bind unchanged.
- **F-045 brief scope: ALL FIVE brief-less registry campaigns.** The 3 ACTIVE
  (weddings, corporate-retreats, retarget-warm/hot) AND the 2 non-planner
  PAUSED registry campaigns get committed brief files this session, so the
  gated mutation catalog and the new review invariant bind to the whole
  registry — including emergency pause reachability. Owner notes the paused
  two thereby become autonomously activatable (once armed) subject to the
  review invariant; activation of a paused campaign still requires the
  invariant's approved review state, the semantic assert, and the aggregate
  cap preflight.

**Addendum — session executed same day (2026-08-17):**

- **Arming EXECUTED.** After the invariant + briefs deployed and verified at
  runtime baseline `c0a7b72` (PR #81, deploy record
  2026-08-17T20-10-12-727Z completed 11/11), the owner confirmed "Arm now" in
  the in-session ask and personally ran the atomic install (agent install
  classifier-blocked — QCFS2-03 precedent). Runtime `workflow/policy.json`
  sha `aa71f387…` → `0dd75080a85ac297…`, mode 600:
  `autonomous_workflows` += `marketing.change.confirm`;
  `autonomous_operations = {"marketing.change.confirm": ["campaign_activate"]}`.
  ACTIVATION ONLY — pause, budget, provision, and both landing operations
  remain `!meta confirm`-gated; `email.reply.confirm` and
  `ownerrez.mutation.confirm` remain un-armed (D-019 standing state
  preserved). Deployed `loadPolicy`/`validatePolicy` accept the installed
  file; system-origin authorization for the confirm workflow verified allowed.
- **Un-arming (owner-initiated):** restore
  `~/qc-evidence/F001-FIX/policy-pre-arming-20260817T201341Z.json` (sha
  `aa71f387…`) over `workflow/policy.json` via the same atomic mode-600
  install, or remove the two policy entries by hand.
- **Effective autonomy after arming:** an activation proposal auto-executes
  ONLY when the target brief's registry row carries a human Slack approval
  receipt whose `brief_hash` matches the current committed brief (the F-001
  invariant); fresh preflight, semantic brief↔live assert, execute-once,
  provider readback, drift auto-rollback to PAUSED, and reservations-channel
  notification bind unchanged. At arming time ZERO campaigns have recorded
  receipts, so nothing can auto-activate until the owner reviews and records
  approvals (`automation/campaign_approval.py record`, which now binds
  `brief_hash`; the pre-existing planner receipt reads as stale until
  re-recorded).
- **Budget-increase autonomy NOT armed** (D-001 grants it; this session's
  queue item was activation only). Arming it later is one line in
  `autonomous_operations` plus session authorization.

## D-021 — F-014 fix session authorization + scope — RECORDED 2026-08-17

**Owner (2026-08-17, start-of-session, F-014 fix session; asked because the
session's Authorizations line was blank):**

- **BUSINESS + OUTAGE AUTHORIZED — F-014 ONLY.** The weekly accounting
  control rebuild runs the full release path agent-run (fix branch → tests →
  PR create → CI verify → merge → fast-forward of production main → deploy
  incl. crm/worker restarts). Merges/ff owner-run via `!` commands if the
  permission classifier blocks (QCFS2-01/QCFS3-01 precedent).
- **P2/P3 batch DEFERRED** to a follow-on session (owner chose the scoped
  option over "F-014 + P2/P3 batch"). This session lands one reviewable
  change against one P1 anchor, consistent with D-008's "P1 = dedicated
  session, full release path". The batch (F-052, F-053, F-054, F-055, F-056,
  F-057 residual, F-058, F-019 threshold, F-047, F-048/49/50, F-032(c),
  F-042/43/46, F-039) stays the queue head after this session.
- **D-004 not answered** (owner answered the authorization question only).
  The explicit OUTAGE grant supplies this session's window; the executor
  still runs a live-state preflight and states rollback/abort criteria
  before the deploy, per plan §5. D-004 remains open for a standing answer.

**Executor design decisions taken under this authorization** (routine calls,
recorded because they shape the deployed control):

- **Checks 1 and 6 become terminal via live read-only Slack scans**, not by
  reconciling the pipeline's own projection. Reconciling the projection
  would structurally miss the failure the checks exist to catch — a receipt
  posted to Slack that the pipeline never ingested. Mechanism proven RO this
  session: `openclaw message read --channel slack --target channel:<id>
  --limit N [--before <ts>] --json` returns `payload.messages` with `ts`,
  `text`, `files`, and **`reactions` inline** (`white_check_mark` present),
  plus `payload.hasMore`; `--before` paging verified to walk strictly older.
- **Failure semantics split by class**, so the watchdog owns real problems
  without permanent noise: ERROR (check crashed) and FAIL (integrity
  violation — duplicates, or unmatched receipts/✅ older than the grace
  window) → exit 1 + `job_health` failed; WARN (attribution hygiene —
  orphaned group/food expenses, salary-month advisories) → exit 0 +
  `job_health` ok, with counts still delivered in the Slack report. A
  Slack-post failure is itself exit 1 (daily-tests precedent).
- **Unmatched-receipt grace window (7 days, configurable)** distinguishes
  in-flight receipts from unbooked ones, so recency lag is not reported as
  an integrity failure.
- **No token refresh in the test job at all** (the closure spec's second
  option): `tests.py` drops its private `_qbo_auth` and uses the sanctioned
  `qbo_push.QBOClient`, which already does env-aware secrets resolution +
  `.refresh.lock` flock + tmp/fsync/replace/chmod-600. This also removes
  writer #4 from F-036.

## D-022 — P2/P3 batch session authorization + scope + F-048 disposition — RECORDED 2026-08-17

**Owner (2026-08-17, start-of-session, P2/P3 batch session; asked because the
session's Authorizations line was blank — D-020/D-021 precedent):**

- **BUSINESS + OUTAGE AUTHORIZED — full release path.** The batch runs
  agent-run end to end (fix branch → tests → PR create → CI verify → merge →
  fast-forward of production main → `release:deploy` incl. crm/worker
  restarts). Merges/ff owner-run via `!` commands if the permission
  classifier blocks (QCFS2-01/QCFS3-01/QCFS4 precedent). Live-state preflight
  + stated rollback/abort criteria still precede the deploy (plan §5).
- **SCOPE: the batch MINUS F-058.** In scope: F-039, F-047, F-052 remainder,
  F-053, F-054, F-055, F-056, F-057 doc residual, F-019 threshold, F-042,
  F-043, F-046, F-048 (docs), F-049, F-050, F-032(c) residual, F-060.
  **F-058 gets its own follow-on session** — it is a generation pipeline
  (COMMANDS.md emitted from `/api/workflows/definitions`, regenerated in the
  release path) plus a new Slack surface (`!help` + unknown-command
  guidance) plus a marketing command reference; bundling it here would put a
  docs-generation build and behavior fixes in one release.
- **F-048 — CORRECT THE DOCS.** Regina's `!sent`/`!skip`/`!defer` are
  operator-terminal-only; `regina/COMMANDS.md` + the three script headers are
  corrected to say so rather than wiring a Slack dispatch path. Rationale
  accepted: the compensating sweeps already close the loop in production
  (gmail-reconcile pass-1 auto-marks from Gmail Sent evidence; pass-2 reminds
  every 14d then auto-rejects after 3 — the May-era drafts were all actioned
  that way), and a new interception path would inherit the F-051(iii)
  coalescing caveat. No new Slack surface is built.
- **D-004 still not answered** (the authorization question was answered on its
  own). The explicit OUTAGE grant supplies this session's window; D-004
  remains open for a standing answer (load-bearing at QC-6c and QC-10).

## D-023 — F-058 command-surface session: authorization + doc shape + coverage + unknown-command scope — RECORDED 2026-08-17

**Owner (2026-08-17, start-of-session, F-058 session; authorization supplied on the
Authorizations line, the three design forks asked because F-058's closure criteria
did not settle them):**

- **BUSINESS + OUTAGE AUTHORIZED — F-058 only, full release path agent-run.**
  Branch → tests → PR create → CI verify → merge → fast-forward of production main
  → `release:deploy` including crm/worker restarts and any gateway reload.
  Merges/ff owner-run via `!` if the permission classifier blocks (D-022 precedent).
  Live-state preflight + stated rollback/abort criteria still precede the deploy.

- **Doc shape — PROSE + GENERATED BLOCK.** Existing `COMMANDS.md` prose is kept
  verbatim; the generator owns a delimited `BEGIN/END GENERATED` region carrying the
  machine truth (workflows bound to the surface, capability, mutates/autonomous,
  allowed triggers, exact Slack command). CI regenerates and fails on any byte
  difference inside the markers. Rationale: full generation would delete real
  operator knowledge (Regina's gmail-reconcile loop, the receipt payment-source
  rules) that no payload contains, and the byte-identical closure criterion is met
  either way.

- **Coverage — ALL EIGHT SURFACES.** The four existing files (prospector, regina,
  sarah-coach, sarah-email) plus marketing/Meta (the $40/day gap F-058 names) and
  whatsapp, accounting, reservations — every channel surface in the render script's
  `CHANNEL_MUTATION_WORKFLOWS` map. Executor's routine call on paths (recorded here
  so the mapping is reviewable): marketing → `campaigns/COMMANDS.md` (beside the
  committed briefs its commands act on), accounting → `accounting/COMMANDS.md`,
  and the two surfaces with no code directory of their own → `docs/commands/
  whatsapp.md` and `docs/commands/reservations.md`.

- **Unknown-command guidance — ALL CONTROLLED CHANNELS.** A lowest-priority
  `inbound_claim` fallback claims any `^!` message in the 37 controlled channels
  that no other handler claimed, and replies with the real commands for that
  channel. Sol no longer improvises over stray `!` text there. Side benefit:
  `!sent`/`!skip`/`!defer` typed in a Regina thread finally answer
  "operator-terminal only, no Slack dispatch path" (F-048) instead of silence.
  **Explicitly NOT a fix for F-051(iii):** a coalesced command is never delivered
  as its own event, so no handler fires — including this one. The advisory stands.

**Two recorded corrections to F-058's own text (plan §2 — reality wins):**

1. **Seven Slack commands exist, not eight.** `!raw` is a false positive in the
   finding: every `!raw` hit is `if (!raw)`, a negation of a variable named `raw`
   (`openclaw-plugins/resort-workflows/index.js:394,1085,1993,2027` and six more in
   crm/). The real set is `!wa`, `!dm`, `!email`, `!meta`, `!ownerrez`, `!receipt`,
   `!review`.
2. **"`!help` renders only policy-live workflows" cannot be applied literally.**
   Shadow mode gates only *external mutation* step classes
   (`crm/lib/workflow-execution-policy.js:5-22`); read workflows are `read` /
   `external_read` and execute fully whether or not they are listed. None of the 21
   read workflows is in `live_workflows` (32 of 53 definitions are), so a literal
   reading would hide from `!help` exactly the workflows operators use most. `!help`
   therefore renders every workflow bound to the channel, marked with its true
   execution state — live / shadowed / read-only — and the live-marked set equals
   `live_workflows` exactly, which is the criterion actually being tested.

## D-024 — F-062 disposition: `!help` presentation, not a policy narrowing — RECORDED 2026-08-17

**Owner (2026-08-17, end of the F-058 session, after the finding was raised and
both options were put to them):**

- **OPTION A — change the display.** `!help` groups its workflow list under two
  headings: the ones a person can ask for in that channel, and the ones that run
  automatically (webhook- and schedule-driven) and are listed only because the
  channel holds the capability. Wording to make the distinction explicit rather
  than implied.
- **Runtime channel capability lists are NOT narrowed.** The alternative —
  removing `crm.write` / `crm.read` from the social channel's policy entry so the
  channel genuinely cannot run those workflows — is **rejected for this batch**,
  not rejected in principle. Rationale accepted: the demonstrated problem is
  operator confusion, not reachable risk (P3), and Option A resolves the
  confusion completely; a policy narrowing edits the highest-consequence file in
  the system, requires the owner-run install plus fingerprint re-record, and
  answers a least-privilege question nobody has raised. If it is ever wanted, it
  belongs in its own session with a before/after check of what actually depends
  on those capabilities — never bundled into a hygiene batch.
- **Scope note:** the fix is presentation-only. No policy change, no capability
  change, no change to what any channel is authorized to run. `!help` continues
  to report the true live/shadow/read-only/quarantined state of every workflow it
  lists; only the grouping and its explanatory line change.
- **Closure:** F-062 closes when the grouped `!help` output is verified at the
  deployed SHA against live policy — the same both-directions live-set assertion
  used for F-058 (QCF058-03) must still hold, since the fix must not change which
  workflows are reported or their states.

## D-025 — Remaining P3 hygiene batch: authorization + F-034(a)/F-034(b)/F-021 dispositions — RECORDED 2026-08-17

**Owner (2026-08-17, start-of-session, P3 hygiene batch session; asked because the
session's Authorizations line was blank — D-020/D-021/D-022 precedent):**

- **BUSINESS + OUTAGE AUTHORIZED — scoped to the 10-finding P3 batch** (F-024,
  F-026, F-027, F-028, F-030, F-034, F-037, F-038, F-021, F-062). Full release
  path agent-run (fix branch → tests → PR create → CI verify → merge →
  fast-forward of production main → `release:deploy` incl. crm/worker restarts)
  **plus** the post-deploy gateway kickstart (`!help` lives in the gateway
  plugin — F-058 precedent) **plus** runtime-host hygiene (chmod/rm/renames and
  the `accounting/config.json` FX-key alignment via the QCFS4-05
  escrow-then-atomic pattern). Merges/ff owner-run via `!` commands if the
  permission classifier blocks. Live-state preflight + stated rollback/abort
  criteria still precede the deploy (plan §5).
- **F-024 runtime policy edit split:** executor prepares and validates the
  candidate (remove `email.message.observe` from `autonomous_workflows`), the
  **owner installs it** (runtime `workflow/policy.json` writes stay owner-run —
  D-019 arming-procedure/D-020 precedent), executor re-records the policy
  fingerprint afterward.
- **F-034(a) pre-scrub git bundle — CHMOD 600, KEEP IN PLACE.** Reversible
  minimum: the only pre-scrub archive survives; deletion stays available to the
  owner any time.
- **F-021 legacy `workspace-resort` tree — ARCHIVE THEN DELETE, AGENT-RUN.**
  tar.gz to `~/.openclaw/backups/` (mode 600), archive verified, then the tree
  is removed. (SECRETS.md/TOOLS.md there were already proven free of real
  credential values — E-QC2B-06.)
- **F-034(b) offsite Drive duplicates + missing retention policy — ACCEPT AND
  RECORD.** No remote change now; accepted residual with a revisit note
  (1.06 GB / 17 days is harmless for years). The local retention fix (code)
  rides the batch PR regardless.
- **D-004 still not answered** (the authorization question was answered on its
  own). The explicit OUTAGE grant supplies this session's window; D-004 remains
  open for a standing answer (load-bearing at QC-6c and QC-10).

**Addendum — F-024 corrected fix RATIFIED (owner, same session, after the RO
trace):** the recorded removal of `email.message.observe` from
`autonomous_workflows` is factually wrong at current code — the worker
authorizes a system-origin observe run for every pending inbound email
(`crm/scripts/workflow-worker.js:147-160`, `authorizeSystemRun` →
`authorize({origin:'system'})`, allowed only via that policy entry), so removal
would halt Gmail/Resend reply classification and direct-inquiry projection.
The finding's "latent grant, no effect today" premise predated the D-023
shadow-mode correction; two sanctioned configure scripts
(`configure-email-replies.js`, `configure-sarah-email.js`) deliberately install
the entry. **Owner chose the corrected fix:** no runtime policy edit (the
owner-run install step in this decision's first bullet is VOID — the policy is
already correct); repo-side only: (1) the observe definition declares
`autonomous: true` (registry agrees with policy and worker reality); (2) a
policy↔registry agreement invariant lands — every `autonomous_workflows` entry
must exist in the registry AND be registry-accounted (declare `autonomous: true`,
or accept the `auto_confirm_dispatch` trigger, the declaration the D-019 arming
procedure relies on), and every `autonomous_operations` key must be reachable
(present in `autonomous_workflows`) and dispatch-capable. **As built** (executor
wiring decision, same session): enforced at every system-origin authorization
site (server `/api/workflows/execute`, worker `authorizeSystemRun`, auto-confirm
dispatch), refused at `scripts/policy-fingerprint.js record`, reported with
exit 1 by `policy-fingerprint check` (surfaced by `release:check`), and
reported at worker boot — report-only there, because a boot refusal would take
every other workflow down with the one bad grant; deliberately NOT requiring
live-ness
(autonomous-but-shadow is a sanctioned staging shape the example policy itself
models); (3) `workflow/policy.example.json`'s current half-armed shape (dead
`autonomous_operations` entry without the `autonomous_workflows` membership it
needs) is fixed to the D-019 un-armed default — completing the D-019 item-2
example residual that the P2/P3 batch did not reach.

## D-026 — F-051(iii) disposition + QC-8b live-canary authorization — RECORDED 2026-08-18

**Owner (2026-08-18, start-of-session, QC-8b; asked because F-051(iii) was an
explicitly flagged owner decision and the session's Authorizations line was
blank):**

1. **F-051(iii) gateway event-coalescing — OPERATOR GUIDANCE.** Accepted as a
   documented operational constraint rather than pursuing an upstream OpenClaw
   gateway change. The quiet-moment rule (type exact commands top-level,
   unmentioned, in a quiet moment; if the bot does not acknowledge within ~30s
   the command did NOT execute — check state before retyping any mutation
   command) becomes durable operator documentation on the command surfaces
   (COMMANDS.md prose + docs/commands pages) via a small docs fix-list item
   (doc-only; batches per Amendment 3). F-051(iii) dispositions as
   accepted-risk-with-guidance; the standing STATUS.md advisory converts to
   the durable doc text. An upstream gateway fix remains available to a future
   owner decision but nothing in QC blocks on it.
2. **Owner-phone `!wa` live canary — AUTHORIZED (CANARY-class, this session,
   this vehicle only).** Owner texts the resort WhatsApp number from their
   personal phone (D-009 allowlisted test identity — genuine passive inbound,
   zero guest exposure), then in a quiet moment types the `!wa` reply the
   executor prepares. Purpose: the one LIVE mutation-class exact-command
   ledger corroboration F-051 still needs, doubling as QC-8's live WhatsApp
   positive leg. Terms: executor verifies addressing semantics RO and hands
   the owner exact steps before anything is typed; the raw phone number never
   enters Git (aliased per §4.1/D-009; raw only in `~/qc-evidence/`);
   test-created contact/lead rows are flagged and reconciled per the session
   cleanup plan; the send's recipient is the owner's own device.
3. **F-052 live leg — cannot run this session** (verified RO at session start:
   zero open manual reviews exist; all 6 historical reviews resolved). It
   waits for the next genuine review; STATUS.md carries the verification
   procedure. Recorded here so the deferral is an owner-seen fact, not an
   executor omission.

**Addendum — canary outcome, same session (2026-08-18):** the authorized
canary's command leg COULD NOT COMPLETE and that failure is the session's
finding: both owner-typed `!wa` attempts fell through to the channel agent
with zero runs — root cause F-063 (in the deployed gateway, `inbound_claim`
never dispatches for ordinary channel conversations; only surfaces with a
`reply_dispatch` twin work, and `!wa` has none). Fail-closed held: nothing
sent, zero effects, residue = the two marked inbound rows attached to the
pre-existing test-identity lead. Consequences the owner should note:
(a) item 1's quiet-moment guidance stands for the surfaces that work, but it
CANNOT restore the twinless commands — until the F-063 fix deploys,
`!wa`, `!meta confirm`, `!ownerrez confirm`, `!receipt confirm`,
`!review resolve`, and `!help` do not execute at all (they reach Sol, who
refuses/cannot run them; `!email …` and the read surfaces still work);
guest-bound WhatsApp sends are therefore currently impossible (inbound
keeps flowing normally). (b) The F-051 live-corroboration leg this canary
was authorized to close is BLOCKED on the F-063 fix; the D-026 canary
design is reusable as that fix session's live verification, and this
authorization is recorded as consumed-by-discovery (a fresh session-level
authorization accompanies the fix session per D-008). (c) F-063 is P1 →
dedicated fix session through the full release path per D-008.

## D-027 — F-063 fix session authorization + live battery — RECORDED 2026-08-18

**Owner (2026-08-18, on the session's Authorizations line — session 25, F-063
fix session):**

- **BUSINESS + OUTAGE AUTHORIZED — scoped to the F-063 fix session.** Full
  release path agent-run (fix branch → tests → PR create → CI verify → merge →
  fast-forward of production main → `release:deploy` incl. crm/worker restarts)
  **plus** the post-deploy gateway kickstart (the seven twins live in the
  gateway plugin — F-058/P3-batch precedent) **plus** the live battery per the
  D-026 canary design (owner-typed `!help` and the owner-phone `!wa` rerun
  against the existing test-identity inbound rows). Merges/ff owner-run via
  `!` if the permission classifier blocks (D-020/D-021 precedent).
- **Executed in-session:** PR #91 (`fix/f063-reply-dispatch-twins`, 9ba2eb4)
  merged by the owner via `! gh pr merge 91 --merge` after the classifier
  blocked the agent merge; production main fast-forwarded b7f2690 → ba47469
  by the owner via `! git -C ~/.openclaw/SocialSol merge --ff-only origin/main`
  (classifier blocked the agent ff; ancestry + incoming-files proofs recorded
  first). Scope note: the fix is repo-code + docs only — no policy change, no
  capability change, no arming; Meta DM deliberately received no twin (F-020
  quarantine preserved).
- **Deploy-window fact surfaced to the owner:** a genuine `paulina.daily`
  manual review 70c0a77a… (SQLITE_BUSY at 15:02:13Z, F-054 contention class,
  pre-existing — not caused by this session) was OPEN at deploy preflight and
  blocks the paulina.daily cadence until resolved. It is the "next genuine
  review" F-052's live leg was waiting for; the owner-typed
  `!review resolve` after this deploy doubles as F-052's live Slack-path
  verification.

**Addendum — session executed same day (2026-08-18): live battery COMPLETE,
all three P1-path legs PASSED (QCF063-02).**

- Deployed ba47469; deploy record steps 1–10 completed, step 11
  `workflow_health` red solely on the pre-existing review (post-resolution
  rerun exit 0 all-zeros); gateway kickstarted (PID 43276→15064). Owner then
  typed, in order: `!help` (claimed; zero preceding agent bootstrap),
  `!wa 62 [QC] F-063 twin verified — canary 2026-08-18` (durable run
  8103063a, `slack_whatsapp_command`, actor-bound; Twilio effect verified
  accepted→sent→delivered→READ on the owner's own device 15:30:42Z), and
  `!review resolve 70c0a77a… not-sent` (resolved 15:37:53Z from
  prospector-paulina; paulina.daily cadence resumed 15:42:14).
  **Consequences: F-063 verified-fixed; F-051 CLOSED; F-052 CLOSED; zero
  open P0/P1 findings as of this session.**
- **Executor instruction error, recorded honestly:** the executor told the
  owner the resolve command would work "in any controlled channel — #whatsapp
  is fine." The owner pasted it in BOTH #whatsapp and #prospector-paulina:
  #whatsapp answered `Review not changed (workflow_http_403)` (the twin
  CLAIMED it; the server's D-017 permitted-channel gate — review channel +
  write_notifications only — correctly refused; zero state change),
  #prospector-paulina resolved it. The owner did nothing wrong; the double
  paste was harmless (one resolution, execute-once held) and the 403 became
  an unplanned fail-closed negative probe of the authorization boundary.
  Standing-rule lesson recorded in STATUS.md: claim surface ≠ authorization
  surface.
- **F-064 opened (P3, monitor-only):** the SQLITE_BUSY review itself — first
  non-deploy-window occurrence of the F-054 contention class (1 failure vs
  181 clean paulina.daily runs that day; fail-safe worked as designed).
