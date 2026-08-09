'use strict';

const {
  calendarWeeksSinceFirstSend,
  capForWeek,
  startOfCurrentCalendarWeekPT,
} = require('./compliance');

function ptDateParts(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

function ptMidnightIso(year, month, day) {
  const date = `${year}-${month}-${day}`;
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  });
  const offsetPart = offsetFormatter
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  const offsetHours = Number(String(offsetPart || 'GMT-8').replace('GMT', ''));
  const sign = offsetHours >= 0 ? '+' : '-';
  const absolute = String(Math.abs(offsetHours)).padStart(2, '0');
  return new Date(`${date}T00:00:00${sign}${absolute}:00`).toISOString();
}

function startOfCurrentDayPT(now = new Date()) {
  const parts = ptDateParts(now);
  return ptMidnightIso(parts.year, parts.month, parts.day);
}

function startOfNextDayPT(now = new Date()) {
  const parts = ptDateParts(now);
  const cursor = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return ptMidnightIso(
    String(cursor.getUTCFullYear()),
    String(cursor.getUTCMonth() + 1).padStart(2, '0'),
    String(cursor.getUTCDate()).padStart(2, '0'),
  );
}

function dailyTargetForWeek(config, weekIndex) {
  const weeklyCap = capForWeek(config, weekIndex);
  if (typeof weeklyCap !== 'number') return null;
  const sendDays = Math.max(1, Number(config.orchestrator?.send_days_per_week ?? 5));
  return Math.ceil(weeklyCap / sendDays);
}

async function calculateDailyCapacity(db, sql, config, campaign, now = new Date()) {
  const weekIndex = calendarWeeksSinceFirstSend(campaign.first_send_at, now) + 1;
  const weeklyCap = capForWeek(config, weekIndex);
  const dailyTarget = dailyTargetForWeek(config, weekIndex);
  if (typeof weeklyCap !== 'number' || typeof dailyTarget !== 'number') {
    throw new Error(`No weekly send cap configured for campaign week ${weekIndex}`);
  }

  const weekStart = startOfCurrentCalendarWeekPT(now);
  const weekEnd = startOfCurrentCalendarWeekPT(new Date(new Date(weekStart).getTime() + 8 * 24 * 60 * 60 * 1000));
  const dayStart = startOfCurrentDayPT(now);
  const dayEnd = startOfNextDayPT(now);

  // Sent rows always consume capacity, including terminal bounce/complaint
  // statuses. Approved scheduled rows reserve a future slot. Pending drafts
  // created today also consume today's composition budget so rerunning the
  // automation cannot generate duplicate daily volume after an approval fault.
  const [{ n: weeklyCommitted }] = await db.query(sql`
    SELECT COUNT(*) AS n
    FROM outreach_sends
    WHERE campaign_id = ${campaign.id}
      AND (
        (sent_at IS NOT NULL
          AND datetime(sent_at) >= datetime(${weekStart})
          AND datetime(sent_at) < datetime(${weekEnd}))
        OR
        (sent_at IS NULL AND status IN ('approved','pending_approval')
          AND scheduled_at IS NOT NULL
          AND datetime(scheduled_at) >= datetime(${weekStart})
          AND datetime(scheduled_at) < datetime(${weekEnd}))
      )
  `);

  const [{ n: dailyCommitted }] = await db.query(sql`
    SELECT COUNT(*) AS n
    FROM outreach_sends
    WHERE campaign_id = ${campaign.id}
      AND (
        (sent_at IS NOT NULL
          AND datetime(sent_at) >= datetime(${dayStart})
          AND datetime(sent_at) < datetime(${dayEnd}))
        OR
        (sent_at IS NULL AND scheduled_at IS NOT NULL
          AND status IN ('approved','pending_approval')
          AND datetime(scheduled_at) >= datetime(${dayStart})
          AND datetime(scheduled_at) < datetime(${dayEnd}))
        OR
        (status = 'pending_approval'
          AND datetime(created_at) >= datetime(${dayStart})
          AND datetime(created_at) < datetime(${dayEnd}))
      )
  `);

  const maxBatch = Math.max(1, Number(config.composer?.compose_batch_max_n ?? dailyTarget));
  const batchSize = Math.max(0, Math.min(
    maxBatch,
    dailyTarget - Number(dailyCommitted),
    weeklyCap - Number(weeklyCommitted),
  ));

  return {
    campaign_slug: campaign.slug,
    campaign_week: weekIndex,
    weekly_cap: weeklyCap,
    weekly_committed: Number(weeklyCommitted),
    weekly_remaining: Math.max(0, weeklyCap - Number(weeklyCommitted)),
    daily_target: dailyTarget,
    daily_committed: Number(dailyCommitted),
    batch_size: batchSize,
    day_start_pt: dayStart,
    week_start_pt: weekStart,
  };
}

module.exports = {
  calculateDailyCapacity,
  dailyTargetForWeek,
  startOfCurrentDayPT,
  startOfNextDayPT,
};
