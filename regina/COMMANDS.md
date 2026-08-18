# Reengager Regina command reference

Regina uses the private `regina/config.json` allow-list and channel settings.

```bash
node regina/scripts/batch.js --campaign-slug <slug> --dry-run
node regina/scripts/batch.js --campaign-slug <slug>
node regina/scripts/anniversary-cron.js --dry-run
node regina/scripts/gmail-reconcile.js
```

Recorded actions on a manual draft — **operator terminal only**. These three
scripts are run from a shell against a draft's Slack `thread_ts`; there is no
Slack dispatch path, so typing `!sent` / `!skip` / `!defer` in a draft thread
does nothing (F-048). They write to the DB and post a thread ack; they have no
send capability.

```bash
node regina/scripts/sent.js  --slack-thread-ts <ts> [--message '<edited text> !sent'] [--slack-user-id <id>]
node regina/scripts/skip.js  --slack-thread-ts <ts> [--message '!skip']
node regina/scripts/defer.js --slack-thread-ts <ts> --message '!defer <days>'
```

`--message` carries the operator text the script parses: `sent.js` measures
edit distance against the draft, and `defer.js` reads the day count from a
leading `!defer <N>` (1–365). `--slack-channel-id` defaults to
`regina/config.json` `slack.channel_id`.

In practice the loop closes without them: `gmail-reconcile.js` auto-marks
manual email drafts from Gmail Sent evidence, and reminds on drafts still
stuck after 14 days, auto-rejecting after three reminders.

Email auto-send is disabled unless `auto_send.enabled` is explicitly `true`.
Airbnb-thread-only and WhatsApp contacts always remain manual.

The durable `regina.daily` graph runs at 7:30 a.m. and posts one summary without
user `@mentions`. It combines the scheduled anniversary result with all
completed `regina.campaign` runs since the prior daily summary. Workflow-managed
scripts suppress their own routine completion summaries; manual-draft threads
and immediate failure or skip alerts still post when operator action is needed.
Successful auto-send notices are included only in the aggregate summary.
