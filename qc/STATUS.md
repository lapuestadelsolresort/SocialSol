# QC status

Updated: 2026-08-15 (PDT) — session 4 (QC-1b). **QC-1 phase COMPLETE.**

Authorizations this session (owner, 2026-08-15, recorded verbatim in scope): session began blank (RO/FIXTURE only); mid-session the owner authorized (1) `gh pr create` for ONE docs-only PR `qc/baseline-20260815` → `main` covering the QC-0 + QC-1 qc/ commits — the combined PR is the approved remediation for the missed QC-0 boundary merge; from QC-2 on, one PR per phase boundary — and (2) after the owner merges it themselves, a docs-only fast-forward of the production checkout (no release:check/deploy per Amendment 3). Pre-flight required before PR create: commit artifacts; prove branch diff vs main touches only `qc/**` (stop and ask otherwise) with diff stat saved as evidence; run the repo secret scanner + §4.1 hygiene over the full PR diff.

## QC-0 — COMPLETE (see session-1 record; exit criteria met; baseline then d1a119e)

## QC-1a — COMPLETE: tripwire 7/7 CONFIRMED; F-020 quarantine verified-fixed (owner-authorized fix session); generated inventory at deployed 2983ed0 (`qc/INVENTORY.md`)

Deployed baseline SHA since the F-020 fix: **`2983ed00646611a6a2b59d294af71ce49e08ad3a`** (deploy record 2026-08-15T21:39Z, 9/9 steps).

## QC-1b — COMPLETE (session 4, 2026-08-15). Artifact: `qc/SERVICE_MANIFEST.md`

All RO (writes only to `~/qc-evidence/QC1B/` and qc/ on this branch). Rows QC1B-01…08; evidence E-QC1B-01…14. Fresh state re-captured; baseline unchanged at 2983ed0; production clean.

- **4-way convergence diff formalized, every delta named** (QC1B-02/03): 50(+1 disabled) templates → 50 rendered → 51 generated → 49+2disabled installed → 43+gateway loaded. 6 installed-not-loaded == CUTOVER dormant map exactly (no duplicate live producer). 39/47 installed==rendered; **8 differ** — crm + squarespace-report installed AHEAD of template (reinstall would regress: WhatsApp-channel env / Slack enable+channels); 6 template-ahead never installed (incl. two F-015 jobs); NODE_BIN Cellar-path fragility; media pair definitions symlinked from the dirty outer repo.
- **Versioned service manifest committed** (`qc/SERVICE_MANIFEST.md`, QC1B-07): 55 script-generated rows — schedule/TZ, script, env contract, expected vs actual, convergence, alert owner, QC owner, proposed criticality (owner ratifies at D-007 sign-off).
- **F-016 VALIDATED P1** (QC1B-06, moved to FINDINGS): launchd layer has no convergent release path — deploy renders but installs nothing; sanctioned installer covers 3/49 labels; kapital-tests (F-014 control) + qbo-keepalive (QBO credential mutation) hand-installed with no template, /tmp logs, no alerts; paloma trio rendered-never-installed. **D-012 recorded: owner says INSTALL the paloma trio** (fix session adopts; QC-9 tests).
- **F-015 mechanisms characterized** (QC1B-05): daily-tests = missing WorkingDirectory in stale installed plist (relative require dies; no channel env → alerts nowhere); tracker-liveness = working as designed, exit 1 on 3 REAL cold-start failures (paid destinations 18–51 days active, zero CRM sessions 48h) → **QC-6/F-019 priority input**; media-rescan = MEDIA_SHOOT_SLUG unset in template AND installed → permanently failing. Remediation ownership assigned in FINDINGS.
- **F-023 launchd convergence proof met** (QC1B-04): 43/43 loaded resort jobs execute nested-repo scripts; gateway = OpenClaw runtime + nested-repo plugins; co-tenants enumerated. Remaining for F-023 closure: owner disposition of workspace-resort tree + docs correction.
- **F-024 opened P3** (QC1B-08): `email.message.observe` policy-autonomous but not live; registry non-autonomous. Latent grant; fix = remove via config path + QC-2 policy invariant `autonomous ⊆ live`.

## Blockers

None. Open D-rows: D-004, D-006, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (QC-4), F-015 + F-016 (dedicated fix session per D-008, after phase-boundary merge).

## Next

**Immediate (this session, owner-authorized):** phase-boundary PR pre-flight → `gh pr create` (docs-only, QC-0+QC-1, remediation note for the missed QC-0 merge) → owner merges via `! gh pr merge <N>` → then docs-only ff of production checkout, confirm clean main, and record here that the deployed runtime SHA remains 2983ed0 (code diff vs 2983ed0 empty outside qc/).

**Then: QC-2a — control plane, authorization, negative fixtures, durable boundary** (plan §QC-2 first split): stack check + `npm audit --omit=dev` + `git diff --check` + full test inventory in the worktree; registered-graph-only execution; trusted Slack identity binding; channel/restricted-user capabilities; negative FIXTURE tests (wrong user/channel, spoofed identity, prose, edited/replayed command, duplicate Slack event, reused idempotency key with changed input, unsupported method/URL/tool); durable-boundary verification (hashes, provider idempotency, worker-only execution, lease fencing, retry classes, serialized guest sends, outbox/dead-letter, manual review atomicity). Inputs from QC-1: F-024 policy invariant; secrets mode 644 file + stray .bak (QC-2 mode audit); shared-gateway identity isolation. All RO/FIXTURE unless a new authorization line says otherwise.

**Exact next command** (start ritual, §8, real repo root):

```
git -C ~/.openclaw/SocialSol status
```

then `cd ~/qc-worktree`, read `qc/STATUS.md`, read plan §QC-2, and execute QC-2a. Deployed baseline remains `2983ed0` unless a newer deployment record says otherwise.
