# QC status

Updated: 2026-08-15 (PDT) — session 3 (QC-1a generated inventory).

## QC-0 — COMPLETE

Exit criteria: **met.**

- No uncontained P0: harm sweep (QC0-08…QC0-14) found zero stalled runs, zero dead outbox rows, zero overdue effects, zero unresolved manual reviews, no unknown spend-affecting Meta mutations in the durable plane, zero due-outreach backlog, zero failing financial writers.
- D-001/D-002: owner answers of 2026-08-15 recorded in `DECISIONS.md` (remaining open sub-rows listed there; they gate QC-7/QC-6, not QC-0).
- Baseline recorded: production = `~/.openclaw/SocialSol`, clean `main`; QC-0 baseline SHA `d1a119e579dc4f072dffb6483e701ec01cb1c8f6`; CI `verify` success @ that SHA (2026-08-14T23:43Z); deployment record completed @ that SHA (23:44Z, all steps green).
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
| T7 | Exact `!dm` handler + retired HTTP sender exist | CONFIRMED → F-020 opened P1 | E-QC1-T7a–e |

**Consequence applied (≥6 confirmed):** proceed on v2's factual frame, evidence-first everywhere. v1/docs claims remain hypotheses.

## F-020 quarantine fix — COMPLETE (session 2, 2026-08-15). Status: verified-fixed

Owner authorized BUSINESS (release-path deploy) + OUTAGE (gateway reload) scoped to F-020; D-008 confirmed as proposed (both in DECISIONS.md). Executed:

- PR #69 `fix/f020-quarantine-meta-dm` @ ac06896: `meta.dm.reply` removed from `workflow/policy.example.json`; machine-enforced quarantine guard (`QUARANTINED_LIVE_WORKFLOWS`) in `validate:openclaw-shadow` + `apply:openclaw-shadow`; regression tests (guard, example policy, `!dm` shadow refusal). Local check:stack exit 0; CI `verify` pass; merged @ `2983ed0` (owner-run merge — the harness blocks `gh pr merge` for the agent; owner runs it via `!`); production ff'd; release:check + release:deploy completed 9/9 @ 2983ed0.
- Runtime: `workflow/policy.json` de-armed (95138587…c04e9 → 32c2bdfe…8b761f, mode 600); guard proven by attempted violation on the still-armed patch (validate exit 1); quarantined patch validated + applied (openclaw.json backup taken); gateway kickstarted (PID 27738 → 89734, start 14:42:13 > config mtime 14:41:55).
- Verification: owner typed `!dm 1 qc quarantine check` in the social channel → exact reply "Not sent. Meta DM replies are still in shadow mode." Zero side effects (handler short-circuits before the control plane).
- Rows QCF20-01…05; evidence E-F020-01…07 (`~/qc-evidence/F020-FIX/`). Production `main` now @ `2983ed0` — the current deployed baseline SHA for subsequent phases.

## QC-1a generated inventory — COMPLETE (session 3, 2026-08-15). Artifact: `qc/INVENTORY.md`

All RO (the only writes: raw evidence into `~/qc-evidence/QC1-INV/` and the sanctioned fresh plist render into that same dir; render script code-traced first — writes confined to `--output`). Every table script-generated; no handwritten lists. Rows QC1-INV-01…08; evidence E-QC1INV-01…19.

- 53 registry workflows dumped via `listDefinitions()` at worktree==deployed 2983ed0 (empty code diff proven); policy: 32 live, 17 autonomous, shadow_mode=true, sha == post-quarantine `32c2bdfe…`; live ⊆ registry; `meta.dm.reply` still absent (F-020 holds).
- Launchd 5 layers: 50 templates → 50 fresh-rendered → 51 deploy-generated → 49+2`.disabled` installed → 43+gateway loaded → processes started after the 2026-08-15T21:39Z deploy record @ 2983ed0. Six legacy producers dormant exactly per CUTOVER map (not failures); graph replacements all loaded.
- F-016 inputs made concrete: `kapital-tests` + `qbo-keepalive` installed with **no template**; `paloma-followup/scan/summary` templated + deploy-rendered but **not installed**.
- Data stores: live crm.db + paloma tasks.db; **stray 0-byte `crm/data/resort-crm.db` created deploy day** → QC-3; snapshot with stale WAL/SHM siblings → QC-3; chroma 3 collections; encrypted backups fresh, offsite = gog drive.
- Secrets: 26 files, all 600 except `anthropic_vocabgen.json` 644 (+ stray healthchecks .bak) → QC-2. Gateway: SocialSol agents bind Slack-only; enabled telegram channel belongs to another venture's agent (no SocialSol refs) — QC-2 boundary input, no new transport finding.
- Drift notes parked for QC-1b: `email.message.observe` (policy-autonomous, not live, registry non-autonomous); `marketing.report.daily` mutates under `marketing.read` (QC-6).

## Blockers

None. Recorded 2026-08-15: F-020 quarantine decision + fix-session authorization, D-003 (Max 20x), D-005 (July 2026), D-008 (confirmed as proposed), D-011 (non-expiring — ratified). Still open: D-004, D-006, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row.

## Next

**QC-1b: convergence diff + versioned service manifest + priority-evidence validation** (plan §QC-1, second split): (1) formalize the 4-way producer diff from saved evidence (fresh render E-QC1INV-08 vs deploy-generated vs installed E-QC1INV-09 vs loaded E-QC1INV-10) and name every delta incl. the warmup-daily active+disabled twin and NODE_BIN caveat; (2) build the versioned service manifest (label, owner, expected state, schedule, TZ, args, env contract, criticality, alert owner, replacement/retirement) — expected producers from policy + CUTOVER map; (3) validate priority evidence: F-015 (nonzero exits + watchdog blindness → remediation ownership), F-016 (kapital-tests/qbo-keepalive without template; paloma trio not installed — intended?), F-023 convergence proof. All RO. Expected outcome per plan: a P1 service-manifest/release-convergence finding unless a valid alternative owner+control exists.

**Exact next command** (start ritual, per §8, real repo root):

```
git -C /Users/jasonmini/.openclaw/SocialSol status
```

then `cd ~/qc-worktree`, read `qc/STATUS.md`, read plan §QC-1, and execute QC-1b from the saved QC1-INV evidence (re-capture launchctl/process state fresh; deployed baseline remains `2983ed0` unless a newer deploy record says otherwise).
