# LaunchAgents

The `templates/` directory is the complete macOS service schedule for the
resort stack: CRM, tunnel, heartbeats, reporting, backups, media/voice jobs,
Prospector, Regina, warmup, and monitoring.

Templates use `__SOCIALSOL_ROOT__`, `__NODE_BIN__`, and `__PYTHON_BIN__`
placeholders. Render them with:

```bash
npm run init:runtime
npm run render:launchagents
```

Generated files go to ignored `deploy/launchagents/generated/`. Rendering does
not install or load them. Compare generated definitions with currently loaded
jobs before any cutover.

## GitHub autosave

`com.lapuestadelsolresort.github-autosave` runs every 30 minutes and snapshots
all Git-eligible changes to `origin/autosave/macmini`. It uses an isolated Git
index, so it does not switch branches, stage files, or alter the working tree.
Ignored runtime data remains excluded. A secret scan and a 10 MiB per-file
limit must pass before a snapshot can be pushed.

Test the snapshot safely before installing the rendered LaunchAgent:

```bash
npm run autosave:dry-run
```

The autosave branch is a recovery stream, not a replacement for reviewed
commits on `main`. Promote finished work through normal tested commits and pull
requests. Logs are written to ignored `logs/github-autosave.log` and
`logs/github-autosave.err`.
