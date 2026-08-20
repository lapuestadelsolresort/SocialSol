# QC-6c CANARY session plan — browser-funnel leg (F-019 closure)

Authored: 2026-08-20 (session 28, RO prep — D-004 answered the same session).
Mechanics verified read-only at production HEAD `e04c2a8` (serving code
byte-identical to runtime baseline `ba47469`; policy sha `0dd75080…`
unchanged). Raw prep evidence: `~/qc-evidence/QC6C/prep-ro-20260820.md`
(E-QC6C-00). File:line cites below are at that SHA.

## 1. Purpose and scope

Close F-019's last leg: **prove the DEPLOYED page JS executes in a real
browser** — QC6-08 verified only static fetch (`px.js?v=8` on planners+dining,
`sq-tracker.js?v=7` on the main site); no synthetic session has ever exercised
the page-side path. Per D-009 (owner, 2026-08-16) this is a dedicated CANARY
session: controlled browser loads per destination — including the two F-019
zero-delivery ad variants (main-site `retarget_video`; villas
`corporate_retreats_video/king-suite`) — proving deployed page JS →
session/UTM capture → CTA click → `wa_ref` linkage; then the test-phone
WhatsApp leg proving signed inbound → durable workflow → lead/attribution →
CAPI eligibility; with a written cleanup/reconciliation plan and
synthetic-session marking (`testlv-` convention as the model). Also the first
structured use of the D-009 identity machinery that QC-7's planted-contact
test reuses.

Explicitly NOT in scope: any guest-bound send (`!wa` invariant untouched — no
outbound WhatsApp at all), any Meta mutation, any CAPI emission (see §6), any
`--apply`/write flag on report tooling.

## 2. Gating — all four required before anything non-RO runs

1. **Authorizations line: CANARY** granted for this plan by name.
2. **D-004 window** (recorded 2026-08-20): weekday, 10:00–16:00 PT.
3. **Live-state preflight** (RO, at session start): no active outbound send
   batch in flight (paulina/regina dispatch windows quiet), no queued
   deploy/lock, no open manual review blocking the WhatsApp inbound path,
   worker + webhook healthy (last runs green), not guest quiet hours.
4. **Owner present** for the WhatsApp leg (their D-009 personal phone; raw
   number never committed — evidence only).

Abort at any gate failure. The D-028 precedent applies: if the leg does not
run in the authorized session, the grant is consumed, not carried forward.

## 3. Verified funnel contract (what the canary must light up)

- `crm/public/lp/px.js` (planners/dining/villas LPs): adopts a pre-existing
  `sessionStorage['lpds_sid']` as the session id (mints one only if absent,
  px.js:26-31); exposes `window.LPDS_SID` / `window.LPDS_WA_REF`; wa_ref =
  sid stripped to alnum, uppercased, first 16 (px.js:33). Boot pageview
  always fires with UTMs from the query string (px.js:85-109). CTA wiring
  appends `Reference: LPDS-<REF>` to wa.me hrefs (px.js:36-47,111-115);
  capture-phase `wa_click` flushes via sendBeacon BEFORE the wa.me tab opens
  (px.js:117-127). Clicking the CTA sends no message — it only opens wa.me.
- `crm/public/lp/sq-tracker.js` (main site): same sid key/adoption, same
  wa_ref derivation and href rewrite, `page: 'main-site'`.
- `crm/routes/track.js`: sid must match `^[0-9a-z-]{8,64}$/i`; the server
  independently re-derives the wa_ref from the sid and stores a supplied ref
  only on exact match (track.js:74-78) — so a stored `whatsapp_ref` proves
  the derivation ran end-to-end. `wa_click` → `cta_clicked=1`; `cta_view` →
  `reached_cta=1`. Real Chrome UA → `is_bot=0` (HeadlessChrome would be
  flagged; we use the real browser).
- `crm/workflows/whatsapp-inbound.js` (`whatsapp.inbound.process` v2,
  autonomous): matches `\bLPDS-([A-Z0-9]{12,24})\b` anywhere in the inbound
  text → session by `whatsapp_ref` → `attribution_method='ref'`,
  `page_sessions.converted=1`, `lead_id` set (129-131). Lead INSERT only if
  no row for that phone exists (111-119) — the pre-existing test-identity
  lead is reused, `lead_created=0`, and `attribution_events` is NOT written
  (132-146: new-lead only). Effects + evidence rows at every step;
  `mark_processed` readback-asserted.
- CAPI (`send_conversion` step): fires only when `leadCreated &&
  isMetaAttributed(...)` (whatsapp-inbound.js:155-166,185-214); otherwise the
  run output records `{skipped: true, reason: 'not_new_meta_attributed_lead'}`.

## 4. Synthetic-session marking (the testlv- model, QC variant)

- **Sid**: `qc6c-<uuid4>` (prefix + uuid = 41 chars; passes SID_RE; no
  underscores). One fresh sid per destination, minted before load and
  recorded in the evidence log at mint time.
- **Derived marks for free**: wa_ref becomes `QC6C…` (visible in the CTA
  href, the WhatsApp message body, and `page_sessions.whatsapp_ref`).
- **Message marker**: the owner's WhatsApp text starts `[QC canary]` and
  carries the `Reference: LPDS-QC6C…` line (the regex matches anywhere in
  the text).
- **Exclusion/cleanup**: exactly the tracker-liveness mechanism —
  `DELETE FROM page_events WHERE session_id LIKE 'qc6c-%'` then
  `DELETE FROM page_sessions WHERE id LIKE 'qc6c-%'` (§8). Until cleanup,
  QC rows are identifiable by prefix; every minted sid is also individually
  logged so nothing depends on the prefix alone.

## 5. Browser leg — per destination

**Destination set** (derived at session start, RO): the same
registry-derived list `tracker-liveness` builds (`load_registry()` +
`fetch_live_snapshot()` → ACTIVE campaigns → dedupe by destination URL,
tracker-liveness-test.py:392-412), **force-including the two F-019
zero-delivery variants** (main-site `retarget_video`; villas
`corporate_retreats_video/king-suite`) whether or not their ads are still
ACTIVE that day. Raw URL/campaign map goes to `~/qc-evidence/QC6C/` only;
committed text keeps aliases (planners / dining / villas / main-site +
variant names already committed in F-019).

Per destination, in a **fresh tab**:

1. **Seed** (avoids one unmarked stray session per load): navigate the tab to
   `https://<destination-host>/robots.txt` (text document — no tracker, no
   Squarespace header injection; fallback `sitemap.xml`). Assert
   `window.LPDS_SID === undefined` (proves no tracker ran), then
   `sessionStorage.clear(); sessionStorage.setItem('lpds_sid','qc6c-<uuid4>')`.
   sessionStorage is origin+tab-scoped, so the landing page adopts the seed.
2. **Load** the destination URL with QC UTMs:
   `utm_source=qc-canary&utm_medium=qc&utm_campaign=<destination's real
   utm_campaign>&utm_content=<destination's real utm_content>`. Source and
   medium are deliberately outside the CAPI-eligible sets (two ineligible
   axes); campaign/content keep the real per-destination values so the
   by-path/ad/content reconciliation stays faithful (plan §QC-6).
3. **Assert page JS executed** (the F-019 gap): read `window.LPDS_SID`
   (must equal the seeded qc6c- sid — proves the DEPLOYED page loaded and
   ran the tracker, not merely served it) and `window.LPDS_WA_REF` (must
   equal the local derivation). Screenshot.
4. **Interact**: scroll past 25%; dwell ≥12s (one heartbeat).
5. **CTA**: confirm the wa.me anchor's href now carries
   `Reference: LPDS-QC6C…` (capture the exact final href as evidence);
   click it; the wa_click beacon flushes before navigation; close the
   opened wa.me tab without further interaction (nothing is sent).
6. **RO DB verify** (read-only handle `file:...?mode=ro`):
   `page_sessions[qc6c-sid]` has the QC UTMs, `whatsapp_ref` = expected
   derivation, `reached_cta=1`, `cta_clicked=1`, `is_bot=0`, correct
   page_slug/device; `page_events` contains pageview + cta_view + wa_click
   (+ scroll/heartbeat unless the in-app-DNT edge applies — record what
   fired). Verdict per destination: PASS only on all of §5.3 + §5.6.

A destination whose page fails §5.3 (JS never boots) is a FAIL **finding**
(that is exactly what this canary exists to catch) — record it, continue the
remaining destinations, do not improvise fixes in-session.

## 6. WhatsApp leg — once, from the designated destination

Designated vehicle: the primary planners/dining LP session (richest page,
`a.wa-cta` path). One inbound message total.

1. Hand the owner the exact text: `[QC canary] <two or three words>` +
   blank line + the captured `Reference: LPDS-QC6C…` line from §5.5.
2. Owner sends it from their D-009 personal WhatsApp to the resort number
   (inbound only; genuine passive event class — this is the same vehicle as
   the D-026/D-027 canaries; it will surface in #whatsapp via normal
   forwarding BY DESIGN, D-009 nuance).
3. **Passive verification** (RO, allow a few minutes): signed Twilio webhook
   accepted → `meta_messages` inbound row → worker run
   `whatsapp.inbound.process` completed with: `attribution_method='ref'`,
   `crm_lead_id` = the pre-existing test-identity lead, `lead_created=0`,
   `page_sessions.converted=1` + `lead_id` set on the qc6c session,
   `conversion: {skipped: true, reason: 'not_new_meta_attributed_lead'}`,
   effects `verified_by_readback`, `processing_status='completed'`.
4. **No reply is sent from any surface.** The `!wa` invariant is not touched.

**CAPI-negative invariant (hard):** zero new `conversion_deliveries` rows and
zero `meta-capi` effects during the session window. Protection is two
independent layers — `lead_created=0` (pre-existing lead) AND
`isMetaAttributed=false` (qc-canary source/medium) — each individually
sufficient; both are asserted in evidence. The positive CAPI case stays
FIXTURE-proven (QC6-05/QC6-07); the live canary must never emit provider
conversion events for synthetic traffic.

## 7. Evidence capture (→ `~/qc-evidence/QC6C/`, mode 600; SHA-256 into
EVIDENCE_INDEX)

Per destination: minted sid + timestamp; seed-page assert; screenshot;
`LPDS_SID`/`LPDS_WA_REF` reads; final CTA href; RO row dumps
(page_sessions + page_events). WhatsApp leg: meta_messages row id, workflow
run id + step states, effect/evidence ids, page_sessions converted readback,
conversion-skip readback. Plus: before/after reconciliation counts (§8),
destination map with aliases, and the exact commands for every claim.

## 8. Cleanup and reconciliation plan (part of the CANARY authorization)

Before the browser leg, snapshot (RO): total `page_sessions` /
`page_events` counts, `conversion_deliveries` count, `attribution_events`
count, the test-identity `leads` row (full row), `meta_messages` count for
the test phone.

Cleanup (single production write, the testlv- precedented mechanism, run
only after all evidence is captured):

```
DELETE FROM page_events   WHERE session_id LIKE 'qc6c-%';
DELETE FROM page_sessions WHERE id         LIKE 'qc6c-%';
```

Reconciliation asserts, all RO:
- Deleted counts == minted-session ledger (every logged sid accounted; zero
  strays — if any seed failed and a random-sid session leaked, it is
  identified by the per-destination timestamps + exact sid recorded at
  browse time, deleted by exact id, and noted honestly).
- `page_sessions LIKE 'qc6c-%'` → 0 rows after.
- `conversion_deliveries` count unchanged; `attribution_events` count
  unchanged; test-identity `leads` row byte-identical to the pre-canary
  snapshot (the workflow never updates an existing lead).
- Kept by design (enumerated residue, D-027 precedent): the `[QC canary]`
  `meta_messages` inbound row attached to the test-identity lead, and all
  durable workflow runs/effects/evidence rows — they ARE the audit trail.

## 9. Abort / stop-the-line

- Any beacon 4xx/5xx or track-endpoint anomaly → stop the browser leg,
  investigate RO, no further loads.
- Owner message shows no `meta_messages` row within 15 minutes → stop;
  investigate webhook/worker RO before ANY resend (never send twice without
  reconciling first).
- Any unexpected write — a new `leads` row, any `conversion_deliveries` row,
  any `meta-capi` effect, any outbound message artifact — **P0 posture**:
  stop everything, leave state in place, owner + incident row, plan §6 rules.
- Preflight regression mid-session (send batch starts, review opens on the
  inbound path) → pause at the current checklist boundary until clear.

## 10. Pass criteria and bookkeeping

- **QC6C-01** (browser leg): every destination PASS per §5 — or FAILs
  recorded as findings with the plan's honesty rule.
- **QC6C-02** (WhatsApp linkage): §6.3 chain complete with
  `attribution_method='ref'` and conversion mark on the marked session.
- **QC6C-03** (CAPI-negative + cleanup): §6 invariant + §8 asserts all hold.
- F-019 residual (P3, browser page-JS leg) closes on QC6C-01 PASS covering
  both zero-delivery variants; update FINDINGS + F-015 cross-reference.
- Soak note for QC-10: this contributes the webhook/message-path
  genuine-event evidence row for the funnel transition set.
- End ritual per §8 of the plan: matrix/index/status rows, commit
  `qc(QC-6c): <verdicts>`.

## 11. Session budget

Single session, 60–90 min active: ~10 min gates/preflight + snapshot,
~30-40 min browser leg (≈5 min/destination), ~10 min WhatsApp leg +
verification, ~10 min cleanup + reconciliation, remainder for bookkeeping.
Split point if needed: after §5 (browser leg) — §6-§8 become QC-6c-b (the
cleanup DELETE may not straddle sessions; if §6 cannot run, clean up §5's
rows the same session and re-mint for the follow-up).
