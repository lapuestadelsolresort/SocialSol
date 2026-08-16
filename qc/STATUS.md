# QC status

Updated: 2026-08-15 (PDT) — session 8 (QC-3a). **QC-3a COMPLETE: single live DB proven (identity+path contract), schema parity by generated oracle, snapshot integrity/semantics clean, migration idempotency proven on a disposable restore. New: F-006 validated P2 (path contract), F-029 P2 (schema provenance), F-030 P3 (stray file).**

Authorizations session 8: blank — RO + FIXTURE only. All writes confined to `~/qc-worktree` + `~/qc-evidence/QC3A/` + scratchpad; live DBs touched only via `mode=ro` handles and the SQLite online-backup API (§4.4); migrations exercised only on a disposable copy of the snapshot; F-023 outer dirt untouched. Branch is ahead of origin (unpushed QC commits) — push happens with the QC-3 phase-boundary PR, not before.

## QC-0 — COMPLETE (session 1; baseline then d1a119e)

## QC-1 — COMPLETE (sessions 2–4: tripwire 7/7; F-020 verified-fixed; inventory + convergence diff + service manifest at 2983ed0; PR #70 merged; runtime baseline 2983ed0)

## QC-2 — COMPLETE (sessions 5–7: QC-2a rows QC2A-01…11; QC-2b rows QC2B-01…14; webhook surfaces dispositioned to QC-8/QC-7/QC-10; PR #71 merged → 87a4e6c docs-only; **deployed runtime baseline remains 2983ed0**)

## QC-3a — COMPLETE (session 8, 2026-08-15). Rows QC3A-01…08; evidence E-QC3A-01…08

Preconditions held: production clean `main` @ 87a4e6c; worktree code byte-identical to merged main outside qc/+.claude (== runtime 2983ed0 per QC2B-14); QC3A evidence dir 700.

- **DB identity** (QC3A-01): one live CRM DB `crm/data/crm.db` (144 MB, 600, WAL) at inode 17786952; lsof holders = exactly {server 89370, worker 89376}; nothing else opens any prod DB; graph jobs are DB-free (loopback HTTP trigger); all consumers file-anchored.
- **Path contract** (QC3A-02 → **F-006 validated P2**): convergence today proven at all three layers (plists / spawn env / `.env` key-name audit — no `DB_PATH`, no `CRM_DB_PATH`, no path keys). Contract itself asymmetric and unguarded: JS honors `DB_PATH` incl. a dotenv `.env` channel (lib/runtime-paths.js); python backup honors `CRM_DB_PATH` and never reads `.env`; ownerrez-message-ingest.js:30 + lp_phase_gate.py:32 ignore overrides; no backup==runtime assertion.
- **Stray** (QC3A-03 → **F-030 P3**): `crm/data/resort-crm.db` 0-byte, never in tracked code at any ref, zero references anywhere incl. shell history, never opened; created==modified 2026-08-14 14:31:38 (deploy-burst); `sqlite3` open-then-quit signature; inert; delete in fix session.
- **Schema parity** (QC3A-04/05 → **F-029 validated P2**): tables 68/68 exact both directions vs generated oracle; indexes 124/124 + 1 out-of-band (`idx_contacts_ownerrez_guest_id`); idempotency UNIQUEs + partial serialization index live-verified. Column sweep (1103 live columns vs full DDL corpus incl. addColumnIfMissing sites): **12 out-of-band columns** on contacts/leads/outreach_campaigns with live dependents (ownerrez-message-ingest daily; squarespace-commerce every 300 s). Paloma base tables builder-less (only the 2 anti-future triggers are code-defined; both live). Schema not reconstructible from code; backups carry schema (compensating).
- **Integrity** (QC3A-06): online-backup snapshot (sha e885914…9cb1): integrity_check ok; FK 0/40 tables; orphans 0×6; statuses in-vocab (outbox 620/620 completed; 0 open reviews); 0 contradictions/future-ts/over-max/stale leases; volumes 4526/2764/13546/44371/7196.
- **Migration idempotency** (QC3A-07, FIXTURE on disposable restore): 001–020 → 19/20 exit 0, schema hash byte-identical, rows unchanged, integrity ok; **009 exit-1 is a designed data guard** (20 reviewed dossiers → refuses without backup) — runbook note for QC-3b.
- **Paloma + Chroma** (QC3A-08): plugin path == intended tasks.db; snapshot integrity + triggers ok; chroma quick_check ok. Hygiene handoffs to QC-3b below.

## Blockers

None. Open D-rows: D-004, D-006 (**blocks QC-3b restore drills/offsite retrieval — ask before any drill**), D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (QC-4), F-015 + F-016 (dedicated fix session per D-008). Open P2s: F-023 (nested repo), F-025 (install reproducibility), **F-006 (path contract, QC-3a)**, **F-029 (schema provenance, QC-3a)**. Open P3s (batch per D-008): F-024, F-026, F-021, F-027, F-028, **F-030**.

## Next

**QC-3b — recovery matrix + backups/offsite + scheduling/observability** (plan §QC-3 second half; QC-3a was the split point).

**Exact next command** (start ritual, §8, real repo root):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ `87a4e6c`. Then `cd ~/qc-worktree`, read `qc/STATUS.md`, read plan §QC-3, and execute QC-3b:

- Recovery matrix per store: CRM DB, `paloma/data/tasks.db`, `workflow/policy.json` + openclaw config, campaign registry (**lives in the CRM DB**, not a file — QC0-12), accounting inbox/archive, warmup state, secrets/recovery material, media originals, Chroma (verify the documented rebuild path in `crm/scripts/chroma-server.sh` without exporting message bodies). Add the F-025 node_modules/toolchain rebuild row (clean `npm ci` broken on host; python workaround recorded in F-025).
- Backups: creation cadence (daily 03:15 + deploy-triggered), age, retention/prune, encryption, recovery-key access, `mode=ro` verify — **offsite retrieval + disposable restore + RPO/RTO need D-006: ask the owner before any drill**. Re-verify backup SOURCE identity == runtime DB (F-006). QC-3a's clean snapshot is available for comparisons: `~/qc-evidence/QC3A/crm-snapshot-20260815.db` (sha e885914…9cb1).
- Restore-drill job exists and is LOADED weekly (`restore-drill`, Tue 05:30, installer-managed, watchdog-covered) — audit what it actually proves (automation/backup_restore_drill.py) vs off-host recovery (F-013).
- Scheduling/observability: cadence-aware monitoring matrix per critical job (manifest Alert column is the input; F-015 gaps known); `/tmp` logging set (chroma, heartbeats ×3, tunnel, + hand-installed kapital-tests/qbo-keepalive/ownerrez trio — outside repo log rotation, QC1B-03); WAL growth behavior; disk capacity/growth; log rotation; clock/TZ/DST (host TZ America/Los_Angeles, no plist sets TZ); overlapping runs; missed-run/catch-up semantics; reboot ownership.
- Hygiene rows handed from QC-3a: 644-mode DB copies (pre-owner-cash-flow, crm-pre-paulina-scale + stale WAL/SHM siblings, paloma pre-rewind — all under the 700 `~/.openclaw` ancestor); sibling attribution (0-byte `-wal` = post-copy open signature); migration-009 exit-1 runbook semantics; F-018 remaining halves (offsite untested, non-CRM coverage).

All RO/FIXTURE unless a new authorization line says otherwise; restore drills and offsite retrieval additionally gated on D-006. At QC-3 completion (3a+3b): phase-boundary PR per Amendment 3 (docs-only qc/** batch; owner runs `gh pr merge` via `!`), which also pushes the accumulated branch commits.
