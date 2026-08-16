# QC status

Updated: 2026-08-15 (PDT) — session 7 (QC-2 phase boundary). **QC-2 phase COMPLETE and MERGED (PR #71 → 87a4e6c); all five §QC-2 webhook surfaces dispositioned; production ff'd docs-only; deployed runtime baseline remains 2983ed0.**

Authorizations session 7: BUSINESS — QC-2 phase-boundary PR create (docs-only, qc/** from QC-2a+2b) + docs-only fast-forward of production main after merge; owner runs `gh pr merge` via `!`. All else RO/FIXTURE. Session 6 (QC-2b) ran blank-auth RO/FIXTURE only, writes confined to `~/qc-worktree` + `~/qc-evidence/QC2B/`, overlays read in place (F-023 dirt untouched).

## QC-0 — COMPLETE (session 1; baseline then d1a119e)

## QC-1 — COMPLETE (sessions 2–4: tripwire 7/7; F-020 verified-fixed; inventory + convergence diff + service manifest at 2983ed0; phase-boundary PR #70 merged; production ff'd to 4b251ff docs-only; **deployed runtime baseline remains 2983ed0**)

## QC-2a — COMPLETE (session 5). Rows QC2A-01…11; evidence E-QC2A-00…04

## QC-2b — COMPLETE (session 6, 2026-08-15). Rows QC2B-01…08; evidence E-QC2B-01…07

Preconditions: production clean `main` @ 4b251ff; worktree code byte-identical to 2983ed0 outside qc/+.claude (0 files); no `.env`/DB-path env in session; QC2B evidence dir 700.

- **Webhook bad/missing-auth by attempted violation** (QC2B-01): FIXTURE probe on the REAL exported routers + real auth libs (temp secrets, null DB → 503 proves the gate opened; no network) — **22/22 PASS**. Twilio inbound+status reject NO/BAD/tampered signature + signature-for-WRONG-AccountSid (403), accept only exact sig, fail-closed 503 without secrets, retired /reply+/thread-reply 410; OwnerRez Basic (401 no/wrong, fail-closed 401 unconfigured, accept valid); workflows loopback+bearer (remote-XFF 403 even with token, no/short token 401); QBO /callback state-CSRF (no/tampered/expired state 400, valid-no-code 400 before any exchange). Extends the existing signature-function unit tests to the mounted-route + missing-auth + replay layer.
- **Internal-API default-deny** (QC2B-02): code trace — `guardProtected` (server.js:663) precedes 100% of `/api` (earliest 1223; all 10 routers ≥1381); 6 PUBLIC_API_PATHS only, each with downstream auth. FIXTURE on real guardProtected — **13/13 PASS**: no-creds remote→503 fail-closed, creds remote→401, correct Basic→200, loopback→200; allowlist exact (track/lp-config/ownerrez-webhook/qbo-callback PUBLIC; lp/stats+contacts PROTECTED).
- **Release/CI/worktree guards** (QC2B-03): `validateCheckoutState` rejects wrong-branch / non-primary-worktree / dirty / SHA-mismatch; + green-CI-`verify` gate, single-flight lock, `--confirm-production`, check:stack step. `test:release` **3/3 PASS**. A QC worktree cannot deploy (non-primary → throw); a deploy cannot report success from a dirty or un-fast-forwarded checkout.
- **Secret scanner** (QC2B-04): FIXTURE in an isolated temp git repo — catches all 7 credential-pattern classes exercised + the forbidden private file (exit 1), passes clean (exit 0).
- **Log/argv/URL secret discipline** (QC2B-05): no secret values logged (only redacted markers + LLM token counts); none via argv; none in query strings; token transport header-only.
- **Tool-guard LIVE config** (QC2B-06): deployed openclaw.json scopes `resort_workflow` to `agentIds:["resort"]`, 35 controlled channels, shadow=true, no gateway-side control token; both SocialSol agents Slack-only; co-tenant isolation. Matches QC2A-10 code+test at the live layer.
- **OAuth scopes** (QC2B-07): QBO scope accounting-only; token store atomic mode-600; `/status`+`/test` loopback-gated. **QC-4 handoff:** client/scope/`env=sandbox` load from `quickbooks-dev.json` while `quickbooks.json` is the token store — reconcile sandbox-vs-production in QC-4.
- **Private overlays** (QC2B-08 → **F-021 validated P3, contained**): live resort+paloma overlays clean of mutation recipes/credentials; risky curl/token recipes only in ORPHANED legacy `workspace-resort/TOOLS.md` (mode 644, not loaded — resort workspace is the nested repo); no real credentials in `SECRETS.md`/`TOOLS.md`. Tool guard is the durable compensating control.
- **New P3 findings:** F-021 (overlays, contained → fold into F-023), F-027 (QBO `/callback` reflected-XSS + unvalidated realmId persist), F-028 (secrets file-mode hygiene: `anthropic_vocabgen.json` 644 holds a live api_key, mitigated by 700 parent; stray `.bak`; tracked+served `tracker.js.bak`). All batch per D-008 P3.
- **Webhook-surface coverage completion** (session 7, owner-directed; QC2B-09…12, E-QC2B-08): plan §QC-2's five surfaces — Twilio+OwnerRez violation-tested (QC2B-01); Meta/Resend/Cal.com routes all PRESENT so no "N/A — route not present"; none exercised per owner instruction. Dispositions (owner 2026-08-15): Meta inbound webhook (armed, signature-gated, DM→Slack forwarding half D-002 allows) → probes owned by **QC-8**; Resend (armed, svix-gated, bounce auto-pause path) → **QC-7** as planned; Cal.com (recognized surface; dormant-by-config, `calcom.json` absent → all requests 503 fail-closed) → probes **QC-10**. QC-2 exit "gaps have owners" satisfied; §12(1) closure lands in owning phases.

## Blockers

None. Open D-rows: D-004, D-006, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (QC-4), F-015 + F-016 (dedicated fix session per D-008). Open P2: F-023 (nested repo — convergence proven), F-025 (install reproducibility). Open P3s (batch per D-008): F-024, F-026, F-021, F-027, F-028.

## Next

**Phase boundary DONE (session 7):** PR #71 merged by owner (merge commit 87a4e6c, 2026-08-16T00:55Z); production `main` ff'd 4b251ff → 87a4e6c docs-only (QC2B-14, E-QC2B-11): ff-ancestry proven, 6 incoming files all `qc/**`, tree clean, code diff vs 2983ed0 outside qc/+.claude EMPTY, newest deploy record still 2026-08-15T21:39Z @ 2983ed0. **Deployed runtime baseline remains `2983ed0`** — no release ceremony.

**QC-3 — State, schema, backup, recovery, scheduling, observability** (plan §QC-3; QC-3a = DB identity + schema + integrity, QC-3b = recovery matrix + backups/offsite + scheduling/observability; D-003 allows single large session with a/b as fallback).

**Exact next command** (start ritual, §8, real repo root):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ `87a4e6c`. Then `cd ~/qc-worktree`, read `qc/STATUS.md`, read plan §QC-3, and execute QC-3a. Seeded handoffs: 0-byte `crm/data/resort-crm.db` (deploy-day stray), snapshot WAL/SHM siblings, offsite retrieval + RPO/RTO (D-006 OPEN — ask before any restore drill), node_modules/toolchain rebuild row (F-025), `/tmp` logging on hand-installed + 5 templated jobs (QC1B-03), path-contract test (`DB_PATH` vs `CRM_DB_PATH` vs repo-local defaults, T3/F-006). Live-DB reads only via `file:<path>?mode=ro` or online backup (§4.4); migrations only on a disposable restore. Worktree `node_modules` from QC-2a reusable for FIXTURE suites. All RO/FIXTURE unless a new authorization line says otherwise.
