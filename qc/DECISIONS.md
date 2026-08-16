# Owner decisions

Seeded from QC Plan v3 §11. D-001 and D-002 block QC-0 exit; D-011 blocks part of QC-7a. Answers recorded here are the authority; runtime/docs/policy are reconciled *to* this file.

## D-001 — Autonomy matrix — PARTIALLY RECORDED (blocks QC-7; informs QC-6/8)

**Recorded 2026-08-15 (owner):**

- **WhatsApp guest sends — human command required.** A human types `!wa` in Slack; no guest-bound WhatsApp message sends without that human-typed command, covering all guest-bound WhatsApp outbound including any Regina reactivation of WhatsApp-provenance contacts. This is the invariant QC-8 attempts to violate.
- **Paulina cold email — full autopilot; auto-send authorized.**
- **Regina reactivation email — full autopilot; auto-send authorized.**
- All suppression, verification, provenance, cap, and fail-closed gates bind unchanged under autopilot. Autonomy is not gatelessness.
- **Meta DMs — owner does not recognize this feature; intended state is disabled/nonexistent** (see D-002 and QC-1 T7).

**Still open (ask when hit; QC-7 gate requires all rows recorded):**

- Regina Airbnb-thread contacts (default manual as built unless the owner states otherwise)
- Sarah guest-correspondence replies — keep proposal + same-user-confirmation flow, or auto-send too?
- Meta campaign activation & budget increase
- Autonomous Meta pause/decrease
- QBO writes
- OwnerRez mutations
- Postiz publishing

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

## D-009 — Test identities and markers — OPEN

`[QC TEST]` prefix in production channels vs a `#qc-scratch` channel; allowlisted test email addresses and phone numbers for CANARY actions.

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
