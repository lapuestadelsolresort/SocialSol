# QC status

Updated: 2026-08-15 (PDT) — session 6 (QC-2b). **QC-2b COMPLETE → QC-2 phase COMPLETE.**

Authorizations this session: blank (RO/FIXTURE only) — honored; no CANARY/OUTAGE/BUSINESS action taken. All writes confined to `~/qc-worktree` and `~/qc-evidence/QC2B/`. Overlays under the dirty outer `~/.openclaw` were READ in place only (F-023 dirt untouched); no contents copied into Git — only sanitized fingerprints + risk counts.

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

## Blockers

None. Open D-rows: D-004, D-006, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (QC-4), F-015 + F-016 (dedicated fix session per D-008). Open P2: F-023 (nested repo — convergence proven), F-025 (install reproducibility). Open P3s (batch per D-008): F-024, F-026, F-021, F-027, F-028.

## Next

**QC-2 phase-boundary PR** (Amendment 3 / §3 — one docs-only PR per phase; mirrors QC1B-09/10). Batch the QC-2a + QC-2b `qc/` artifacts to `main`. **Needs owner authorization** (BUSINESS: PR create + docs-only fast-forward; owner runs `gh pr merge` via `!`). Pre-flight like QC1B-09: diff vs `main` must touch `qc/**` only (+ any owner-named file); `npm run check:secrets` on the branch must be exit 0; §4.1 redaction sweep over the full diff must be clean (no channel IDs/tokens/UUIDs/phones/provider IDs/emails). **Deployed runtime baseline stays `2983ed0`** (docs-only, no release ceremony).

**Exact next command** (start ritual, §8, real repo root):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ `4b251ff`. Then `cd ~/qc-worktree`, read `qc/STATUS.md`, read plan §3 + §QC-2 Exit, and (with owner authorization) run the QC-2 phase-boundary PR pre-flight → push → owner-run merge → agent-run docs-only ff. After the PR merges, QC-3 (State, schema, backup, recovery, scheduling, observability) is the next phase; its §12 handoffs are seeded (0-byte `crm/data/resort-crm.db`, snapshot WAL/SHM siblings, offsite RPO/RTO, node_modules/toolchain rebuild row per F-025). Worktree `node_modules` from QC-2a remains reusable for FIXTURE suites. All RO/FIXTURE unless a new authorization line says otherwise.
