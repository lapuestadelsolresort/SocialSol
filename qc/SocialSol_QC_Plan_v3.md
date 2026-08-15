# SocialSol QC Plan — v3 (working plan)

Date: 2026-08-15
Executor: Claude Code on the production Mac mini (repo root `~/.openclaw`)
Owner: Jason. Owner decisions live in `qc/DECISIONS.md`.
Supersedes: `SocialSol_QC_Plan.md` (v1) and `3-SocialSol-QC-Plan-Revised.md` (v2).

This is the only document the executor needs. If any statement here conflicts
with repo or runtime reality, reality wins and the conflict is recorded as a
finding — that rule applies to claims inherited from v1 *and* v2 equally.

---

## 0. Lineage — read once

v1 (Claude) set the structure: zero-trust posture, foundations before
verticals, accounting first among verticals, gates verified by attempted
violation, session sizing for a solo operator. It was written from project
documents now known to be stale.

v2 (builder-side review at commit `d1a119e`) corrected scope to the current
system — workflow registry, durable control plane, release pipeline,
WhatsApp/Meta-DM/email transports, Squarespace commerce, owner cash flow —
and added evidence hygiene, action classes, and cadence-aware soak. Four of
its dispositions are rejected or amended below.

v3 = v2's structure and scope + v1's session mechanics + these amendments.

### 0.1 Binding amendments

1. **Autonomy is an owner decision, not a README citation.** F-005 is not
   retired. The autonomy matrix is stated by Jason in `qc/DECISIONS.md`
   (D-001). Documentation and runtime policy are reconciled *to* D-001;
   agreement between README and runtime config is necessary, never
   sufficient. QC-7 does not start without D-001.
2. **F-001 (Meta creative-review gate) is reopened as P1.** v2 concedes that
   no machine-enforced creative/landing-review state exists in current code
   and proposes adding one. A control that failed historically (spend during
   review) and is currently unimplemented is an open finding, not a retired
   hypothesis. Closure = implemented invariant + regression test +
   verification at the deployed production SHA.
3. **Proportionality.** Doc-only QC commits batch-merge at phase boundaries.
   The full PR → CI → merge → release ceremony is reserved for code fixes.
   Evidence records use the trimmed format (§4.3); the long-form record is
   required only for P0/P1 evidence.
4. **v2's factual claims are hypotheses.** They enter the same pipeline as
   v1's stale facts and are settled by the QC-1 credibility tripwire —
   generated inventory over narrative, in both directions.

---

## 1. Executor contract (Claude Code)

- Show the command and its captured output for every claim. An asserted
  result without output does not exist.
- If a spec is missing or contradictory — or intent, authorization, or
  expected behavior is ambiguous in any way — stop and ask the owner. Do
  not infer and proceed. This is an owner-directed standing instruction
  (2026-08-15). A missing spec is itself a finding.
- Label every check's action class (§5) before running it. If code tracing
  reveals hidden side effects, relabel; if the approval class rises, stop and
  ask.
- Stop at the phase's split point or at ~70% of session budget, whichever
  comes first. Before ending any session, write `qc/STATUS.md` with the exact
  next command.
- Never mutate production from a QC session except approved CANARY / OUTAGE /
  BUSINESS actions, or P0 containment with explicit owner authorization.
- The production checkout stays clean on `main` at all times. All QC work
  happens in the worktree.

## 2. Posture

- Every completion claim in `Project_Status.md`, `MEMORY.md`, `README.md`,
  the R-plans, chat transcripts, **and the v2 review** is a hypothesis until
  re-proven with a command and captured output.
- Document first, fix second. Findings and fixes happen in separate sessions
  and separate commits.
- Source-of-truth order for any fact:
  1. Authoritative provider (Meta, QBO, Kapital, OwnerRez, Squarespace,
     Resend, Gmail, Slack) for mutable business facts.
  2. Durable workflow/effect/evidence ledger for what SocialSol attempted
     and verified.
  3. Exact deployed Git SHA, current code, runtime policy/config, loaded
     producers, current DB schema.
  4. Canonical docs (`README.md`, `ARCHITECTURE.md`, `workflow/README.md`,
     `workflow/CUTOVER.md`, service `COMMANDS.md`) and recorded owner
     decisions.
  5. Historical plans, private memory, status notes, transcripts — as
     hypotheses only.
- Authority boundaries: OwnerRez is authoritative for bookings/occupancy
  (its CRM sync is contact-only — never treat CRM as a booking mirror).
  Squarespace is authoritative only for direct-commerce facts. Kapital/QBO
  for bank/books. Provider acceptance, delivery, read, and verified readback
  are distinct states.
- Corporate Intelligence is out of scope except a boundary/no-leakage check
  (D-010). Its content requires a separate privileged audit.

## 3. Repository, worktree, and release rules

- Create a dedicated worktree for QC work, e.g.
  `git worktree add ~/qc-worktree qc/baseline-20260815` (follow the repo's
  branch-prefix convention if CI expects one — discover in QC-0).
- Versioned QC artifacts live under `qc/` **on the QC branch**. Batch-merge
  to `main` at phase boundaries via one PR per phase (Amendment 3).
- Code fixes always take the full path: scoped branch → tests including the
  repo's stack check → commit/push → PR → CI verify → merge → fast-forward
  production → release check → deploy → live-health verification. Exact
  command names are discovered in QC-1 (tripwire T6); v2 cites
  `npm run check:stack`, GitHub `verify`, `release:check`, `release:deploy`.
- A merged fix is not a verified fix. Verification happens at the deployed
  SHA in production and is recorded against the finding.

## 4. Evidence rules

### 4.1 What never enters Git

Live DB copies, provider payloads, customer/contact rows, message bodies,
receipt/bank records, Slack payloads, logs, private memory files, runtime
policy contents, credentials, or operational identifiers. Committed text
uses aliases for provider account/campaign IDs.

### 4.2 Where evidence lives

Raw evidence: `~/qc-evidence/` (dir mode 700, files 600), organized by check
ID. Committed, sanitized files only:

- `qc/CONTROL_MATRIX.md` — one row per control: ID, control, phase, action
  class, verdict, evidence ID, date. Passes live here.
- `qc/EVIDENCE_INDEX.md` — evidence ID → SHA-256 of raw artifact + one-line
  redacted summary.
- `qc/FINDINGS.md` — validated deviations only.
- `qc/RISK_HYPOTHESES.md` — carried-in and suspected issues awaiting
  evidence (seeded from §10).
- `qc/DECISIONS.md` — owner decisions D-001+ (seeded from §11).
- `qc/STATUS.md` — phase progress, blockers, exact next step.

### 4.3 Evidence record formats

Trimmed (default): check ID · action class · command/query description ·
date+TZ · expected · actual · verdict · raw-artifact path + SHA-256.

Long form (P0/P1 only): add environment + deployed SHA, non-secret
config/manifest fingerprint, collector version, independent provider
evidence, reviewer, revalidation date.

### 4.4 SQLite and side-effect discipline

- Read live DBs via read-only handles (`file:<path>?mode=ro`) or SQLite
  online backup. Never file-copy while WAL may be active.
- Destructive migration or fault tests run only on a disposable restore.
- A `--dry-run` flag is not evidence of read-only behavior. Trace code for
  OAuth token refresh, schema setup on open, FX cache writes, runtime-state
  writes, Healthchecks pings, and Slack posts before classifying RO.

## 5. Action classes

| Class | Meaning | Approval |
|---|---|---|
| RO | Static inspection or proven side-effect-free production read | QC charter |
| FIXTURE | Disposable DB/config with stubbed providers/network | QC charter |
| CANARY | Bounded production write using an allowlisted test identity or a genuine passive event | Explicit approval + cleanup/reconciliation plan |
| OUTAGE | Process stop, tunnel interruption, reboot, cutover | Maintenance window, named operator, rollback + abort criteria |
| BUSINESS | Email/WhatsApp/DM send, Meta change, Postiz publish, QBO/OwnerRez write, deployment | Authority contract (D-001) + explicit QC authorization |

## 6. Severity and status

| Severity | Definition |
|---|---|
| P0 | Evidenced active or immediately reachable unauthorized spend/send/write, material data corruption/loss, secret exposure, or books corruption |
| P1 | Reachable failure of a critical gate, source-of-truth reconciliation, recovery control, scheduler, or alert path |
| P2 | Material drift or weakness with a functioning compensating control |
| P3 | Hygiene, dead code, low-impact UX/doc debt |

Statuses: `hypothesis` → `validated` → `contained` → `fix-in-review` →
`deployed` → `verified-fixed`, or `accepted-risk` / `inconclusive` / `N/A`.

On a validated P0: stop the affected audit path, notify the owner, contain
only via a pre-authorized runbook or explicit authorization. "Stop the line"
is not permission for an unreviewed campaign, email, QBO, OwnerRez, or
deployment change.

## 7. Standard control test (applied to every workflow)

1. **Contract & authority** — source of truth, actor identity, channel,
   trigger, input schema, capability, autonomy per D-001, confirmation,
   expiry, notification, prohibited paths.
2. **Implementation** — registered graph, policy entry, provider adapter,
   fixed operation set, config resolution, no generic mutation escape hatch.
3. **Deterministic tests** — unit/integration/contract tests at the exact
   SHA, including negative authorization and invariant tests.
4. **Deployment topology** — template → rendered plist → installed plist →
   loaded job/cron → process; source freshness; exactly one producer per
   effect.
5. **Data/provider reconciliation** — provider truth → durable
   effect/evidence → local projection → Slack wording, with semantic and
   date-window checks.
6. **Replay & recovery** — duplicate events, idempotency-key conflicts,
   timeout before/after provider acceptance, retry, fencing, serialization,
   manual review.
7. **Observability** — last start/success/exit/evidence, cadence-aware stale
   threshold, Healthchecks, owned alert destination, verified recovery
   signal.
8. **Security & privacy** — wrong user/channel/service, missing/bad webhook
   signature, loopback/default denial, least privilege, redaction, file
   modes, no secrets/PII in output.
9. **User contract** — exact Slack command behavior, format/language,
   accurate state wording, passive or approved canary, designated human
   validation.

No high-risk workflow passes from a green Slack message alone. Gates are
verified by attempted violation — on FIXTURE/stubbed adapters for live
providers, never against a live campaign or a real recipient.

## 8. Session mechanics

- Size: 60–120 minutes active work, ≤15–20 files read deeply, one committed
  artifact per session.
- Start ritual: `git -C ~/.openclaw status` (production must be clean; any
  dirt is reconciled and attributed before QC proceeds) → `cd ~/qc-worktree`
  → read `qc/STATUS.md` → read the current phase section.
- End ritual: append CONTROL_MATRIX / FINDINGS / EVIDENCE_INDEX rows, update
  STATUS.md with the exact next command, commit
  `qc(QC-N): <what was verified>`.
- Budget guardrail: at ~70% of budget without reaching the phase's split
  point, stop at the nearest checklist boundary; the remainder becomes
  QC-Nb.
- D-003 (Max tier and usable session length) calibrates whether phases run
  as single or double sessions.

---

## 9. Execution phases

### QC-0 — Governance, evidence safety, immediate safing

Goal: safe boundaries established; any active harm detected before the long
audit begins.

- Create the QC worktree and `~/qc-evidence/` with correct modes.
- Materialize `qc/` skeleton: seed `RISK_HYPOTHESES.md` from §10,
  `DECISIONS.md` from §11, empty CONTROL_MATRIX / EVIDENCE_INDEX / FINDINGS /
  STATUS.
- **Gate: D-001 and D-002 must be answered by the owner before QC-0 exits.**
  D-003–D-011 should be answered here too; only D-001/D-002 block.
- Record: production branch/SHA, `origin/main` SHA, latest successful CI
  verify, latest deployment record, loaded CRM/worker source age, non-secret
  runtime-policy fingerprint.
- Traced RO sweep for current harm: queued/stalled workflow runs, dead
  outbox rows, overdue effects, open manual reviews, active Meta spend
  summary, due outreach, recent QBO write failures. Any unknown active
  spend, unapproved autonomous sender, or continuously failing financial
  writer escalates to the owner immediately.
- Discover repo conventions: branch prefix expected by CI, exact
  release-path command names, secret-scanner invocation.

Exit: no uncontained P0; D-001/D-002 recorded; baseline SHA recorded; qc/
skeleton committed on the QC branch.

### QC-1 — Credibility tripwire, generated inventory, deployment convergence

Goal: establish what actually exists, which copy is live, and whether v2's
factual frame holds.

**First 30 minutes — the tripwire.** Run in order, record a scorecard in
STATUS.md:

| # | Claim under test | v2 says | v1/docs said | Test |
|---|---|---|---|---|
| T1 | Workflow registry | `crm/workflows/registry.js`, ~53 definitions | not documented | locate file, count definitions |
| T2 | Migration max | through 020 + runtime schema builders | 017 | list migrations, grep builders |
| T3 | DB path contract | runtime `DB_PATH` vs backup `CRM_DB_PATH` split | three ad-hoc paths | read plists/env; `lsof` open file/inode |
| T4 | Failing jobs now | daily-tests, tracker-liveness, media-rescan nonzero last exit; watchdog blind to them | "all green" claims | `launchctl print` last-exit per job; logs |
| T5 | Paulina send gate | `email_status='verified'` + pre/send-time checks; `realness_score` absent | `realness_score >= 4 AND status='verified'` (migration 017) | grep the actual send path |
| T6 | Release pipeline | `check:stack`, CI `verify`, `release:check`, `release:deploy`, `workflow/policy.json`, `CUTOVER.md` | not documented | package.json scripts, CI config, ls |
| T7 | Meta DM send path | exact `!dm` handler + retired HTTP sender exist | owner does not recognize this feature (2026-08-15) | grep for the `!dm` handler and any Meta DM adapter |

Scoring (of 7): ≥6 confirmed → proceed on v2's factual frame (still
evidence-first everywhere). ≤4 confirmed → stop; open a finding on the v2
review itself; re-plan with the owner. 5 → proceed check-by-check, trusting
no narrative claim from either lineage. T7 cuts both ways: a confirm there
supports v2's credibility but simultaneously opens F-020 — a send path the
owner does not recognize — and triggers the QC-8 quarantine procedure
before anything else proceeds.

**Then the generated inventory** (never a handwritten list):

- Workflows from the registry; routes/webhooks; provider adapters; CLI
  entrypoints; Slack hooks; read models; OpenClaw plugins/crons; LaunchAgent
  templates → fresh render to temp dir → installed plists → loaded launchd
  state → running processes (legacy `launchagents/` is not canonical);
  databases; Chroma collections; runtime configs; secrets locations; alert
  destinations; provider authorities.
- Per command: actual side effects, default mode, required switch,
  token-refresh behavior, local writes, external writes, notifications.
- Expected producers derived from runtime `workflow/policy.json` and the
  cutover replacement map. Intentionally dormant template = not a failure.
  Legacy and graph producer both capable of the same effect = P1/P0.
- Versioned service manifest: label, owner, expected state, schedule, TZ,
  args, env contract, criticality, alert owner, replacement/retirement
  relationship.
- Verify clean production `main`, local/remote SHA agreement, latest
  deployment record, process source freshness.
- Validate v2's self-reported priority evidence: nonzero last exits (T4),
  watchdog coverage gap, accounting test/keepalive jobs outside the
  canonical template set, committed Paloma services not installed. Expected
  outcome: a P1 service-manifest/release-convergence finding unless the
  inventory supplies a valid alternative owner and control.

Split: QC-1a = tripwire + registry/schedule inventory. QC-1b = convergence
diff + service manifest + priority-evidence validation.

Exit: every discovered component owned and classified; no duplicate
high-risk producer; tripwire scorecard recorded; schedule/alert gaps are
findings.

### QC-2 — Control plane, authorization, security, release gates

Goal: prove the shared safety boundary before any vertical.

- In the worktree: run the stack check, `npm audit --omit=dev`,
  `git diff --check`, and the complete test inventory from `package.json`.
  The daily test script is not a substitute.
- Registered-graph-only execution; trusted Slack identity binding; channel
  capabilities; restricted-user capabilities; service identities; allowed
  triggers; exact command interception.
- Negative FIXTURE tests: wrong user/channel, spoofed identity, ordinary
  prose, edited/replayed command, duplicate Slack event, reused
  idempotency key with changed input, unsupported method/URL/tool.
- Durable-boundary verification: request/input hashes, effect/request
  hashes, provider idempotency, worker-only execution, lease
  heartbeat/fencing, retry classes, serialized guest sends, effect vs
  local-projection separation, durable outbox, dead-letter behavior, manual
  review, atomic review resolution.
- Shadow/live policy proven at every effect boundary; retired direct
  WhatsApp/Meta-DM/provider routes unreachable.
- Claim hooks cannot label accepted as delivered/read/published and cannot
  claim completion without the required artifact.
- Webhook bad/missing-auth tests for Twilio inbound/status, Meta, Resend,
  Cal.com, OwnerRez — against local fixtures first. A production endpoint
  negative test requires a separately approved plan and proof of zero
  durable side effect.
- Internal API default denial/loopback, token transport in headers, OAuth
  scopes, secret owners/modes/symlinks, log/argv redaction, dependency risk.
- Private OpenClaw instruction overlays: inspect in place for stale paths,
  direct provider-mutation recipes, query-string tokens. Commit only a
  sanitized result + hash. Prove the controlled-channel terminal tool guard
  denies direct shell/Meta/QBO calls; then queue stale-guidance cleanup
  through the private-runtime change path.
- Secret scanner tested with fixtures in an isolated temp repo; full-history
  audit and CI verify audited separately.
- Worktree/branch/CI/release guards: a deployment cannot report success from
  an unreviewed or dirty serving checkout.

Contingency: if T1/T6 showed the durable control plane does not exist as
described, the outbox/lease/readback layers here are N/A — and that absence
is itself a P1 architectural finding (the highest-risk operations lack the
claimed boundary). Do not invent tests for absent machinery; fall back to
v1-style shared-infra checks (webhook signatures, monitoring, backups) plus
QC-3.

Split: QC-2a = authorization + negative fixtures + durable boundary.
QC-2b = security/privacy + overlays + scanner + release guards.

Exit: shared mutation-boundary tests pass; no unsupported provider mutation
path reachable; release/security gaps have owners.

### QC-3 — State, schema, backup, recovery, scheduling, observability

Goal: state is singular, recoverable, and monitored.

- Resolve the effective CRM DB for server, worker, backup, OwnerRez message
  ingestion, graphs, reports, and maintenance jobs — via process
  environment, resolved path, open file/inode, and freshness. Do not ask the
  owner to guess; do not rely on `page_count` alone.
- Path contract explicitly tested: runtime `DB_PATH`, backup `CRM_DB_PATH`,
  repo-local defaults in entrypoints. Every production consumer must
  resolve to the intended database.
- Discover the final schema dynamically (migrations through current max +
  workflow/Squarespace schema builders). Never rerun all migrations on the
  live DB: probe live read-only; test migrations on a disposable restore.
- On an online snapshot/restore: `integrity_check`, foreign-key checks,
  required table/column/index probes, workflow ledger/effect/outbox orphan
  checks, representative semantic invariants.
- Recovery matrix: CRM DB, `paloma/data/tasks.db`, runtime policy + OpenClaw
  config, campaign registry, accounting inbox/archive, warmup state,
  secrets/recovery material, media originals, Chroma (rebuildable — verify
  the documented rebuild path without exporting message bodies).
- Backups: creation, age, retention, encryption, recovery-key access,
  disposable restore — **plus periodic retrieval and restore of the offsite
  copy**. Define and measure RPO/RTO per non-rebuildable store (D-006
  approves the drills).
- Disk capacity/growth, WAL behavior, log rotation, clock/TZ/DST,
  overlapping runs, missed-run/catch-up semantics, reboot ownership.
- Cadence-aware monitoring matrix: every critical job has last start, last
  success, last exit, evidence, stale threshold, alert destination, recovery
  signal.
- Test-control model finding: daily runner covers only CRM tests + landing
  builds and can suppress failures; the advertised weekly accounting control
  is incomplete (ties to F-014, closed in QC-4).

Split: QC-3a = DB identity + schema + integrity. QC-3b = recovery matrix +
backups/offsite + scheduling/observability.

Exit: no unexplained live DB/path split; recovery coverage and RPO/RTO
explicit; every critical service monitored; offsite restoration proven or
recorded P1.

### QC-4 — Accounting first: receipts, Kapital, QBO, owner expenses

Goal: a trustworthy financial-record pipeline — first business vertical.

- Discover receipt channels from runtime config (whatever the count is —
  never hard-code 11, 14, or any number into evidence).
- Standard receipt bundles: exact Slack source, one bundle with one item per
  attachment, immutable payment-source selection, Spanish instructions, no
  bank-details requirement, deterministic Kapital reference, business-paid
  and already-reimbursed behavior, payment-proof linkage, no duplicate
  payable.
- Owner-expense provenance separately: owner-paid journal, confidence hold,
  exact confirmation, repayment guard, existing-QBO reconciliation,
  liability/bank-account preflight.
- Attachment terminal claiming, exact content-hash replay prevention,
  inbox/archive behavior, fixed classify → receipt-reconcile → QBO
  sequence; direct shell/QBO bypass denied.
- Kapital parsing: running balances, Windows-1252 handling, direction-gated
  credits, exact transaction identity, overlapping-statement dedup, SPEI
  principal/fee handling, held exceptions.
- FX recomputed against the contractual Banxico source with business-day
  fallback, executed conversion rules, and defined rounding — not an
  unexplained tolerance.
- Classification (auto/guess/unknown), configured accounts/vendors, category
  review, QBO paginated duplicate search, `requestid`, write/readback, local
  projection, ambiguous-failure behavior.
- Reconcile one complete closed period (month per D-005): Kapital
  opening/closing balance and every source row → workflow/ledger → QBO
  entity → receipt evidence or named exception. Raw financial evidence
  stays outside Git.
- QBO OAuth refresh audited as a credential mutation: canonical secrets
  path, atomic mode-600 update, concurrency lock, alert/recovery, no token
  output.
- **F-014 closure criteria:** the weekly control is rebuilt or replaced so
  that all seven checks reach terminal results with exact evidence IDs,
  nonzero failure semantics, one canonical schedule, durable completion
  notification, and watchdog coverage. Today two checks stop at
  `needs_slack_scan`, errors can exit zero, and token refresh can write a
  legacy secret path.

Split: QC-4a = receipt pipeline + Kapital + FX + dedup. QC-4b = QBO +
month reconciliation + OAuth + weekly-control rebuild criteria.

Exit: zero unexplained material period delta; zero duplicate payable/QBO
effect; all write effects have provider readback; the weekly control is real
or remains an open P1.

### QC-5 — Squarespace commerce, business reads, owner cash flow

Contingent on D-002 confirming these surfaces are known and authorized.

- Squarespace sync: pagination, overlapping-watermark idempotency, contacts,
  orders, payments, fees, refunds, marketing-consent separation,
  five-minute freshness.
- Conservative OwnerRez link rules; ambiguous records stay review-only.
  Squarespace never creates/edits OwnerRez bookings and never represents
  Airbnb/Vrbo payouts.
- Reconcile a representative direct order: provider → commerce tables →
  reports → receipt/accounting linkage where applicable.
- Every business read model validated against its named authority, and it
  must say when cash, occupancy, email, or another live source was not
  queried.
- Owner cash flow: deterministic fixtures + selected RO provider
  reconciliation — future occupancy from OwnerRez, direct payments/fees
  from Squarespace, unpriced bookings and reconciliation gaps explicit, no
  inference of Kapital deposits or payout dates.
- The normal owner-cash-flow command's writable DB open/schema setup is a
  side-effect mismatch to resolve or safely account for. Never use
  `--apply-reconciliation` during RO QC.
- Owner-answer stdout contract verified separately from numerical
  correctness.

Exit: source boundaries hold; representative figures reconcile; no read path
silently mutates production or overclaims authority.

### QC-6 — Paid Meta, CAPI, landing/tracking, social publishing

Goal: no unauthorized spend, no false conversion evidence.
**Carries Amendment 2: F-001 is open P1 in this phase.**

- Aliases for provider/account/campaign IDs in all committed artifacts.
- Reconcile committed briefs ↔ runtime registry ↔ durable marketing
  evidence/effects ↔ live Meta campaign/ad-set/ad state and spend. Unknown
  active spend is P0.
- New campaigns provision paused. Activation, budget increase, and
  landing-variant changes require: immutable proposal, committed brief hash,
  fresh provider preflight, same authorized user, exact confirmation window,
  execute-once effect, provider readback.
- **F-001 closure:** implement a machine-enforced creative/landing-review
  state invariant (the historical `AWAITING_CREATIVE_REVIEW` name is absent
  from current code; a prose brief is not a test oracle), plus a regression
  test proving spend cannot begin while review is pending, verified at the
  deployed SHA.
- Bounded autonomy verified: pause or decrease only, requiring ≥3 completed
  local days, healthy tracking, unchanged live budget, unexpired evidence,
  committed brief, no prior autonomous mutation within 24h. Never increase,
  never activate.
- Meta negative/ambiguous cases on a stubbed adapter only. Never attempt to
  break the gate against a live campaign.
- Audience targeting vs each brief; audience-recovery hashes; exclusions;
  dormant legacy account (alias-only, read-only — expected: no recent
  spend, writes, registry, or workflow effects); historical traffic mix is
  not evidence of current contamination.
- CAPI: only verified WhatsApp leads with configured paid-Meta UTM
  source/medium/campaign. Email, organic, direct, test, unattributed stay
  CRM-only. Retry preserves original event ID/time and respects the age
  cap.
- The real funnel, end to end (replaces the obsolete form test): exact live
  URL loads tracker JS → page/session/UTM capture → WhatsApp CTA click →
  signed Twilio inbound → durable workflow → lead/attribution/conversion →
  CAPI eligibility. Browser evidence per actual path/ad/content; direct
  `/api/track` beacons do not prove deployed page JS works.
- Tracker cold-start logic audited against actual delivery/first-active
  evidence, not ad-creation time; reconcile by path/ad/content, not only
  source/campaign.
- Postiz/social states distinct: approved, scheduled, accepted, publishing,
  provider-confirmed. Retries cannot double-post.

Split: QC-6a = Meta state + gates + F-001 invariant. QC-6b = funnel + CAPI
+ tracker + publishing.

Exit: no unknown spend; all Meta mutations match the authority contract;
funnel and CAPI evidence are end-to-end; no double publication; F-001
verified-fixed or explicitly accepted-risk by the owner.

### QC-7 — Paulina and Regina outreach

**Gate: does not start until D-001 is recorded.** Effective autonomy is
whatever D-001 says; README, runtime config, and policy files are reconciled
to it. Any discrepancy in any direction is a finding. Owner intent recorded
2026-08-15: Paulina and Regina email auto-send is authorized — per-message
human approval is not required, but every suppression, verification,
provenance, cap, and fail-closed gate below binds with full force under
autopilot. Autonomy is not gatelessness.

Paulina:

- Test the send gate that QC-1 T5 actually found in code — whichever of
  `email_status='verified'` / `realness_score` / both greps out is the gate
  under test.
- Provenance guards; do-not-contact/unsubscribe suppression (planted contact
  = CANARY, needs D-009 identity + approval); role/catch-all/invalid
  handling; caps and ramp; scheduling boundaries; pause behavior;
  provider-unavailable fail-closed.
- Preparation vs dispatch attribution; Resend idempotency; longer-lived CRM
  replay protection; aggregate digest honesty (no misleading per-run
  success notice).
- Bounce/unsubscribe auto-pause via replayed signed webhooks — FIXTURE
  first, production negative only with an approved zero-side-effect plan.
- Gmail Inbox/Sent capture, quote stripping, reply classification. Replies
  must not derive from clicks: verify the current metric queries; the
  historical miscount stays a separate data audit (P2/P3).
- Email-reply confirmation contract mismatch (one doc says 15-minute/same-
  thread; implementation reportedly non-expiring/anywhere in channel):
  owner decides intended behavior (D-011), spec updated through the release
  path, then tested.
- Legacy Block Kit plugin: confirm not installed/reachable → P3 cleanup.
  Reachable outside the durable boundary → escalate.

Regina:

- Email auto-send authorized by the owner (D-001, 2026-08-15). Verify the
  runtime flag/config matches that intent, and that every gate —
  suppression, provenance, language exclusion, already-contacted, caps —
  holds under autopilot with no per-message approval in the loop.
- WhatsApp and Airbnb-thread contacts always remain manual — verify no send
  path exists for them.
- Current eligibility SQL validated against invariants; historical cohort
  counts (39/10/2, 5-star set, 18-cancelled) are hypotheses, not expected
  truth.
- Do-not-contact, provenance, language exclusions (`language='es'` rules as
  currently implemented), dossier facts, already-contacted exclusion,
  `!sent`/`!skip`/`!defer`, anniversary scheduling with stable idempotency,
  Resend readback, aggregation, manual-attention paths.
- VIP/feedback campaigns: product backlog unless an enabled requirement and
  scheduled producer exist.

Split: QC-7a = Paulina. QC-7b = Regina.

Exit: every enabled transport matches its D-001 authority, suppression,
replay, and notification contract; no live recipient used for any violation
test.

### QC-8 — WhatsApp, Sarah Email, Meta DMs, Sarah Coach

Contingent on D-002. Goal: guest/customer communications validated without
fabricating sends.

- WhatsApp — owner-stated invariant (D-001, 2026-08-15): **no guest-bound
  send without a human-typed `!wa` in Slack.** Verify by attempted violation
  on fixtures: ordinary prose in `#whatsapp`, `!wa` from a wrong channel or
  unauthorized user, and any programmatic path (Regina, workflow retry,
  legacy route) that could reach the Twilio adapter without the command.
  Then: signature-before-acknowledgment; durable inbound event/outbox; sole
  `#whatsapp` human surface; exact `!wa` interception; serialized sends;
  retired direct routes unreachable; provider acceptance vs delivery states
  monotonic; read-only status reconciliation; no resend after acceptance.
  Prefer the next genuine inbound event as the canary.
- Sarah Email: Gmail + OwnerRez ingestion; one Slack root per provider
  conversation; all new Gmail visible with conservative CRM inquiry logic;
  direct-reply capture; provider selection from the inbound record;
  immutable proposal; same-user confirmation; execute-once effect; exact
  Gmail Sent or OwnerRez readback; local-projection retry without a second
  send.
- Email activity reads: live Gmail date-window truth and durable-ledger
  coverage reported separately; mailbox reads never mark messages read.
- Meta DM — owner does not recognize this feature (D-002, 2026-08-15). If
  QC-1 T7 found no send path: record v2's claim as unsubstantiated and move
  on. If a path exists: open F-020, treat intended state as disabled,
  quarantine it (prove unreachable, or disable via the release path with
  owner approval), and stop for an owner decision before any behavioral
  testing. Only if the owner then authorizes the feature: exact `!dm` only;
  retired HTTP sender unreachable; single provider ID; acceptance never
  labeled delivery.
- Sarah Coach: suggestion-only; voice-corpus retrieval works; no send path
  exists; outcome/edit capture correct.

Exit: all direct-message effects are command/confirmation constrained,
idempotent at the provider boundary, accurately labeled, passively or
explicitly canaried.

### QC-9 — OwnerRez and Paloma operations

- OwnerRez webhooks: reconcile the configured subscription manifest
  dynamically; test auth, durable acknowledgment, idempotency, retry,
  message projection.
- Contact sync verified independently from occupancy. CRM is not a booking
  mirror; full-occupancy reads go directly against OwnerRez — guestless
  reservations, blocks, holds, linked availability, date boundaries, weekly
  operations calendar.
- OwnerRez mutations: fixed current catalog, restricted users, immutable
  proposal, 15-minute expiry, same-user confirmation, fresh precondition,
  execute-once effect, operation-specific provider readback, notification,
  ambiguous-result manual review. No generic URL/method exposed.
- Paloma: dedicated Slack identity; dynamic joined-channel membership;
  immediate unmentioned-event delivery and ten-minute reconciliation as
  separate paths; exact source-timestamp idempotency;
  duplicate/out-of-order events; checkpoint advancement only after full
  channel success; future-checkpoint rejection; task lifecycle/audit rows;
  retry after partial failure; deterministic task queries; trusted
  sender/alias resolution; bilingual responses; weekly follow-up/summary;
  attention routing.
- `paloma/data/tasks.db` confirmed in the recovery matrix (QC-3 dependency).

Exit: OwnerRez remains the only booking authority; writes are guarded and
read back; Paloma ingestion/recovery/monitoring coverage complete.

### QC-10 — Remaining jobs, fault injection, soak, sign-off

- Remaining scope pulled from the generated inventory (voice/media
  ingestion, Chroma rebuild, warmup, Telmex, tracking reports, log
  rotation, backups, low-frequency jobs, every unassigned row). No
  handwritten stragglers list.
- Fault injection order: (1) FIXTURE — provider 5xx/timeouts, bad
  credentials, DB locks, duplicate webhooks, Slack outage, worker death
  before/after provider acceptance, lease expiry, outbox retry, conflicting
  review resolution. (2) Passive production canaries + provider/ledger
  reconciliation. (3) Only residual untestable risks proceed to approved
  CANARY/OUTAGE drills.
- Every live drill: named operator, maintenance window (D-004), current
  backup, no active conflicting effect, abort criteria, restore steps,
  post-drill reconciliation. After CRM/tunnel/reboot recovery: verify
  loaded SHA, queue convergence, drained outbox, zero duplicate provider
  effects, schedules, provider/local agreement. A same-host reboot proves
  restart behavior, not site-loss recovery (F-013 stays open until off-host
  RPO/RTO is defined and demonstrated).
- Remediation: every P0/P1 fix gets a regression test and focused
  production verification after the full release path. A relevant change
  resets only the affected soak window; never suppress an urgent fix to
  preserve a clean week.
- Soak by cadence: 5/10/15-minute and daily controls — 7 consecutive days.
  Weekly controls — two successful scheduled cycles. Monthly controls —
  several historical executions plus an approved safe simulation, or
  observation through a real cycle. Webhook/message paths — sufficient
  genuine/passive events or an approved provider test per state
  transition.
- Sign-off (roles per D-007): exact deployed merge SHA + deployment record;
  non-secret fingerprints for runtime policy/config, service manifest,
  schema, evidence index; every control PASS or justified N/A; zero open
  P0/P1 and zero inconclusive high-risk controls; P2/P3 residuals with
  owner + due date; Jason approves business authority; Sarah validates
  guest/email UX; accounting validation per D-007.
- Tag the exact deployed commit `qc-baseline-v1-YYYYMMDD`, paired with the
  baseline manifest. The tag alone cannot represent ignored runtime state.

Standing rule after baseline: every new workflow ships with an inventory
row and a verification block before it runs in production; CI/service-
manifest checks make drift detectable; each control gets a revalidation
cadence.

---

## 10. Findings and hypotheses — seed for `qc/RISK_HYPOTHESES.md` and `qc/FINDINGS.md`

Open findings (seed `FINDINGS.md`):

| ID | Sev | Status | Summary | Closure criteria |
|---|---|---|---|---|
| F-001 | P1 | validated (Amendment 2) | Machine-enforced creative/landing-review state absent from current code; historical spend-during-review incident validated the risk | Invariant implemented + regression test + verified at deployed SHA (QC-6) |
| F-005 | P1 | open (Amendment 1) | Autonomy authority unresolved: README/runtime edited by builder cannot self-grant standing send authority. Partially resolved 2026-08-15: owner granted auto-send for Paulina and Regina email and the human `!wa` command gate for WhatsApp (D-001) | Remaining D-001 rows recorded + runtime/docs/policy reconciled to D-001 + discrepancies dispositioned (QC-7 gate) |
| F-014 | P1 | validated (both reviews agree) | Weekly accounting control incomplete: `needs_slack_scan` non-terminal, exit-zero on error, legacy secret path on token refresh, no durable completion, watchdog gap | Seven terminal results + evidence IDs + nonzero failure semantics + canonical schedule + durable notification + watchdog coverage (QC-4) |

Hypotheses (seed `RISK_HYPOTHESES.md`; validate with current evidence before
assigning incident severity):

| ID | Summary | Disposition |
|---|---|---|
| F-002 | Advantage audience expansion contrary to brief | Provider-read regression check in QC-6 |
| F-003 | Self-referential pixel audience loop | Verify current audience/exclusion objects + shelved legacy state; historical traffic mix alone is not failure evidence (QC-6) |
| F-004 | Clicks counted as replies | Verify current metric queries in QC-7; historical-data audit at most P2 unless still driving decisions |
| F-006 | Multiple CRM DB paths | Reframed as path-contract integrity: `DB_PATH` vs `CRM_DB_PATH` vs hard-coded defaults (QC-3) |
| F-007 | Lead-form black hole (11,441 views / 0 submissions) | Form premise obsolete; test the current landing → WhatsApp → signed inbound → CRM/CAPI funnel (QC-6); historical form-era attribution loss = P3 data audit |
| F-008 | Paulina Block Kit plugin half-wired | P3 if confirmed uninstalled/unreachable; escalate if reachable outside the durable boundary (QC-7) |
| F-009 | Documentation drift | Retained, demonstrated blast radius: a QC plan built from docs was materially wrong within ~10 weeks. Sanitized overlay comparison; never copy private runtime contents into Git (QC-2) |
| F-010 | Legacy Meta account | Alias-only provider-read hypothesis: expect no recent spend, writes, registry, or workflow effects (QC-6) |
| F-011 | Slack helper consolidation incomplete | Re-derive current callers; severity depends on outbox/readback bypass vs formatting duplication (QC-2/7) |
| F-012 | VIP/feedback campaigns inert | Product/backlog decision unless an enabled requirement exists; not a baseline blocker (QC-7) |
| F-013 | Single-machine SPOF | P2 operational risk; closes only with defined off-host recovery + RPO/RTO, not a reboot (QC-3/10) |
| F-015 | Nonzero last exits on daily-tests / tracker-liveness / media-rescan; watchdog blind | Validate in QC-1 T4; expected P1 service-manifest finding |
| F-016 | Accounting test/keepalive jobs outside canonical template set; committed Paloma services not installed | Validate in QC-1; service-manifest convergence |
| F-017 | Daily runner can hide test/build/Slack-post failure and is not the full stack | QC-2/3 |
| F-018 | Backup path may diverge from CRM path; offsite retrieval untested; non-CRM state (Paloma tasks.db, policy, registry) lacks demonstrated coverage | QC-3 |
| F-019 | Tracker liveness tests the endpoint, not deployed page JS; cold-start can misread ad creation as delivery | QC-6 |
| F-020 | (Conditional) Any transport the owner did not knowingly authorize. Active candidate: Meta DM send path — owner does not recognize it (2026-08-15); opens if QC-1 T7 finds one | Opened on any "no"/"unknown" in D-002 confirmed against inventory; quarantine per QC-8 |
| F-021 | Private runtime overlays contain stale paths / mutation guidance; terminal tool guard is a compensating control, not a resolution | QC-2; fix via private-runtime change path |
| F-022 | Recent fixes (accounting, OwnerRez retry, WhatsApp status, email confirmation, Paloma query, redaction, deployment integrity) lack regression rows | Mandatory regression rows in their phases |

## 11. Owner decisions — seed for `qc/DECISIONS.md`

Answer inline. D-001 and D-002 block QC-0 exit; D-011 blocks part of QC-7a.

- **D-001 — Autonomy matrix** (blocks QC-7; informs QC-6/8). For each
  transport, state the intended gate — full autopilot / draft-and-approve /
  command-plus-confirm / manual only / disabled.
  **Recorded 2026-08-15 (owner):**
  WhatsApp guest sends — human command required. A human types `!wa` in
  Slack; no guest-bound WhatsApp message sends without that human-typed
  command, covering all guest-bound WhatsApp outbound including any Regina
  reactivation of WhatsApp-provenance contacts. This is the invariant QC-8
  attempts to violate.
  Paulina cold email — full autopilot; auto-send authorized. Regina
  reactivation email — full autopilot; auto-send authorized. All
  suppression, verification, provenance, cap, and fail-closed gates bind
  unchanged under autopilot.
  Meta DMs — owner does not recognize this feature; intended state is
  disabled/nonexistent (see D-002 and QC-1 T7).
  **Still open:** Regina Airbnb-thread contacts (default manual as built
  unless the owner states otherwise) · Sarah guest-correspondence replies —
  keep the proposal + same-user-confirmation flow, or auto-send those too? ·
  Meta campaign activation & budget increase · autonomous Meta
  pause/decrease · QBO writes · OwnerRez mutations · Postiz publishing.
- **D-002 — Transport authorization audit.** Confirm each was knowingly
  authorized.
  **Recorded 2026-08-15 (owner):** WhatsApp automation and its Slack
  integration — authorized; an important part of the current workflow.
  Sarah email automation (the outbound email surface Paulina and Regina
  send through) — authorized; auto-send intended. Squarespace commerce —
  authorized; intent is full integration with maximum read/write
  capability. Authority boundaries in QC-5 still apply: Squarespace never
  creates or edits OwnerRez bookings and never represents Airbnb/Vrbo
  payouts. Meta DM path — **owner does not recognize this as a feature**;
  if QC-1 T7 finds any Meta DM send path, open F-020, quarantine, and stop
  for an owner decision.
  **Still open:** owner cash-flow command (read-model surface).
- **D-003 — Max plan tier** (5x/20x) and typical usable session length →
  calibrates session sizing and phase splits.
- **D-004 — Blackout windows.** Live campaigns, warmup ramps, guest quiet
  hours; days/times when CANARY/OUTAGE/BUSINESS actions are forbidden.
- **D-005 — Reconciliation month** for QC-4 (one complete closed period).
- **D-006 — Restore-drill and offsite-retrieval approval** windows and
  targets (RPO/RTO per store).
- **D-007 — Sign-off roles.** Jason = business authority. Sarah = guest and
  email UX surfaces. Accounting reconciliation validator = ?
- **D-008 — Fix policy.** Proposed default: P0 contained immediately with
  explicit authorization; P1 fixed in a dedicated session through the full
  release path; P2/P3 batched; every fix carries a regression test and
  post-deploy production verification.
- **D-009 — Test identities and markers.** `[QC TEST]` prefix in production
  channels vs a `#qc-scratch` channel; allowlisted test email addresses and
  phone numbers for CANARY actions.
- **D-010 — Corporate Intelligence:** boundary/no-leakage check only;
  content audited separately under privileged controls. Confirm.
- **D-011 — Paulina email-reply confirmation semantics.** 15-minute
  same-thread (per one command doc) vs non-expiring same-channel (per
  reported implementation). Pick one; spec is updated through the release
  path, then tested.

## 12. Definition of done

The QC baseline is complete only when:

1. Every discovered workflow, producer, data store, provider boundary, and
   user-facing control is PASS or explicitly N/A in `CONTROL_MATRIX.md`.
2. The QC-1 tripwire scorecard is recorded and its consequences applied.
3. Zero open P0/P1 findings and zero inconclusive high-risk controls —
   including F-001, F-005, F-014 verified-fixed or explicitly accepted-risk
   by the owner in `DECISIONS.md`.
4. Every repair is deployed and reverified at the exact production SHA.
5. High-risk effects reconcile provider truth, durable evidence/effect,
   local projection, and Slack wording.
6. Exactly one intended producer owns every mutation path.
7. Critical data meets approved RPO/RTO with a successful off-host retrieval
   and disposable restore where applicable.
8. Stack check, dependency/security checks, CI verify, release check,
   deployment record, runtime health, clean `main`, and local/remote SHA all
   agree.
9. Cadence-appropriate soak completes (daily ×7 days, weekly ×2 cycles,
   monthly by history + simulation or a real cycle).
10. Residual P2/P3 risks have an owner, a due date, and an accepted-risk
    decision; the baseline manifest and CI/service-manifest checks make
    future drift detectable; every control has a revalidation cadence.

Tag `qc-baseline-v1-YYYYMMDD` on the exact deployed commit, paired with the
baseline manifest.
