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

**Still open:** owner cash-flow command (read-model surface).

## D-003 — Max plan tier and usable session length — RECORDED 2026-08-15

**Owner:** Max 20x; long sessions OK (2+ hours fine). Phases may run as single large sessions; the a/b splits remain available as fallbacks, and the ~70%-budget guardrail (§8) still applies.

## D-004 — Blackout windows — OPEN

Live campaigns, warmup ramps, guest quiet hours; days/times when CANARY/OUTAGE/BUSINESS actions are forbidden.

## D-005 — Reconciliation month for QC-4 — RECORDED 2026-08-15

**Owner:** July 2026 (most recent fully closed month).

## D-006 — Restore-drill and offsite-retrieval approval — OPEN

Windows and targets (RPO/RTO per store).

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
