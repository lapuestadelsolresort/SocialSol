# Production releases

The Mac mini's primary SocialSol checkout is the serving checkout. Local
`main` is the only production branch; GitHub `origin/main` is the current
recoverable source copy. Feature work belongs in a `codex/*` branch and pull
request, including changes requested through Slack.

## Normal release

1. Make and test the change in a branch or Codex worktree.
2. Open a pull request. GitHub CI runs `npm run check:stack`.
3. Merge only after the `verify` check succeeds.
4. In the serving checkout, fetch and fast-forward to the reviewed commit.
5. Run the guarded release check and deployment:

```bash
cd <production-checkout>
git status --short
git fetch origin
git merge --ff-only origin/main
npm run release:check
npm run release:deploy
```

`release:check` and `release:deploy` refuse to proceed unless all of these are
true:

- the command is running from the primary checkout, not a linked worktree;
- the checked-out branch is `main`;
- tracked and untracked Git state is clean (ignored runtime overlays are
  expected and remain outside Git);
- local `HEAD` exactly equals `origin/main`;
- the newest GitHub Actions `verify` check for that exact commit succeeded.

The deploy command also takes an exclusive ignored runtime lock, creates and
restore-tests the encrypted CRM backup, installs the lockfile dependencies,
runs the entire stack locally, renders LaunchAgents, restarts CRM and the
workflow worker, verifies CRM and workflow health, and writes a mode-600 JSON
record under `runtime/deployments/`. It does not install new LaunchAgents,
change workflow authority, or perform a domain cutover; those remain explicit
operations in `workflow/CUTOVER.md`.

Do not edit production source files in place. If a hot fix is needed, create a
branch/PR and follow the same path. If a change starts in Slack, ask the agent
to use a separate worktree, commit it to a `codex/*` branch, and complete the
PR/CI/merge/deploy path; never let the Slack agent switch the serving checkout
or leave a persistent source edit there. A feature-branch push is an
intermediate checkpoint, not a completed release, unless the requester
explicitly asks the agent to stop there.

The scheduled workflow-health check treats a non-`main` serving checkout or
any tracked/untracked source change as a hard failure. Ignored runtime overlays
remain outside that check.

## Failure handling

If validation fails before service restart, production processes remain on the
previous in-memory code. Fix the problem in a new PR; do not bypass a failed
check. If a service health check fails after restart, use the deployment JSON
record and Git history to identify the exact commit, restore service, and
revert through a PR. Runtime databases are not rolled back with application
code.

The deploy lock is removed automatically. If the process was killed and left a
lock behind, first confirm the recorded PID is not running, then use:

```bash
node scripts/production-release.js unlock --confirm-stale-lock
```

Never delete the lock merely because a deployment is slow.

## Small-change steady state

Keep changes small enough that one PR has one operational purpose. Each PR body
should state what changed, why, root cause, production impact, tests, and any
cutover/rollback steps. This produces a permanent sequence:

```text
request → codex/* branch → local tests → PR → GitHub CI → merge
        → fast-forward production main → guarded deploy → Slack validation
```

Slack validation is business feedback, not a replacement for CI or provider
readback. Any follow-up becomes the next small PR.
