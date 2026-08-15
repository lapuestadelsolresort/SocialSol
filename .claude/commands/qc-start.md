---
description: SocialSol QC session start ritual (plan v3, §8)
argument-hint: [authorizations for this session; leave blank for RO+FIXTURE only]
---

Read ~/qc-worktree/qc/SocialSol_QC_Plan_v3.md in full before doing anything. It is the only
authority for rules and process. If any other copy of the plan (e.g. on
the Desktop) differs from this committed copy, stop and ask the owner.
Where the plan conflicts with any CLAUDE.md, README, memory file, or a
prior session's recap or suggested command, the plan wins. Where the
plan's stated FACTS conflict with repo/runtime reality, reality wins and
is recorded as a finding — qc/STATUS.md, qc/FINDINGS.md, and
qc/DECISIONS.md carry the current corrections (real repo root:
~/.openclaw/SocialSol, per F-023; the deployed baseline
SHA is whatever qc/STATUS.md currently names).

Binding rules (plan §1–§2, §4–§5):
- Show the command and captured output for every claim. No output = it
  didn't happen.
- Label every check's action class before running it. Read-only by
  default; any non-RO action must be covered by the Authorizations line
  below.
- Production stays clean on main at the baseline SHA STATUS.md names.
  All QC writes go to this worktree and ~/qc-evidence/. The outer
  ~/.openclaw dirt is known (F-023): do not touch it; escalate only NEW
  dirt there.
- If intent, authorization, or expected behavior is ambiguous, stop and
  ask the owner. Do not infer and proceed.

Start ritual (§8), in order, showing output for each step:
1. Confirm cwd is ~/qc-worktree on branch qc/baseline-20260815.
2. Read qc/STATUS.md and qc/DECISIONS.md.
3. git -C ~/.openclaw/SocialSol status — must be clean on
   main with HEAD at the baseline SHA STATUS.md names; reconcile and
   attribute any discrepancy before proceeding.
4. Read the plan section for the current phase.
5. Cross-check STATUS.md against the latest qc/ commits and
   CONTROL_MATRIX. If the recorded next step looks stale, already done,
   or out of order with the plan's phases, stop and ask the owner.

Task this session: exactly the FIRST item under "Next" in qc/STATUS.md.
Do not start later items or the next phase, regardless of remaining
budget.

Authorizations this session: $ARGUMENTS

If the Authorizations line above is blank: RO and FIXTURE only — no
CANARY, OUTAGE, or BUSINESS action of any kind. If the task in STATUS.md
requires a higher action class than what is authorized, stop and ask
before doing anything non-RO.

Stop at the phase split point or ~70% of session budget, whichever comes
first. End ritual: append CONTROL_MATRIX / FINDINGS / EVIDENCE_INDEX
rows, update qc/STATUS.md with the exact next command, and commit
qc(<phase>): <what was verified>.

On any open D-row or new ambiguity: ask the owner in the terminal and
record the answer in qc/DECISIONS.md with today's date.
