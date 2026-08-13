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

The five-minute Gmail reply forwarder is also the complete Sarah mailbox
ledger once the `sarah-email` policy channel exists. The former 15-minute
`inbound-email-scanner` LaunchAgent is retired by the guarded Sarah email
cutover and has no committed template.
