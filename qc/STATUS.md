# QC status

Updated: 2026-08-15 (PDT) — session 1.

## QC-0 — COMPLETE

Exit criteria: **met.**

- No uncontained P0: harm sweep (QC0-08…QC0-14) found zero stalled runs, zero dead outbox rows, zero overdue effects, zero unresolved manual reviews, no unknown spend-affecting Meta mutations in the durable plane, zero due-outreach backlog, zero failing financial writers.
- D-001/D-002: owner answers of 2026-08-15 recorded in `DECISIONS.md` (remaining open sub-rows listed there; they gate QC-7/QC-6, not QC-0).
- Baseline recorded: production = `~/.openclaw/SocialSol`, clean `main` @ `d1a119e579dc4f072dffb6483e701ec01cb1c8f6` == origin/main; CI `verify` success @ that SHA (2026-08-14T23:43Z); deployment record completed @ that SHA (23:44Z, all steps green); crm+worker processes started by that deploy from that checkout; policy fingerprint `95138587…c04e9`.
- qc/ skeleton committed on `qc/baseline-20260815`.
- New finding: F-023 (P2) — nested dirty outer repo `~/.openclaw` (which is the OpenClaw agent home); see FINDINGS.md.

## QC-1a tripwire — COMPLETE. Scorecard: 7/7 CONFIRMED

| # | Claim under test | Verdict | Key evidence |
|---|---|---|---|
| T1 | `crm/workflows/registry.js`, ~53 definitions | CONFIRMED (exactly 53) | E-QC1-T1 |
| T2 | Migrations through 020 + runtime schema builders | CONFIRMED | E-QC1-T2 |
| T3 | `DB_PATH` vs `CRM_DB_PATH` split | CONFIRMED (single inode in practice) | E-QC1-T3 |
| T4 | daily-tests / tracker-liveness / media-rescan exit 1; watchdog blind | CONFIRMED → F-015 validated P1 | E-QC1-T4 |
| T5 | `email_status='verified'` gate; `realness_score` absent | CONFIRMED | E-QC1-T5 |
| T6 | check:stack / CI `verify` / release:check / release:deploy / policy.json / CUTOVER.md | CONFIRMED | E-QC0-15, E-QC0-04 |
| T7 | Exact `!dm` handler + retired HTTP sender exist | CONFIRMED → **F-020 opened, P1** | E-QC1-T7a–e |

**Consequence applied (≥6 confirmed):** proceed on v2's factual frame, evidence-first everywhere. v1/docs claims remain hypotheses.

**T7 consequence:** F-020 open — the Meta DM path is live-armed (policy + loaded gateway) though never executed; owner decision required before QC proceeds past this point (quarantine via config/release path vs authorize + QC-8 testing). Decision being sought 2026-08-15; record lands in DECISIONS.md.

## Blockers

- F-020 owner decision (quarantine vs authorize). No behavioral testing of the DM path until recorded.

## Next

QC-1a remainder: the generated inventory (registry/schedule) — plan §QC-1 "Then the generated inventory". QC-1b after: convergence diff + service manifest + priority-evidence validation (F-015 remediation ownership lands there; F-023 convergence proof too).

**Exact next command** (start ritual, per §8, corrected for real repo root):

```
git -C /Users/jasonmini/.openclaw/SocialSol status
```

then read `/Users/jasonmini/qc-worktree/qc/STATUS.md`, read plan §QC-1, and begin the generated inventory (registry dump via a FIXTURE-safe `listDefinitions()` call or static parse; launchagent template → render → installed → loaded diff).
