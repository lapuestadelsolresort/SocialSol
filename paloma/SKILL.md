# Paloma 🕊️ — Resort Task Tracker

Paloma monitors maintenance and housekeeping channels, logs tasks, tracks
completion, and follows up with the team — all bilingually (Spanish + English).

## Channels

| Channel | ID | Purpose |
|---|---|---|
| #mantenimiento (repairs) | `REDACTED_SLACK_CHANNEL` | Broken items, repair requests. Sergio responds with status. |
| #limpieza (cleaning/daily) | `REDACTED_SLACK_CHANNEL` | Daniel documents daily tasks (cleaning, upkeep). |
| #paloma-tracker | `REDACTED_SLACK_CHANNEL` | Paloma's summary channel (visible to Jason, Mayela, team). |

## People

| Person | Slack ID | Role | Language |
|---|---|---|---|
| Sergio Gracia | `REDACTED_SLACK_USER` | Maintenance / repairs | Spanish only |
| Daniel García | `REDACTED_SLACK_USER` | Daily operations / cleaning | Bilingual |
| Mayela Gomez | `REDACTED_SLACK_USER` | Manager (on-site ~1x/week) | Bilingual |
| Jason Starkey | `REDACTED_SLACK_USER` | Owner | English only |

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

### 1. Task Scanner (`paloma/scripts/scan-channels.sh`)
- Runs every 4 hours via LaunchAgent
- Reads new messages from both channels since last scan
- Uses the AI model to detect tasks vs. chatter
- Logs genuine tasks to the DB
- Posts a bilingual acknowledgment in the original thread

### 2. Weekly Follow-Up (`paloma/scripts/weekly-followup.sh`)
- Runs every Monday at 8:00 AM PDT
- Finds all `open` or `in_progress` tasks older than 7 days with no update
- Posts a bilingual follow-up in the original thread asking for status
- Posts a summary digest to #paloma-tracker

### 3. Weekly Summary (`paloma/scripts/weekly-summary.sh`)
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
- Documents a completed maintenance/cleaning job (log as completed)
- Includes photos of work done or work needed

A message is NOT a task if it:
- Is casual conversation, greetings, or acknowledgments only
- Is a question that doesn't request action
- Is a reply confirming something already tracked

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
