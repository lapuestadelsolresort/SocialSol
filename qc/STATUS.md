# QC status

Updated: 2026-08-16 (PDT) — session 13. **QC-6 (Paid Meta, CAPI, landing/tracking, social publishing) COMPLETE in one session per D-003 — INCLUDING the phase boundary (PR #75 merged, prod main ff'd fbe3b03 → 03fe3fe docs-only, runtime baseline 2983ed0 unchanged; QC6-11, E-QC6-04; D-014 authorization).** Rows QC6-01…10; evidence E-QC6-01…03; FIXTURE 129/129 at the SHA. **P0 spend tripwire on the reachable ad account: CLEAN** — 4/4 ACTIVE campaigns registry-known, budgets exact ($40/day ≤ cap 80), 7d spend fully attributed. Gated mutation catalog + bounded autonomy verified static+FIXTURE (production-unfired, named: 0 marketing_change_requests ever). F-001 re-verified absent at 2983ed0 with compensating geometry mapped (QC6-04). Live alert path PROVEN: today's transient marketing.report.daily failure (Meta timeout 07:30 PDT) → workflow-health red + edge-triggered Slack alert at 07:33; self-recovery expected at tomorrow's 07:30 run. Funnel/CAPI verified on genuine events + FIXTURE (1 sent delivery, eligibility strict, pre-cutover variances named); tracker cold-start failures proven Meta delivery skew (F-019 validated P3); social publishing double-post-safe (production-unfired, honest no-ops).

**F-044 external paid Meta stream: escalated and RESOLVED in-session (D-014).** ~85–197 sessions/day since Aug-7 on the main site (`facebook/cpc/sf_full_resort_march_2026`, numeric ad-id content, 1,174 IPs, zero engagement) from an account the system token cannot see — **owner recognized it same session: "Yes, I run it"** → downgraded P1→P2 (governance blind spot: registry/cap/daily report/autonomy/liveness blind to it; CAPI already excludes it). Open residual: owner later decides register (alias + coverage) vs accepted-risk in writing.

Authorizations session 13: blank line at start (RO+FIXTURE only) → held. All Meta access = proven side-effect-free GETs (static Bearer token, no refresh surface in the client module, graph_post never called, no registry/DB writers imported). Live DB reads mode=ro; workflow_health run only with --check-only (traced RO). Zero production writes; QC writes to worktree qc/**, ~/qc-evidence/QC6/ (700/600), scratchpad. Deferred as out-of-class: browser-load funnel leg (writes synthetic sessions → CANARY, needs D-009), any marketing workflow/CLI execution (registry/DB writers), manual report re-run (posts to Slack).

## Phase ledger — QC-0…QC-6 COMPLETE including boundaries (runtime baseline 2983ed0; prod main 03fe3fe = PR #75 merge)

## ⚠️ Standing advisory (until F-039 fixed)

**Do not re-post pre-August (June/July) Kapital statement CSVs to the accounting Slack channel.** The live pipeline stages and processes automatically and would create ~60 duplicate standalone fee Purchases (~9.50 USD for July; June similar). August-onward statements are fine (new format, full dedup).

## ⚠️ Standing advisory (until F-041 fixed)

**A reboot/login of the Mac mini resurrects all six retired legacy producers** (squarespace-sync, ownerrez-sync, orchestrator, gtku, prospector-daily, **regina-anniversary outreach**) alongside their graph replacements — the on-disk plists keep live schedules and are not disabled. If an unplanned reboot occurs before the F-016/F-041 fix session: immediately `launchctl bootout` the six labels (or verify loaded set == SERVICE_MANIFEST expected set) before trusting producer exclusivity. (No reboot as of session 13: boot Aug-7 predates cutover.)

## Blockers

1. ~~F-044 owner disposition~~ **RESOLVED in-session (D-014): owner recognizes and runs the campaign → P2.** Residual register-vs-accept decision open (non-blocking).
2. ~~QC-6 boundary~~ **DONE in-session (D-014, QC6-11, E-QC6-04): PR #75 merged, prod main ff'd fbe3b03 → 03fe3fe docs-only.** The qc branch is 1 commit ahead of origin (this boundary-record commit) and rides the QC-7 phase-boundary PR, same pattern as prior phases.
3. ~~QC-7 gate~~ **CLEARED in-session (session 13 continuation): D-001 FULLY RECORDED with owner sign-off 2026-08-16** — Meta activation autonomous (invariant-first arming), per-campaign budget increase autonomous under the ratified $80/day owner-only aggregate cap, pause/decrease ratified as built, QBO/OwnerRez/Postiz(sanctioned surface)/Regina-Airbnb-thread(grant-only)/Sarah-replies(both providers) full autopilot, WhatsApp `!wa` unchanged. F-035(c) dispositioned: retire auto-organic-ig-post cron. **New fix-list items (arming, per D-008 release path): Meta autonomous activation (AFTER F-001 invariant + F-045 briefs), OwnerRez mutation autopilot, Sarah auto-send both providers, auto-organic-ig-post retirement, #qc-scratch channel + policy entries (D-009).** **D-009 RECORDED 2026-08-16** (same continuation): #qc-scratch channel; test email jason@lapuestadelsolresort.com; test phone = owner's personal WhatsApp (supplied at CANARY time, aliased in committed text); **browser-load funnel leg named home = dedicated QC-6c CANARY session** (after QC-7; unblocks QC-7's planted-contact CANARY too). Still open D-rows: D-004, D-007 (validator), D-010 (confirm).

Open P1s: F-001 (fix session; invariant-first per D-001), F-005 (QC-7 reconciliation — gate satisfied), F-014, F-015, F-016, F-041, F-031, F-032. Open P2s: F-013, F-023, F-025, F-006, F-029, F-033, F-035, F-036, F-039, F-040, **F-045 (new)**, **F-044 (downgraded from P1 per D-014 — owner-recognized external campaign; register-vs-accept residual)**. Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038, F-042, F-043, **F-019 (promoted), F-046 (new)**. Hypotheses resolved this session: F-002, F-003 (clean), F-007 (largely; residual inside F-019), F-010 (partially; remainder rides F-044).

## Next

**QC-7 (Paulina + Regina outreach)** — gate satisfied (D-001 fully recorded + signed off 2026-08-16). Begin QC-7a directly (Paulina: the send gate QC-1 T5 found in code, provenance/suppression, do-not-contact, caps/ramp, scheduling boundaries, replay protection, digest honesty, bounce/unsubscribe auto-pause on FIXTURE), then QC-7b (Regina: runtime flag vs D-001 intent, eligibility SQL invariants, suppression/provenance/language gates, `!sent`/`!skip`/`!defer`, anniversary idempotency, Resend readback; verify NO send path exists for WhatsApp and Airbnb-thread contacts per D-001 grant-only decision). QC-7 also runs the F-005 reconciliation: runtime/docs/policy vs the complete D-001 matrix, every discrepancy dispositioned (expected mismatches already known: OwnerRez + Sarah + Meta-activation confirm-gates stricter than granted autonomy = intent-recorded/arming-pending, not violations).

**Then QC-6c (dedicated CANARY session, D-009 recorded):** the browser-load funnel leg — controlled loads per destination incl. the two zero-delivery ad variants (F-019) proving page JS → session/UTM → CTA → wa_ref, then the test-phone WhatsApp leg proving signed inbound → lead/attribution → CAPI eligibility; requires session-level CANARY approval + written cleanup/reconciliation plan (§5) and a suitable window; synthetic-session marking per the testlv- model.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ 03fe3fe (docs-only merge commit of PR #75; runtime baseline 2983ed0, newest deploy record 2026-08-15T21:39Z unchanged). Then `cd ~/qc-worktree`, read qc/STATUS.md + qc/DECISIONS.md D-001 (now complete) + plan §9 QC-7, and begin QC-7a. F-041 advisory applies if any reboot occurred. Free recovery-signal check: marketing.report.daily + workflow-health should have self-recovered at the first successful 07:30 report run — verify memory/workflow-health-alert-state.json shows active=false.
