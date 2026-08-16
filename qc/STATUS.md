# QC status

Updated: 2026-08-16 (PDT) — session 11. **QC-4 (accounting) COMPLETE — QC-4a AND QC-4b in one session per D-003.** Rows QC4A-01…06 + QC4B-01…03; evidence E-QC4A-01…06 + E-QC4B-01…03; D-013 recorded (QBO RO reads authorized; owner-expense reconcile intended LIVE; kapital-tests stays scheduled). **July 2026 reconciliation (D-005): 52/52 statement rows accounted against QBO — 46 matched, 2 transfer-amount mismatches (−83.37 USD, F-040), 2 never-recorded debits (~542.61 USD, F-040), 2 intentional sub-cent skips; reverse direction clean (0 unexplained integration-owned QBO rows).** **QC-4 BOUNDARY COMPLETE same session: PR #73 merged (agent-run per D-013 addendum; push owner-run after classifier block) → production main ff'd 1211b80 → 40d30fb8, docs-only, runtime baseline stays 2983ed0 (QC4B-04, E-QC4B-04). Next phase: QC-5 (Squarespace commerce, business reads, owner cash flow).**

Authorizations session 11: blank line at start (RO+FIXTURE) → owner recorded D-013 in-session: QBO read-only API queries authorized for QC-4b+ with incidental sanctioned locked token refresh (observed working: atomic 600 rewrite, .refresh.lock created, no token output). All writes: worktree qc/**, ~/qc-evidence/QC4/ (700/600), scratchpad (harnesses + scratch fx-cache; production fx_cache untouched). Zero QBO entity writes (no --live anywhere; production dry-run additionally proved fail-closed preflight aborts with "no writes attempted"). Live DB reads mode=ro only.

## Phase ledger — QC-0…QC-4 COMPLETE including boundaries (runtime baseline 2983ed0; prod main 40d30fb8 = PR #73 merge)

## QC-4 session-11 summary

- **QC-4a**: discovery (15 receipt channels from runtime config sha 93adf49e…, 11 registry workflows — 10 live + owner-expense reconcile shadow→D-013 says arm it; job surfaces incl. F-016a kapital-tests/qbo-keepalive); receipt-pipeline static verification vs full plan checklist (immutable payment source, deterministic LPDSR, Spanish/no-bank-details, duplicate-payable guards at DB/code/QBO levels, owner-expense confidence hold + atomic confirm + repayment-never-auto + account-type preflight, parser fail-closed balances + cp1252 + SPEI triplets, FX Banxico fail-closed + executed-rate rule, held-exception taxonomy, deterministic requestids + readback); live state (inbox empty; durable ledger AUG-only — July is legacy-era; **production replay-prevention proof: byte-identical CSV uploaded twice → exactly one run set, zero duplicate QBO effects**); FIXTURE 65/65 py + 38/38 js tests at the SHA; offline parse of 4 real statements — **cross-month balance chain exact June→July→August**; F-014 static audit (all claims confirmed + sharpened: unpaginated dup scan capped at 100, hard-anchored non-atomic unlocked token rewrite, hard-coded salary matrix) + **F-036** QBO OAuth 4-writer matrix (1 locked).
- **QC-4b**: OAuth live observation (sanctioned path verified in production); July reconciliation as above with named exceptions → **F-040** (books deltas, bounded ~626 USD total, owner/accountant disposition) ; SPEI fee format proof (fees EMBEDDED in legacy parents — line probe Purchase 2365; money present) → **F-039** (P2: live re-upload of a legacy statement would double-count ~60 fee lines because fee auto-push ignores principal dedup and only knows the new format).

## ⚠️ Standing advisory (until F-039 fixed)

**Do not re-post pre-August (June/July) Kapital statement CSVs to the accounting Slack channel.** The live pipeline stages and processes automatically and would create ~60 duplicate standalone fee Purchases (~9.50 USD for July; June similar). August-onward statements are fine (new format, full dedup).

## Blockers

None mechanical for QC-5 start (QC-4 boundary done; qc branch is 1 commit ahead of origin — this boundary-record commit — and rides with the QC-5 phase-boundary PR, same pattern as e78a183/3f1fe4c). Open D-rows: D-004, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows (**publishing row urgent — F-035**), D-002 owner-cash-flow row. Fix-list additions this session: arm receipt.owner_expense.reconcile via release path (D-013), F-039 fee-format guard, F-040 books corrections (owner/accountant), F-036 OAuth writer consolidation (rides the F-014/F-016 accounting fix session), F-037/F-038 P3 batch. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), **F-014 (validated at SHA; remains open per QC-4 exit clause — rebuild spec = sharpened closure criteria in FINDINGS; fix session per D-008)**, F-015 + F-016 (fix session), F-031 (escrow halves), F-032. Open P2s: F-013 (gated on F-031), F-023, F-025 (rescoped), F-006, F-029, F-033, F-035, **F-036, F-039, F-040 (new)**. Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, **F-037, F-038 (new)**.

## Next

**QC-5 — Squarespace commerce, business reads, owner cash flow** (plan §9; contingent rows of D-002 mostly recorded — Squarespace authorized full-capability; owner cash-flow command row still open, ask when hit). Note for QC-5: the owner cash-flow command's writable DB open is a known side-effect mismatch — never use `--apply-reconciliation` (plan).

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ 40d30fb8 (docs-only merge commit of PR #73); runtime baseline 2983ed0 (newest deploy record 2026-08-15T21:39Z). Then `cd ~/qc-worktree`, read qc/STATUS.md + plan §9 QC-5, and begin QC-5 with the RO discovery pass: squarespace/ module + crm/lib/squarespace-commerce.js + squarespace schema builders + graph-squarespace-sync/squarespace-sync/squarespace-report job surfaces + commerce read models — label every check's action class before running (§1). D-002 note: Squarespace authorized full-capability; owner cash-flow command row still OPEN — ask when hit; never use --apply-reconciliation (plan §9 QC-5).
