#!/bin/bash
# Sender warmup — daily driver.
# Runs at 8:30am Pacific weekdays via LaunchAgent.
# 1. Generates prior-day Slack report
# 2. Checks for bounces/complaints (pauses if any)
# 3. Schedules the day's sends with random delays across 9am-5pm window
#
# Usage:
#   warmup-daily.sh           # normal run
#   warmup-daily.sh --dry-run # print plan without sending

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOCIALSOL_ROOT="${SOCIALSOL_ROOT:-$REPO_ROOT}"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-$SOCIALSOL_ROOT/secrets}"
WARMUP_DIR="$SOCIALSOL_ROOT/warmup"
SECRETS="$SECRETS_DIR/resend.json"
STATE="$WARMUP_DIR/state.json"
RECIPIENTS="$WARMUP_DIR/recipients.json"
TEMPLATES="$WARMUP_DIR/templates.json"
SENDS_LOG="$WARMUP_DIR/sends.jsonl"
EVENTS_LOG="$WARMUP_DIR/events.jsonl"
HC_PING="$SOCIALSOL_ROOT/crm/scripts/healthcheck-ping.sh"
OPENCLAW="${OPENCLAW_BIN:-/opt/homebrew/bin/openclaw}"
SLACK_CHANNEL="${PROSPECTOR_SLACK_CHANNEL:?Set PROSPECTOR_SLACK_CHANNEL}"
SLACK_ACCOUNT="${OPENCLAW_SLACK_ACCOUNT:?Set OPENCLAW_SLACK_ACCOUNT}"

DRY_RUN="${1:-}"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

trap '"$HC_PING" warmup-daily fail 2>/dev/null; exit 1' ERR

# ── Volume schedule ──────────────────────────────────────────────────────────
VOLUME=(0 3 4 5 6 7 8 10 12 14 16 18 20 22 25)
MAX_PER_RECIPIENT=4

# ── Load state ───────────────────────────────────────────────────────────────
CURRENT_DAY=$(jq -r '.current_day' "$STATE")
PAUSED=$(jq -r '.paused' "$STATE")
STARTED=$(jq -r '.started_at' "$STATE")

if [ "$PAUSED" = "true" ]; then
  log "⏸️  Warmup is PAUSED. Skipping sends. Posting status only."
fi

if [ "$CURRENT_DAY" -gt 14 ]; then
  log "✅ Warmup complete (day $CURRENT_DAY > 14). Nothing to do."
  "$HC_PING" warmup-daily 2>/dev/null || true
  exit 0
fi

# ── Check for weekend ────────────────────────────────────────────────────────
DOW=$(date +%u)  # 1=Mon, 7=Sun
if [ "$DOW" -ge 6 ]; then
  log "Weekend (day $DOW). Skipping."
  "$HC_PING" warmup-daily 2>/dev/null || true
  exit 0
fi

# ── Prior-day report ─────────────────────────────────────────────────────────
YESTERDAY=$(date -v-1d '+%Y-%m-%d')
SENT_YESTERDAY=$({ grep "\"day\":$((CURRENT_DAY - 1))" "$SENDS_LOG" 2>/dev/null || true; } | wc -l | tr -d ' ')

# Count events from yesterday
DELIVERED=$({ grep "$YESTERDAY" "$EVENTS_LOG" 2>/dev/null || true; } | { grep '"type":"email.delivered"' || true; } | wc -l | tr -d ' ')
OPENED=$({ grep "$YESTERDAY" "$EVENTS_LOG" 2>/dev/null || true; } | { grep '"type":"email.opened"' || true; } | wc -l | tr -d ' ')
BOUNCED=$({ grep "$YESTERDAY" "$EVENTS_LOG" 2>/dev/null || true; } | { grep '"type":"email.bounced"' || true; } | wc -l | tr -d ' ')
COMPLAINED=$({ grep "$YESTERDAY" "$EVENTS_LOG" 2>/dev/null || true; } | { grep '"type":"email.complained"' || true; } | wc -l | tr -d ' ')

REPORT="📊 *Warmup Day $((CURRENT_DAY - 1)) Report* ($YESTERDAY)
• Sent: $SENT_YESTERDAY
• Delivered: $DELIVERED
• Opened: $OPENED
• Bounced: $BOUNCED
• Complained: $COMPLAINED
• Current day: $CURRENT_DAY of 14"

log "$REPORT"

# ── Bounce/complaint check ───────────────────────────────────────────────────
if [ "$BOUNCED" -gt 0 ] || [ "$COMPLAINED" -gt 0 ]; then
  REPORT="🚨 *CRITICAL: Warmup paused* — $BOUNCED bounce(s), $COMPLAINED complaint(s) yesterday.
Sends halted until an operator confirms. Run: jq '.paused = false' state.json > tmp && mv tmp state.json"
  log "$REPORT"
  jq '.paused = true' "$STATE" > "${STATE}.tmp" && mv "${STATE}.tmp" "$STATE"
  # Post to Slack
  "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" -m "$REPORT" 2>/dev/null || true
  "$HC_PING" warmup-daily fail 2>/dev/null || true
  exit 1
fi

# Post normal report to Slack (only if day > 1, i.e., there's history)
if [ "$CURRENT_DAY" -gt 1 ]; then
  "$OPENCLAW" message send --channel slack --account "$SLACK_ACCOUNT" --target "$SLACK_CHANNEL" -m "$REPORT" 2>/dev/null || true
fi

# ── Exit if paused ───────────────────────────────────────────────────────────
if [ "$PAUSED" = "true" ]; then
  "$HC_PING" warmup-daily 2>/dev/null || true
  exit 0
fi

# ── Plan today's sends ──────────────────────────────────────────────────────
TODAY_VOLUME=${VOLUME[$CURRENT_DAY]}
log "Day $CURRENT_DAY: planning $TODAY_VOLUME sends"

# Load recipient list
RECIPIENT_COUNT=$(jq 'length' "$RECIPIENTS")
TEMPLATE_COUNT=$(jq 'length' "$TEMPLATES")

# Build send plan using python for better randomization
PLAN=$(python3 -c "
import json, random, sys

with open('$RECIPIENTS') as f: recipients = json.load(f)
with open('$TEMPLATES') as f: templates = json.load(f)

volume = $TODAY_VOLUME
max_per = $MAX_PER_RECIPIENT
day = $CURRENT_DAY

# Read already-used templates today (avoid repeats within a day)
used_templates = set()

# Filter out recipients who were sent to in the last 24 hours (catches manual sends)
import datetime
recent_recipients = set()
try:
    with open('$SENDS_LOG') as f:
        for line in f:
            line = line.strip()
            if not line: continue
            entry = json.loads(line)
            ts = datetime.datetime.fromisoformat(entry['ts'].replace('Z','+00:00'))
            if (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds() < 86400:
                recent_recipients.add(entry['recipient'])
except (FileNotFoundError, json.JSONDecodeError):
    pass

available_recipients = [r for r in recipients if r['email'] not in recent_recipients]
if not available_recipients:
    available_recipients = list(recipients)  # fallback if everyone was sent to recently

# Distribute across recipients
# Days 1-6 (volume <= recipient count): unique recipients only
# Days 7+: allow duplicates, cap at max_per per recipient
selected = []
if day <= 6:
    pool = list(available_recipients)
    random.shuffle(pool)
    selected = pool[:volume]
else:
    pool = []
    for r in recipients:
        already = sum(1 for e in recent_recipients if e == r['email'])
        remaining = max(max_per - already, 0)
        pool.extend([r] * remaining)
    random.shuffle(pool)
    counts = {}
    for r in pool:
        if len(selected) >= volume:
            break
        email = r['email']
        if counts.get(email, 0) >= max_per:
            continue
        counts[email] = counts.get(email, 0) + 1
        selected.append(r)
    while len(selected) < volume:
        selected.append(random.choice(recipients))

random.shuffle(selected)

# Assign templates (avoid back-to-back same template)
assignments = []
last_tid = None
for r in selected:
    available = [t for t in templates if t['id'] != last_tid and t['id'] not in used_templates]
    if not available:
        used_templates.clear()
        available = [t for t in templates if t['id'] != last_tid]
    t = random.choice(available)
    used_templates.add(t['id'])
    last_tid = t['id']
    assignments.append({'email': r['email'], 'name': r.get('name',''), 'template_id': t['id'], 'subject': t['subject'], 'body': t['body']})

# Generate random send times between 9am and 5pm (540-1020 min from midnight)
# with 20-90 minute gaps
times = []
t = random.randint(540, 570)  # start between 9:00-9:30
for i in range(volume):
    times.append(t)
    t += random.randint(20, 90)
    if t > 1020:  # cap at 5pm
        t = 1020

for i, a in enumerate(assignments):
    h = times[i] // 60
    m = times[i] % 60
    a['send_time'] = f'{h:02d}:{m:02d}'

print(json.dumps(assignments))
")

if [ "$DRY_RUN" = "--dry-run" ]; then
  log "DRY RUN — would send:"
  echo "$PLAN" | python3 -c "
import json, sys
plan = json.load(sys.stdin)
for i, s in enumerate(plan):
    body_preview = s['body'].replace('{name}', s['name']).replace('{time_ref}', 'this afternoon')[:60]
    print(f\"  {i+1}. {s['send_time']} → {s['email']} | subj: \\\"{s['subject']}\\\" | tpl: {s['template_id']}\")
    print(f\"     {body_preview}...\")
print(f\"\\nTotal: {len(plan)} sends for day $CURRENT_DAY\")
"
  exit 0
fi

# ── Execute sends with delays ───────────────────────────────────────────────
API_KEY=$(jq -r '.api_key' "$SECRETS")
FROM=$(jq -r '.default_from_email' "$SECRETS")
FROM_NAME=$(jq -r '.default_from_name' "$SECRETS")

echo "$PLAN" | python3 -c "
import json, sys
plan = json.load(sys.stdin)
for p in plan:
    print(json.dumps(p))
" | while IFS= read -r send; do
  EMAIL=$(echo "$send" | jq -r '.email')
  NAME=$(echo "$send" | jq -r '.name')
  TEMPLATE_ID=$(echo "$send" | jq -r '.template_id')
  SUBJECT=$(echo "$send" | jq -r '.subject')
  BODY=$(echo "$send" | jq -r '.body')
  SEND_TIME=$(echo "$send" | jq -r '.send_time')

  # Parameter variation
  BODY=$(echo "$BODY" | sed "s/{name}/$NAME/g")

  # Calculate delay until send_time
  NOW_MIN=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
  SEND_H=${SEND_TIME%%:*}
  SEND_M=${SEND_TIME##*:}
  TARGET_MIN=$(( 10#${SEND_H} * 60 + 10#${SEND_M} ))
  DELAY=$(( TARGET_MIN - NOW_MIN ))
  if [ "$DELAY" -gt 0 ]; then
    log "Waiting ${DELAY}m until $SEND_TIME for $EMAIL..."
    sleep $(( DELAY * 60 ))
  fi

  # Send via Resend API
  log "Sending to $EMAIL (template: $TEMPLATE_ID)..."
  RESPONSE=$(curl -s -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg from "$FROM_NAME <$FROM>" \
      --arg to "$EMAIL" \
      --arg subject "$SUBJECT" \
      --arg text "$BODY" \
      --arg reply_to "$FROM" \
      '{from: $from, to: [$to], subject: $subject, text: $text, reply_to: $reply_to}')")

  EMAIL_ID=$(echo "$RESPONSE" | jq -r '.id // empty')

  if [ -n "$EMAIL_ID" ]; then
    log "✅ Sent to $EMAIL — ID: $EMAIL_ID"
    echo "{\"ts\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"recipient\":\"$EMAIL\",\"template_id\":\"$TEMPLATE_ID\",\"email_id\":\"$EMAIL_ID\",\"day\":$CURRENT_DAY}" >> "$SENDS_LOG"
  else
    log "⚠️  Send to $EMAIL may have failed: $RESPONSE"
    echo "{\"ts\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"recipient\":\"$EMAIL\",\"template_id\":\"$TEMPLATE_ID\",\"email_id\":null,\"error\":$(echo "$RESPONSE" | jq -c '.'),\"day\":$CURRENT_DAY}" >> "$SENDS_LOG"
  fi
done

# ── Update state ─────────────────────────────────────────────────────────────
NEXT_DAY=$((CURRENT_DAY + 1))
NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
if [ "$STARTED" = "null" ]; then
  jq --arg now "$NOW_ISO" --argjson next "$NEXT_DAY" --argjson day "$CURRENT_DAY" \
    '.current_day = $next | .started_at = $now | .completed_days += [$day]' "$STATE" > "${STATE}.tmp" && mv "${STATE}.tmp" "$STATE"
else
  jq --argjson next "$NEXT_DAY" --argjson day "$CURRENT_DAY" \
    '.current_day = $next | .completed_days += [$day]' "$STATE" > "${STATE}.tmp" && mv "${STATE}.tmp" "$STATE"
fi

log "Day $CURRENT_DAY complete. State updated to day $NEXT_DAY."

# ── Healthcheck ping ────────────────────────────────────────────────────────
"$HC_PING" warmup-daily 2>/dev/null || true

log "========================================="
