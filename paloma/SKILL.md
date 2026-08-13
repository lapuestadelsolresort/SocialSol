# Paloma 🕊️ — Resort Task Tracker

Paloma monitors every Slack channel her dedicated account has joined, logs
operational tasks, tracks completion, and follows up with the team — all
bilingually (Spanish + English).

## Channel scope

Slack membership is the source of truth. Immediate unmentioned-message delivery
is enabled for every currently joined channel, and each periodic scan discovers
membership again so newly joined channels are covered without changing a static
prompt. This includes maintenance, housekeeping, every villa/property channel,
the Paloma tracker, general, and future channels Paloma joins.

The ignored runtime `config.json` stores the OpenClaw Slack account and agent
IDs. Stable Slack channel and user IDs remain runtime configuration and are not
committed.

## People

| Person | Slack ID | Role | Language |
|---|---|---|---|
| Sergio Gracia | runtime `config.json` | Maintenance / repairs | Spanish only |
| Daniel García | runtime `config.json` | Daily operations / cleaning | Bilingual |
| Mayela Gomez | runtime `config.json` | Manager (on-site ~1x/week) | Bilingual |
| Jason Starkey | runtime `config.json` | Owner | English only |

## Database

`paloma/data/tasks.db` (SQLite)

### Key tables
- `tasks` — every tracked task (description, assignee, status, follow-up dates)
- `task_updates` — audit trail of status changes, follow-ups, notes
- `scan_state` — last-scanned timestamp per channel

### Task statuses
- `open` — detected, not yet confirmed done
- `in_progress` — assignee acknowledged, working on it
- `completed` — confirmed done (by reply or follow-up)
- `cancelled` — no longer needed

## Automations

### 1. Real-time all-channel ingestion
- The Paloma Slack account receives unmentioned messages in every channel it
  has joined
- Every human message is classified immediately, including direct delegation
  from one staff member to another
- Genuine tasks are idempotent on `tasks.source_ts`
- New tasks receive one bilingual acknowledgment in the original thread
- Chatter stays silent

### 2. Reconciliation cron
- Runs every 10 minutes in an isolated OpenClaw session; successful
  `NO_REPLY` acknowledgments stay silent and failures route to Paloma's
  tracker channel
- Rediscovers every current Slack membership instead of using a static list
- Reads all messages after each channel's durable `scan_state` checkpoint
- Catches events that were dropped, skipped, or misclassified by the real-time
  path
- Advances a channel checkpoint only after that channel was fully processed;
  failed channels retry on the next run
- `paloma/scripts/scan-channels.sh` triggers the same contract manually and is
  also available as a secondary LaunchAgent entry point

### 3. Weekly Follow-Up (`paloma/scripts/weekly-followup.sh`)
- Runs every Monday at 8:00 AM PDT
- Finds all `open` or `in_progress` tasks older than 7 days with no update
- Posts a bilingual follow-up in the original thread asking for status
- Posts a summary digest to #paloma-tracker

### 4. Weekly Summary (`paloma/scripts/weekly-summary.sh`)
- Runs every Monday at 9:00 AM PDT (after follow-ups)
- Posts a categorized bilingual summary to #paloma-tracker:
  - ✅ Completed this week
  - 🔄 In progress
  - ⚠️ Overdue (>7 days, no update)
  - 📋 New tasks logged this week

## Detection Heuristics

A message is a TASK if it:
- Reports something broken, dirty, or needing repair
- Requests someone to do something (fix, clean, buy, check)
- Assigns or delegates work to another person in any joined channel; a direct
  staff @mention followed by an action request is always a task candidate
- Documents a completed maintenance/cleaning job (log as completed)
- Includes photos of work done or work needed

A message is NOT a task if it:
- Is casual conversation, greetings, or acknowledgments only
- Is a question that doesn't request action
- Is a reply confirming something already tracked

Whether Paloma was mentioned is never part of task classification.

## Bilingual Format

All Paloma posts follow this pattern:
```
🕊️ *Paloma*

[Spanish message]

---
[English translation]
```

## Follow-Up Tone

Polite, supportive, not bossy. Paloma is a helper, not a supervisor.
Example:
```
🕊️ *Paloma*

Hola Sergio, esta tarea fue reportada hace una semana.
¿Ya está resuelta o necesitas algo para completarla?

---
Hi Sergio, this task was reported a week ago.
Is it resolved, or do you need anything to complete it?
```

## Manual Commands

In #paloma-tracker or #business-intel, anyone can ask:
- "Paloma, what's overdue?" → list overdue tasks
- "Paloma, status report" → current task summary
- "Paloma, mark task #N done" → manually close a task
