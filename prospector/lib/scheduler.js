/**
 * Scheduler — computes scheduled_at for an approved draft (Step 3.3 §3.2).
 *
 * Mirrors the approach in warmup-daily.sh's Python block (which is well-tested
 * for the warmup flow). Differences vs warmup:
 *   - warmup plans the WHOLE day at once (volumes 1–25 per day across 14 days);
 *     scheduler queues ONE send at a time as drafts get approved.
 *   - scheduler honors a per-campaign weekly cap (caps come from
 *     prospector/config.json `weekly_send_caps`, computed via the calendar-week
 *     math already in lib/compliance.js).
 *   - scheduler jitters from the most recent prior `scheduled_at` for the
 *     same campaign (per spec §11.4 resolution), not from now(), so sends
 *     spread evenly across the day.
 *
 * Window/jitter parameters live in config.json `orchestrator.send_window`
 * (start_hour_pt, end_hour_pt, min_gap_minutes, max_gap_minutes, weekdays_only).
 *
 * Returns:
 *   { scheduled_at: <ISO UTC>, week_index: <int>, cap_remaining_in_week: <int> }
 *
 * `cap_remaining_in_week` reports remaining capacity AFTER this send is
 * counted — useful for the approve-handler to surface "3 of 5 used this week"
 * to the operator.
 */

'use strict';

// IMPORTANT: do NOT `require('@databases/sqlite')` for the `sql` tag here.
// The scheduler is called from both crm/server.js and prospector/orchestrator.js,
// which load `@databases/sqlite` from DIFFERENT node_modules directories.
// Each package instance attaches its own Symbol to its `sql` tag for type-safety
// validation; a tag from one instance is NOT recognized by db.query() from
// another. The caller passes their own `sql` tag to keep instances aligned.

const { startOfCurrentCalendarWeekPT, calendarWeeksSinceFirstSend, capForWeek } = require('./compliance');

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── PT calendar helpers (mirror compliance.js's PT-aware math) ────────────

/**
 * Given an ISO UTC instant, returns its components rendered in America/Los_Angeles:
 * { year, month, day, weekdayShort: 'Mon'|..., hour, minute }.
 */
function ptParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return {
    year: parseInt(parts.year),
    month: parseInt(parts.month),
    day: parseInt(parts.day),
    weekdayShort: parts.weekday,
    hour: parseInt(parts.hour),
    minute: parseInt(parts.minute),
  };
}

/**
 * Build an ISO UTC string for a given PT-anchored wall-clock time.
 * year/month/day are PT calendar values; hour/minute are PT wall-clock.
 * Handles PDT (-7) vs PST (-8) automatically via Intl shortOffset.
 */
function ptWallClockToIso(year, month, day, hour, minute) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const min = String(minute).padStart(2, '0');
  const offsetFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset',
  });
  const offsetParts = offsetFmt.formatToParts(new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`));
  const tz = offsetParts.find((p) => p.type === 'timeZoneName').value; // "GMT-7"|"GMT-8"
  const offHours = parseInt(tz.replace('GMT', ''), 10);
  const offSign = offHours >= 0 ? '+' : '-';
  const offAbs = String(Math.abs(offHours)).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00${offSign}${offAbs}:00`).toISOString();
}

/**
 * Roll forward to the next weekday (Mon-Fri) PT at <hour>:<minute>.
 * If `from` is already on a weekday and the target time is in the future, returns
 * that target. Used for "push to tomorrow's 9am-9:30am" and "next Monday 9am".
 */
function nextWeekdayAt(fromDate, targetHour, targetMinute, weekdaysOnly) {
  const WEEKEND = new Set(['Sat', 'Sun']);
  const cursor = new Date(fromDate.getTime());
  for (let i = 0; i < 14; i++) {
    const p = ptParts(cursor);
    const candidate = ptWallClockToIso(p.year, p.month, p.day, targetHour, targetMinute);
    const isWeekend = WEEKEND.has(p.weekdayShort);
    if ((!weekdaysOnly || !isWeekend) && new Date(candidate).getTime() > fromDate.getTime()) {
      return candidate;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error('nextWeekdayAt: walked >14 days without finding a slot');
}

/**
 * Returns the ISO UTC instant for "Monday 09:00 PT" of the calendar week
 * AFTER the one containing `from`.
 */
function nextMondayMorningPT(fromDate, hour = 9, minute = 0) {
  const cursor = new Date(fromDate.getTime());
  for (let i = 0; i < 14; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const p = ptParts(cursor);
    if (p.weekdayShort === 'Mon') {
      return ptWallClockToIso(p.year, p.month, p.day, hour, minute);
    }
  }
  throw new Error('nextMondayMorningPT: walked >14 days without hitting Monday');
}

// ─── Public: computeScheduledAt ─────────────────────────────────────────────

/**
 * Compute the next scheduled_at for an approved draft on `campaignId`.
 *
 * @param {DBConnection} db         — @databases/sqlite handle
 * @param {SQLTagFn}     sql        — caller's own `sql` tagged-template fn
 *                                    (from the SAME @databases/sqlite instance
 *                                    that produced `db`; instance-isolated
 *                                    Symbol validation requires this).
 * @param {object}       config     — prospector/config.json
 * @param {number}       campaignId — outreach_campaigns.id
 * @returns {Promise<{ scheduled_at: string, week_index: number, cap_remaining_in_week: number }>}
 */
async function computeScheduledAt(db, sql, config, campaignId) {
  const sw = config.orchestrator?.send_window || {};
  const startHour = sw.start_hour_pt ?? 9;
  const endHour = sw.end_hour_pt ?? 17;
  const minGap = sw.min_gap_minutes ?? 20;
  const maxGap = sw.max_gap_minutes ?? 90;
  const weekdaysOnly = sw.weekdays_only !== false;

  const now = new Date();

  // 1. Read campaign first_send_at to determine cap_index.
  const [campaign] = await db.query(sql`SELECT first_send_at FROM outreach_campaigns WHERE id = ${campaignId}`);
  const firstSendAt = campaign?.first_send_at || null;
  const capIndex = calendarWeeksSinceFirstSend(firstSendAt) + 1;
  const cap = capForWeek(config, capIndex);
  if (typeof cap !== 'number') {
    throw new Error(`computeScheduledAt: cap undefined for week ${capIndex} (config.weekly_send_caps may be missing key 'week_${capIndex}' or 'week_4_plus')`);
  }

  // 2. Count already-scheduled-or-sent rows for this campaign in current calendar week.
  //    Counts statuses: approved, sent, delivered, opened, clicked, replied
  //    (any status that consumed an outbound slot this week).
  const weekStart = startOfCurrentCalendarWeekPT();
  const [{ n: countThisWeek }] = await db.query(sql`
    SELECT COUNT(*) AS n FROM outreach_sends
    WHERE campaign_id = ${campaignId}
      AND status IN ('approved','sent','delivered','opened','clicked','replied')
      AND (
        (sent_at IS NOT NULL AND datetime(sent_at) >= datetime(${weekStart}))
        OR (sent_at IS NULL AND scheduled_at IS NOT NULL AND datetime(scheduled_at) >= datetime(${weekStart}))
      )
  `);

  // 3. Determine the anchor for jitter — most recent prior scheduled_at on
  // this campaign that's still LIVE (not cancelled / bounced / complained).
  // Cancelled-but-scheduled rows don't consume a slot in cap counting (per
  // the eligibility query above) so they shouldn't anchor jitter either —
  // otherwise old smoke-test cancellations leak into future scheduling.
  const [{ latest: priorScheduled }] = await db.query(sql`
    SELECT MAX(scheduled_at) AS latest FROM outreach_sends
    WHERE campaign_id = ${campaignId}
      AND scheduled_at IS NOT NULL
      AND status NOT IN ('cancelled', 'bounced', 'complained')
  `);
  const priorScheduledMs = priorScheduled ? new Date(priorScheduled).getTime() : 0;

  // 4. Cap reached → schedule into next calendar week, anchored on prior
  //    scheduled_at when it's already in the new week's window. Per spec §3.2
  //    step 4: "20-90 min jitter from the prior week's last scheduled_at".
  //    Without anchoring, consecutive cap-overflow approvals all get fresh
  //    randoms in the 9-9:30 slot, can land out of order and bunch up.
  if (countThisWeek >= cap) {
    const monday9am = new Date(nextMondayMorningPT(now, startHour, 0)).getTime();
    let chosenMs;
    if (priorScheduledMs >= monday9am) {
      // Prior already rolled to the new week — anchor jitter on it (same
      // logic as the in-week branch below).
      const jitterMin = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
      chosenMs = priorScheduledMs + jitterMin * 60000;
      // Clamp to the day's end; if past 5pm, push to next weekday morning.
      const mondayP = ptParts(new Date(monday9am));
      const mondayEnd = new Date(ptWallClockToIso(mondayP.year, mondayP.month, mondayP.day, endHour, 0)).getTime();
      if (chosenMs > mondayEnd) {
        const nextMorning = nextWeekdayAt(new Date(mondayEnd), startHour, 0, weekdaysOnly);
        chosenMs = new Date(nextMorning).getTime() + Math.floor(Math.random() * 30) * 60000;
      }
    } else {
      // First overflow into the new week — fresh 0-30 min jitter past 9am.
      chosenMs = monday9am + Math.floor(Math.random() * 30) * 60000;
    }
    return {
      scheduled_at: new Date(chosenMs).toISOString(),
      week_index: capIndex + 1,
      cap_remaining_in_week: capForWeek(config, capIndex + 1) - 1,
    };
  }

  // 5. Cap not reached → schedule today or tomorrow.
  const nowPt = ptParts(now);
  const earliestNowMs = now.getTime() + minGap * 60000;
  // Today's 9am PT in UTC
  const todayStart = new Date(ptWallClockToIso(nowPt.year, nowPt.month, nowPt.day, startHour, 0)).getTime();
  // Today's 5pm PT in UTC
  const todayEnd = new Date(ptWallClockToIso(nowPt.year, nowPt.month, nowPt.day, endHour, 0)).getTime();
  // 4:30pm PT cutoff: if now > 4:30pm PT, push to tomorrow.
  const today430 = new Date(ptWallClockToIso(nowPt.year, nowPt.month, nowPt.day, endHour - 1, 30)).getTime();
  const isWeekendToday = ['Sat', 'Sun'].includes(nowPt.weekdayShort);

  // Anchor = max(now+minGap, prior_scheduled, today's start). We jitter ON TOP of this.
  let anchorMs = Math.max(earliestNowMs, priorScheduledMs, todayStart);

  let chosenMs;
  if (
    (weekdaysOnly && isWeekendToday) ||
    now.getTime() > today430 ||
    anchorMs > todayEnd
  ) {
    // Push to next eligible weekday morning. Anchor on the prior scheduled_at
    // when it's already in that morning window — without this, consecutive
    // approvals that both fall through to "tomorrow" each get fresh
    // 0-30 min randoms and land out of order.
    const tomorrow9am = new Date(nextWeekdayAt(now, startHour, 0, weekdaysOnly)).getTime();
    const tomorrowP = ptParts(new Date(tomorrow9am));
    const tomorrowEnd = new Date(ptWallClockToIso(tomorrowP.year, tomorrowP.month, tomorrowP.day, endHour, 0)).getTime();
    if (priorScheduledMs >= tomorrow9am && priorScheduledMs < tomorrowEnd) {
      // Prior already scheduled into this same target window — jitter from it.
      const jitterMin = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
      chosenMs = priorScheduledMs + jitterMin * 60000;
      if (chosenMs > tomorrowEnd) {
        // Clamp pushed past end-of-window — recurse to next morning.
        const dayAfter = new Date(nextWeekdayAt(new Date(tomorrowEnd), startHour, 0, weekdaysOnly)).getTime();
        chosenMs = dayAfter + Math.floor(Math.random() * 30) * 60000;
      }
    } else {
      // First approval to fall through to this target window — fresh
      // 0-30 min jitter past 9am.
      chosenMs = tomorrow9am + Math.floor(Math.random() * 30) * 60000;
    }
  } else {
    // Today: jitter minGap..maxGap on top of the anchor, clamp to today's window.
    const jitterMin = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
    chosenMs = anchorMs + jitterMin * 60000;
    if (chosenMs > todayEnd) {
      // Clamp pushed past 5pm — push to tomorrow morning, anchor on prior
      // when it's already there.
      const tomorrow9am = new Date(nextWeekdayAt(now, startHour, 0, weekdaysOnly)).getTime();
      const tomorrowP = ptParts(new Date(tomorrow9am));
      const tomorrowEnd = new Date(ptWallClockToIso(tomorrowP.year, tomorrowP.month, tomorrowP.day, endHour, 0)).getTime();
      if (priorScheduledMs >= tomorrow9am && priorScheduledMs < tomorrowEnd) {
        const jm = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
        chosenMs = priorScheduledMs + jm * 60000;
        if (chosenMs > tomorrowEnd) {
          const dayAfter = new Date(nextWeekdayAt(new Date(tomorrowEnd), startHour, 0, weekdaysOnly)).getTime();
          chosenMs = dayAfter + Math.floor(Math.random() * 30) * 60000;
        }
      } else {
        chosenMs = tomorrow9am + Math.floor(Math.random() * 30) * 60000;
      }
    }
  }

  return {
    scheduled_at: new Date(chosenMs).toISOString(),
    week_index: capIndex,
    cap_remaining_in_week: cap - countThisWeek - 1,
  };
}

module.exports = {
  computeScheduledAt,
  // Exported for tests:
  ptParts,
  ptWallClockToIso,
  nextWeekdayAt,
  nextMondayMorningPT,
};
