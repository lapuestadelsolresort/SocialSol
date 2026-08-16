# QC status

Updated: 2026-08-16 (PDT) — session 13. **QC-6 (Paid Meta, CAPI, landing/tracking, social publishing) verification COMPLETE in one session per D-003 — phase boundary NOT yet run** (waiting on owner: F-044 disposition + boundary authorization). Rows QC6-01…10; evidence E-QC6-01…03; FIXTURE 129/129 at the SHA. **P0 spend tripwire on the reachable ad account: CLEAN** — 4/4 ACTIVE campaigns registry-known, budgets exact ($40/day ≤ cap 80), 7d spend fully attributed. Gated mutation catalog + bounded autonomy verified static+FIXTURE (production-unfired, named: 0 marketing_change_requests ever). F-001 re-verified absent at 2983ed0 with compensating geometry mapped (QC6-04). Live alert path PROVEN: today's transient marketing.report.daily failure (Meta timeout 07:30 PDT) → workflow-health red + edge-triggered Slack alert at 07:33; self-recovery expected at tomorrow's 07:30 run. Funnel/CAPI verified on genuine events + FIXTURE (1 sent delivery, eligibility strict, pre-cutover variances named); tracker cold-start failures proven Meta delivery skew (F-019 validated P3); social publishing double-post-safe (production-unfired, honest no-ops).

**NEW P1 ESCALATION — F-044: unknown external paid Meta stream.** ~85–197 sessions/day since Aug-7 landing on the main site with `facebook/cpc/sf_full_resort_march_2026` + numeric ad-id content, 1,174 distinct IPs, zero engagement — attributable to NO campaign in the ad account the system can see (ad-id GET → permission error). Registry/caps/daily report/autonomy all blind to it; CAPI contained. Est. $600–2,400/30d. **Owner: check Meta Business Manager (legacy F-010 account and Page boosts first). Unrecognized → treat as unauthorized spend (P0), disable at source. Recognized → downgrade to P2 + decide register-or-accept.** No containment possible from this system.

Authorizations session 13: blank line at start (RO+FIXTURE only) → held. All Meta access = proven side-effect-free GETs (static Bearer token, no refresh surface in the client module, graph_post never called, no registry/DB writers imported). Live DB reads mode=ro; workflow_health run only with --check-only (traced RO). Zero production writes; QC writes to worktree qc/**, ~/qc-evidence/QC6/ (700/600), scratchpad. Deferred as out-of-class: browser-load funnel leg (writes synthetic sessions → CANARY, needs D-009), any marketing workflow/CLI execution (registry/DB writers), manual report re-run (posts to Slack).

## Phase ledger — QC-0…QC-5 COMPLETE incl. boundaries; QC-6 verification COMPLETE, boundary pending (runtime baseline 2983ed0; prod main fbe3b03)

## ⚠️ Standing advisory (until F-039 fixed)

**Do not re-post pre-August (June/July) Kapital statement CSVs to the accounting Slack channel.** The live pipeline stages and processes automatically and would create ~60 duplicate standalone fee Purchases (~9.50 USD for July; June similar). August-onward statements are fine (new format, full dedup).

## ⚠️ Standing advisory (until F-041 fixed)

**A reboot/login of the Mac mini resurrects all six retired legacy producers** (squarespace-sync, ownerrez-sync, orchestrator, gtku, prospector-daily, **regina-anniversary outreach**) alongside their graph replacements — the on-disk plists keep live schedules and are not disabled. If an unplanned reboot occurs before the F-016/F-041 fix session: immediately `launchctl bootout` the six labels (or verify loaded set == SERVICE_MANIFEST expected set) before trusting producer exclusivity. (No reboot as of session 13: boot Aug-7 predates cutover.)

## Blockers

1. **F-044 owner disposition (URGENT — potential P0):** identify the external paid stream's source account in Meta Business Manager; record the answer in DECISIONS/FINDINGS (unrecognized → incident; recognized → P2 + register-or-accept decision).
2. QC-6 phase-boundary PR needs explicit owner authorization (BUSINESS; blank-auth sessions cannot run it). qc branch is now 2 commits ahead of origin (QC-5 boundary record + this session) — both ride the QC-6 boundary PR per established pattern.
3. QC-7 gate: remaining D-001 rows must be recorded before QC-7 starts (F-005): Regina Airbnb-thread contacts · Sarah guest-correspondence replies · Meta campaign activation & budget increase (QC-6 input: designated-approver receipt exists only on the CLI path — who may activate, and must the graph path require the receipt?) · autonomous Meta pause/decrease ratification · QBO writes · OwnerRez mutations · Postiz publishing (**F-035 urgent row still open**). Also open: D-004, D-007 (validator), D-009 (needed for the deferred browser-load funnel leg + future CANARYs), D-010 (confirm).

Open P1s: F-001 (fix session), F-005 (QC-7 gate), F-014, F-015, F-016, F-041, F-031, F-032, **F-044 (escalated)**. Open P2s: F-013, F-023, F-025, F-006, F-029, F-033, F-035, F-036, F-039, F-040, **F-045 (new)**. Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038, F-042, F-043, **F-019 (promoted), F-046 (new)**. Hypotheses resolved this session: F-002, F-003 (clean), F-007 (largely; residual inside F-019), F-010 (partially; remainder rides F-044).

## Next

**1. Owner answers F-044** (see escalation above) — record in DECISIONS.md + update the F-044 row.
**2. QC-6 phase-boundary PR** (docs-only batch-merge per Amendment 3) once owner authorizes agent-run end-to-end (QC5-07/QC4B-04 pattern: pre-flight §4.1 sweep + check:secrets, push [owner-run if classifier blocks], PR, CI verify, merge, ancestry + incoming-files proofs, docs-only ff of production main, post-ff runtime-baseline verification).
**3. Then QC-7 (Paulina + Regina outreach)** — blocked until the remaining D-001 rows above are recorded (plan §9 gate).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ fbe3b03 (runtime baseline 2983ed0, newest deploy record 2026-08-15T21:39Z). Then `cd ~/qc-worktree`, read qc/STATUS.md; if the owner has answered F-044, record it; run the boundary per the pattern above if authorized; QC-7a only after D-001 completes. F-041 advisory applies if any reboot occurred. Note: marketing.report.daily + workflow-health should have self-recovered at the first successful 07:30 report run — verify the incident alert-state cleared (memory/workflow-health-alert-state.json active=false) as a free recovery-signal check.
