# QC status

Updated: 2026-08-15 (PDT) — session 9 (QC-3b main). **QC-3b substantially COMPLETE: D-006 recorded; recovery matrix + monitoring matrix committed (qc/RECOVERY_MATRIX.md); offsite retrieval PROVEN (F-018 retrieval half closed); new F-031 P1 (key escrow absent), F-032 P1 (non-CRM stores uncovered), F-033 P2 (monitoring drift), F-034 P3 (hygiene); F-025 materially corrected. REMAINING: the timed decrypt/restore drill, gated by D-006's weekday 10:00–16:00 PT window → Mon 2026-08-17.**

Authorizations session 9: blank — RO + FIXTURE only, plus D-006's standing grants (offsite retrieval RO anytime — exercised; restores scratch-only). Session ran Saturday evening = outside the drill window, so the conservative D-006 reading (recorded in DECISIONS.md) deferred the timed decrypt/restore to Monday. All writes: worktree qc/**, ~/qc-evidence/QC3B/ (700/600), scratchpad (benchmark, cleaned). Live stores touched RO only; no backup artifact decrypted; gog used for folder list + 2 downloads into evidence (D-006 authority). Branch remains ahead of origin (unpushed QC commits) — push happens with the QC-3 phase-boundary PR.

## QC-0 — COMPLETE · QC-1 — COMPLETE (runtime baseline 2983ed0; PR #70) · QC-2 — COMPLETE (PR #71 → 87a4e6c docs-only; runtime 2983ed0) · QC-3a — COMPLETE (session 8; F-006/F-029 P2, F-030 P3)

## QC-3b — session 9 (2026-08-15). Rows QC3B-01…10; evidence E-QC3B-01…15

- **D-006 recorded** (drill windows weekdays 10:00–16:00 PT; offsite retrieval RO anytime; restores scratch-only; per-store RPO/RTO targets) + conservative window interpretation noted for owner correction.
- **CRM backup chain PROVEN end-to-end minus timed decrypt** (QC3B-02/03/06/07): online-backup API `mode=ro` → quick_check → AES-256-CBC(PBKDF2 200k, key file) → Drive upload → prune-30; dailies unbroken 07-30→08-15 (17/17) + deploy `--force` extras; **offsite: 87 artifacts/1.06 GB full history; newest byte-identical to local by sha256; locally-pruned Aug-14 daily retrieved from its only (offsite) home**. Local depth compressed to ~2 days by deploy-burst eviction (keep-30 FILES) — offsite full history compensates (F-034c).
- **Restore drill audited** (QC3B-04): weekly Tue 05:30 + at every deploy; decrypt+verify battery on latest LOCAL artifact in a temp dir; 26h staleness gate; last success at the 14:39 deploy in 261ms — **validated as genuine by FIXTURE benchmark** (gunzip 144MB 0.078s, quick_check 0.048s — QC3B-10); never exercises the offsite copy (F-033f).
- **F-031 (P1, new):** backup passphrase (65B, sole copy, workspace/secrets) has zero escrow/off-host copy discoverable → host loss = all 87 offsite artifacts undecryptable; secrets store overall has no backup vs D-006 zero-loss. **Owner question pending: does an off-host copy already exist?**
- **F-032 (P1, new):** paloma tasks.db (no control), policy+openclaw (ad-hoc baks only, no offsite/rebuild doc), accounting inbox/config (provider-compensated), warmup (accepted-loss option per D-006), media originals 143G (PIPELINE.md mandates offline backup; nothing implements/verifies; owner attestation question).
- **F-033 (P2, new):** job_health→Healthchecks ping no-op for all 13 slugs (checks map has none); watchdog = sole alert path for backup/drill and is itself unmonitored; 3 Healthchecks DOWN 16–88d un-actioned (retired producers: gtku-daily, orchestrator-autopause, regina-batch-run); no disk-capacity monitor at 84% full; manifest alert column corrections both directions (graph-* actually covered by workflow-health metrics).
- **F-034 (P3, new):** pre-scrub git bundle 644 in backups/; Drive duplicate names + no remote retention policy; count-based local retention; /tmp kapital CSV + builder logs; unrotated /tmp chroma.log; .DS_Store.
- **F-025 corrected:** release step `install_dependencies` EXISTS with `PYTHON=/usr/bin/python3` baked in; every deploy regenerates node_modules (5.03s at 2983ed0; better-sqlite3 via shipped prebuilds — no gyp); bare `npm ci` still fails (runbook line in RECOVERY_MATRIX §3). F-018 dispositioned (→F-006/F-032/proven-retrieval); F-013 updated (blocked by F-031 + Monday drill).
- Chroma rebuild path verified as documented (source table inside crm.db → CRM backups carry it). Migration-009 runbook note carried into RECOVERY_MATRIX §3.

## Blockers

None for Monday's drill except the clock (D-006 window). Open D-rows: D-004, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row; **D-006 recorded** — owner may correct the conservative window interpretation and answer the two attestation questions (F-031 passphrase escrow; F-032 media offline copies; warmup accepted-loss disposition). Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (QC-4), F-015 + F-016 (fix session per D-008), **F-031 (key escrow), F-032 (non-CRM coverage)**. Open P2s: F-023, F-025 (corrected/rescoped), F-006, F-029, **F-033**. Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, **F-034**.

## Next

**QC-3b-drill — timed off-host-format restore drill, Mon 2026-08-17 within 10:00–16:00 PT (D-006).** Everything else in QC-3b is done; this closes QC-3.

**Exact next command** (start ritual, §8, real repo root):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ 87a4e6c. Then `cd ~/qc-worktree`, read `qc/STATUS.md` + `qc/RECOVERY_MATRIX.md` §4, confirm Monday 10:00–16:00 PT, and run the drill:

1. Preflight (RO, live-state — not calendar-only): `mode=ro` checks — pending/queued workflow_outbox rows due now = 0; no queued runs; no due outreach in next ~15 min (graph-paulina dispatches every 300s when due); no `runtime/production-release.lock`; window confirmed (quiet hours excluded by construction).
2. Drill (FIXTURE, scratch-only, per D-006): on the two already-retrieved offsite artifacts in `~/qc-evidence/QC3B/offsite/` — time decrypt (openssl AES-256-CBC PBKDF2 200k, pass file) → gunzip → quick_check → QC3A oracle probes for BOTH `crm-2026-08-15T213917Z` (lineage-comparable) and `crm-2026-08-14` daily (offsite-only artifact); record end-to-end off-host RTO (retrieval was seconds on 2026-08-15) vs ≤4h target; expect migration-009-style guards N/A (no migrations run — restore+verify only).
3. Record QC3B-11 (+ QC3B-12 if RTO row split); mark F-018 fully closed, update F-013; FINDINGS/RISK_HYPOTHESES/STATUS updates.
4. **QC-3 phase boundary** (Amendment 3): docs-only qc/** PR — pre-flight (qc-only diff, `npm run check:secrets` exit 0, §4.1 sweep), push branch, PR create; **owner runs `gh pr merge` via `!`**; docs-only ff of production main; runtime SHA stays 2983ed0.

All RO/FIXTURE; restores scratch-only per D-006. If the owner answers the F-031/F-032 attestation questions before Monday, fold the answers into DECISIONS.md/FINDINGS first.
