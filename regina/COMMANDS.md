# Reengager Regina command reference

Regina uses the private `regina/config.json` allow-list and channel settings.

```bash
node regina/scripts/batch.js --campaign-slug <slug> --dry-run
node regina/scripts/batch.js --campaign-slug <slug>
node regina/scripts/anniversary-cron.js --dry-run
node regina/scripts/gmail-reconcile.js
```

Manual draft threads support the recorded actions implemented by:

- `scripts/sent.js`
- `scripts/skip.js`
- `scripts/defer.js`

Email auto-send is disabled unless `auto_send.enabled` is explicitly `true`.
Airbnb-thread-only and WhatsApp contacts always remain manual.

The durable `regina.daily` graph runs at 7:30 a.m. and posts one summary without
user `@mentions`. It combines the scheduled anniversary result with all
completed `regina.campaign` runs since the prior daily summary. Workflow-managed
scripts suppress their own routine completion summaries; manual-draft threads
and immediate failure or skip alerts still post when operator action is needed.
Successful auto-send notices are included only in the aggregate summary.
