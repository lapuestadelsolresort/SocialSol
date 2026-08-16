# QC status

Updated: 2026-08-16 (PDT) — session 12. **QC-5 (Squarespace commerce, business reads, owner cash flow) COMPLETE in one session per D-003 — INCLUDING the phase boundary (PR #74 merged, prod main ff'd 40d30fb8 → fbe3b03 docs-only, runtime baseline 2983ed0 unchanged; QC5-07, E-QC5-04).** Rows QC5-01…06; evidence E-QC5-01…03; D-002 owner cash-flow row recorded in-session (**authorized as built** — D-002 now FULLY recorded, no open rows). Sync/report/read-model statics PASS vs full plan checklist; live state healthy (1669/1669 sync runs ok, 300s cadence, 7s-fresh at read, watermarks per design, notification outbox empty-ever = named production-unfired path); **representative-order reconciliation provider→tables→reports: 50/50 fields MATCH (refunded + paid orders) and the /summary net formula equals Σ provider netAmount to the cent (279,539.42)**; consent separation proven repo-wide; FIXTURE 15/15 at the SHA; owner cash flow executed RO (readonly DB + GET-only OwnerRez, 714 bookings) — all identities exact, independent SQL reproduces totals, stdout contract 4/4, exceptions explicit, `--apply-reconciliation` never used. **New: F-041 (P1) CUTOVER retirement not reboot-durable — six legacy producers (incl. regina-anniversary outreach cron) resurrect at next login alongside their graph replacements; no reboot since cutover has ever tested dormancy.** F-042/F-043 P3 (read-only-claim writable open; report outbox failure path unrecorded). QC-5 exit criteria met: source boundaries hold, representative figures reconcile, no read path silently mutates production or overclaims authority (writable-open mismatch accounted → F-042, RO handle proven sufficient).

Authorizations session 12: blank line at start (RO+FIXTURE only) → held. All provider access = proven side-effect-free GETs (Squarespace static-key client — no token-refresh surface; OwnerRez client hard-coded GET). Zero production writes; live DB reads mode=ro or readonly:true handles; all QC writes to worktree qc/**, ~/qc-evidence/QC5/ (700/600), scratchpad harnesses. D-002 row answered in-session (decision, not an action authorization).

## Phase ledger — QC-0…QC-5 COMPLETE including boundaries (runtime baseline 2983ed0; prod main fbe3b03 = PR #74 merge)

## ⚠️ Standing advisory (until F-039 fixed)

**Do not re-post pre-August (June/July) Kapital statement CSVs to the accounting Slack channel.** The live pipeline stages and processes automatically and would create ~60 duplicate standalone fee Purchases (~9.50 USD for July; June similar). August-onward statements are fine (new format, full dedup).

## ⚠️ Standing advisory (until F-041 fixed)

**A reboot/login of the Mac mini resurrects all six retired legacy producers** (squarespace-sync, ownerrez-sync, orchestrator, gtku, prospector-daily, **regina-anniversary outreach**) alongside their graph replacements — the on-disk plists keep live schedules and are not disabled. If an unplanned reboot occurs before the F-016/F-041 fix session: immediately `launchctl bootout` the six labels (or verify loaded set == SERVICE_MANIFEST expected set) before trusting producer exclusivity.

## Blockers

None mechanical for QC-6 start (QC-5 boundary done: PR #74 merged, prod main ff'd 40d30fb8 → fbe3b03 docs-only, runtime baseline 2983ed0 unchanged — QC5-07, E-QC5-04; qc branch is 1 commit ahead of origin — this boundary-record commit — and rides with the QC-6 phase-boundary PR, same pattern as prior phases). Open D-rows: D-004, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows (**publishing row urgent — F-035**). D-002: fully recorded. Fix-list additions this session: F-041 durable retirement of the six legacy plists + post-reboot convergence check (rides the F-016 fix session), F-042/F-043 P3 batch. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (fix session per D-008), F-015 + F-016 (fix session), **F-041 (new — rides F-016 session)**, F-031 (escrow halves), F-032. Open P2s: F-013 (gated on F-031), F-023, F-025 (rescoped), F-006, F-029, F-033, F-035, F-036, F-039, F-040. Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038, **F-042, F-043 (new)**.

## Next

**QC-6 — Paid Meta, CAPI, landing/tracking, social publishing** (plan §9; carries Amendment 2: F-001 open P1; aliases for provider/account/campaign IDs in all committed artifacts; unknown active spend = P0).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ fbe3b03 (docs-only merge commit of PR #74); runtime baseline 2983ed0 (newest deploy record 2026-08-15T21:39Z). Then `cd ~/qc-worktree`, read qc/STATUS.md + plan §9 QC-6, and begin QC-6a with the RO discovery pass: committed briefs ↔ runtime campaign registry ↔ durable marketing evidence/effects ↔ live Meta state (aliases only; stubbed-adapter negatives only; never touch a live campaign). Note: F-041 standing advisory applies if any reboot occurred.
