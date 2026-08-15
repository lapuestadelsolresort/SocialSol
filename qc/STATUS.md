# QC status

Updated: 2026-08-15 (PDT) — session 5 (QC-2a). **QC-2a COMPLETE.**

Authorizations this session: blank (RO/FIXTURE only) — honored; no CANARY/OUTAGE/BUSINESS action taken. All writes confined to `~/qc-worktree` (incl. worktree `node_modules` install for the mandated test inventory) and `~/qc-evidence/QC2A/`.

## QC-0 — COMPLETE (session 1; baseline then d1a119e)

## QC-1 — COMPLETE (sessions 2–4: tripwire 7/7; F-020 verified-fixed; inventory + convergence diff + service manifest at 2983ed0; phase-boundary PR #70 merged; production ff'd to 4b251ff docs-only; **deployed runtime baseline remains 2983ed0**)

## QC-2a — COMPLETE (session 5, 2026-08-15). Rows QC2A-01…11; evidence E-QC2A-00…04

Preconditions: production clean `main` @ 4b251ff; worktree code byte-identical to 2983ed0 outside qc/+.claude (0 files); no `.env`/DB-path env in session.

- **Stack + inventory** (QC2A-02/03/04/05): `check:stack` **EXIT=0** at deployed-baseline code — 5 static gates + 693 tests (automation 52, accounting 65, evals 3, release 3, crm 436, prospector 20, regina 3, paloma 11, openclaw-plugins 100) + landing builds; python suites verified stubbed before running. `git diff --check` clean. **F-025 opened P2**: clean `npm ci` fails on this host (lockfile node-gyp 8.4.1 needs removed python distutils; better-sqlite3 has no prebuilt path; release pipeline never installs deps → latent recovery blocker; workaround `npm_config_python=/usr/bin/python3` proven). **F-026 opened P3**: 2 high npm-audit advisories (js-yaml/nanoid), both landing build-toolchain only, no runtime consumer.
- **Registered-graph-only + no escape hatch** (QC2A-06): registry Map fixed; worker skips unknown names; HTTP 404s unregistered; every runCommand site is a string-literal repo script (resolveRepoFile blocks escape); executeGraph callers = worker only.
- **Authorization model** (QC2A-07): loopback under `trust proxy,1` (XFF-spoof denied), ≥32-char timing-safe token fail-closed, system→autonomous allowlist, slack→channel capability + restricted-user allowlists; validatePolicy refuses ownerrez.write/marketing.write/email.send without non-empty user allowlists.
- **Negative FIXTURE matrix** (QC2A-08): 16/16 probe PASS on the real router (wrong channel/user, spoofed system origin, missing identity, unknown workflow, bad method/URL, token negatives, duplicate dedupe, changed-input collision, serialized-mutation 409, zero-side-effect postcondition) + committed-suite coverage for prose/interception/model-tool denial/quarantine refusal/no-messageId fail-closed.
- **Durable boundary** (QC2A-09): input/request/policy-snapshot hashing, execute-once effects, UNIQUE keys + serialization partial index, review-blocks-mutations, token-fenced leases + heartbeat, guest-boundary expiry → manual review never replay, monotonic effect states (acceptance ≠ delivery), outbox dead-letter at 12, atomic single-winner review resolution, projection retry never re-sends.
- **Slack surface** (QC2A-10): identity gateway-bound (never model params), claims before model, exact anchored parsers, per-purpose channel sets, stable-messageId dedup, agentIds-scoped tool registration (co-tenant isolation).
- **F-024** (QC2A-11): confirmed neither validator enforces `autonomous ⊆ live` — invariant lands with the fix session.

## Blockers

None. Open D-rows: D-004, D-006, D-007 (validator), D-009, D-010 (confirm), D-001 remaining rows, D-002 owner-cash-flow row. Open P1s: F-001 (QC-6), F-005 (QC-7 gate), F-014 (QC-4), F-015 + F-016 (dedicated fix session per D-008). New P2/P3 this session: F-025 (install reproducibility), F-026 (audit advisories) — batch per D-008.

## Next

**QC-2b — security/privacy + overlays + scanner + release guards** (plan §QC-2 second split): secrets owners/modes/symlinks audit (QC-1 inputs: anthropic_vocabgen.json mode 644 + stray healthchecks.json.bak among 26 secrets files); log/argv redaction; webhook bad/missing-auth FIXTURE tests for Twilio inbound/status, Meta, Resend, Cal.com, OwnerRez against local fixtures (security-hardening.test.js already binds signatures — extend to missing-auth/replay cases; production endpoint negatives need a separately approved plan); internal API default denial/loopback sweep across the ~66 routes + 10 routers (guardProtected/requireLoopback/requireBrowserSource from QC1-INV-02); OAuth scopes; token transport in headers; private OpenClaw instruction overlays inspected in place (sanitized result + hash only; never copy contents into Git); controlled-channel terminal-tool-guard denial of direct shell/Meta/QBO (code+tests verified in QC-2a row QC2A-10 — add the live-config denial check); secret scanner tested with fixtures in an isolated temp repo; worktree/branch/CI/release guards (deployment cannot report success from unreviewed/dirty serving checkout — test:release suite exists, verify coverage). All RO/FIXTURE unless a new authorization line says otherwise.

**Exact next command** (start ritual, §8, real repo root):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ `4b251ff` (docs-only over the runtime baseline). Then `cd ~/qc-worktree`, read `qc/STATUS.md`, read plan §QC-2, and execute QC-2b. **Deployed runtime baseline remains `2983ed0`** (newest deploy record) unless a newer deployment record says otherwise. Note for QC-2b/QC-3: worktree `node_modules` exists (installed this session via the F-025 workaround) — reusable for FIXTURE suites; a phase-boundary PR for QC-2 follows QC-2b per Amendment 3.
