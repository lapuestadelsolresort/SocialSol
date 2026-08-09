/**
 * Threshold-level auto-pause (Step 3.3 §5).
 *
 * Called from the Resend webhook handler in crm/server.js after each
 * email.bounced or email.complained event. Computes rolling-window counts
 * across all campaigns (cross-campaign per spec §11.5 — at 5–20 sends/week
 * total, per-campaign thresholds don't have the sample size to be meaningful)
 * and flips state.json.paused if a threshold is tripped.
 *
 * Thresholds (from config.orchestrator.thresholds):
 *   - absolute bounce count in 24h
 *   - bounce percentage over 7d once the minimum sample is reached
 *   - absolute complaint count in 7d
 *   - complaint percentage over 7d once the minimum sample is reached
 *
 * Idempotency (spec §5.4): if state.json.paused is already true with a
 * paused_by starting with 'auto_threshold:', skip — Resend retries shouldn't
 * double-post the alert.
 *
 * Auto-pause does NOT cancel rows already at status='approved' with future
 * scheduled_at — it only stops the orchestrator from picking them up. On
 * !resume, those rows resume on their existing schedule.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join(__dirname, '..', 'state.json');

function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { paused: false }; }
}

function writePauseState(statePath, reason, pausedBy) {
  let state = { paused: false };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* tolerate missing */ }
  state.paused = true;
  state.paused_by = pausedBy;
  state.paused_at = new Date().toISOString();
  state.pause_reason = reason;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Run threshold checks after a bounce/complaint event was just persisted.
 *
 * @param {DBConnection} db        — the live CRM db handle
 * @param {SQLTagFn}     sql       — caller's `sql` tagged-template fn
 * @param {object}       config    — prospector/config.json
 * @param {object}       hooks     — { slackPost, healthcheckFail } — fail-soft fns
 * @param {object}       [opts]    — { statePath } — defaults to prospector/state.json
 * @returns {Promise<{tripped: boolean, reason?: string, paused_by?: string}>}
 */
async function checkThresholdsAndMaybePause(db, sql, config, hooks, opts = {}) {
  const statePath = opts.statePath || DEFAULT_STATE_PATH;
  const thresholds = config.orchestrator?.thresholds || {};
  const bounceCap = thresholds.bounces_24h ?? 2;
  const bounceRateCap = thresholds.bounce_rate_7d ?? 0.04;
  const bounceRateMinSent = thresholds.bounce_rate_min_sent ?? 20;
  const complaintCap = thresholds.complaints_7d ?? 1;
  const complaintRateCap = thresholds.complaint_rate_7d ?? 0.001;
  const complaintRateMinSent = thresholds.complaint_rate_min_sent ?? 20;

  // Idempotency guard.
  const state = readState(statePath);
  if (state.paused && typeof state.paused_by === 'string' && state.paused_by.startsWith('auto_threshold:')) {
    return { tripped: false, alreadyPaused: true };
  }

  // Bounce check (cross-campaign, last 24h).
  const [{ n: bounceN }] = await db.query(sql`
    SELECT COUNT(*) AS n FROM outreach_sends
    WHERE bounced_at IS NOT NULL AND datetime(bounced_at) >= datetime('now', '-1 day')
  `);
  if (bounceN >= bounceCap) {
    const offending = await db.query(sql`
      SELECT os.id, c.email, os.bounced_at
      FROM outreach_sends os JOIN contacts c ON c.id = os.contact_id
      WHERE os.bounced_at IS NOT NULL AND datetime(os.bounced_at) >= datetime('now', '-1 day')
      ORDER BY os.bounced_at DESC
    `);
    const reason = `${bounceN} bounces in last 24h (cap: ${bounceCap})`;
    const pausedBy = 'auto_threshold:bounce_24h';
    writePauseState(statePath, reason, pausedBy);
    const lines = [
      `🚨 AUTO-PAUSED — ${reason}`,
      'Bounced sends:',
      ...offending.map((o) => `  • #${o.id} ${o.email} at ${o.bounced_at}`),
      'Run `!resume` to lift the pause once the cause is investigated.',
    ];
    if (hooks.slackPost) {
      try { await hooks.slackPost(lines.join('\n')); } catch (e) { console.warn('[threshold-pause] slack post failed:', e.message); }
    }
    if (hooks.healthcheckFail) {
      try { hooks.healthcheckFail(); } catch { /* fail-soft */ }
    }
    return { tripped: true, reason, paused_by: pausedBy };
  }

  // Rate guard: a single bounce at meaningful volume can be a stronger signal
  // than the absolute cap. The minimum sample prevents one event among the
  // first few messages from producing a noisy percentage decision.
  const [{ sent_n: sent7d, bounce_n: bounces7d }] = await db.query(sql`
    SELECT
      COUNT(*) AS sent_n,
      SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounce_n
    FROM outreach_sends
    WHERE sent_at IS NOT NULL AND datetime(sent_at) >= datetime('now', '-7 days')
  `);
  const bounceRate = Number(sent7d) > 0 ? Number(bounces7d || 0) / Number(sent7d) : 0;
  if (Number(sent7d) >= bounceRateMinSent && bounceRate >= bounceRateCap) {
    const percent = (bounceRate * 100).toFixed(2);
    const reason = `${bounces7d}/${sent7d} sends bounced in last 7 days (${percent}%; cap: ${(bounceRateCap * 100).toFixed(2)}%)`;
    const pausedBy = 'auto_threshold:bounce_rate_7d';
    writePauseState(statePath, reason, pausedBy);
    if (hooks.slackPost) {
      try {
        await hooks.slackPost([
          `🚨 AUTO-PAUSED — ${reason}`,
          `The rate gate activates after ${bounceRateMinSent} sends.`,
          'Run `!resume` only after the queue and sender reputation are investigated.',
        ].join('\n'));
      } catch (e) { console.warn('[threshold-pause] slack post failed:', e.message); }
    }
    if (hooks.healthcheckFail) {
      try { hooks.healthcheckFail(); } catch { /* fail-soft */ }
    }
    return { tripped: true, reason, paused_by: pausedBy, rate: bounceRate };
  }

  // Complaint check (cross-campaign, last 7d).
  const [{ n: complaintN }] = await db.query(sql`
    SELECT COUNT(*) AS n FROM outreach_sends
    WHERE complained_at IS NOT NULL AND datetime(complained_at) >= datetime('now', '-7 days')
  `);
  if (complaintN >= complaintCap) {
    const offending = await db.query(sql`
      SELECT os.id, c.email, os.complained_at
      FROM outreach_sends os JOIN contacts c ON c.id = os.contact_id
      WHERE os.complained_at IS NOT NULL AND datetime(os.complained_at) >= datetime('now', '-7 days')
      ORDER BY os.complained_at DESC
    `);
    const reason = `${complaintN} complaint(s) in last 7 days (cap: ${complaintCap})`;
    const pausedBy = 'auto_threshold:complaint_7d';
    writePauseState(statePath, reason, pausedBy);
    const lines = [
      `🚨 AUTO-PAUSED — ${reason}`,
      'Complained sends:',
      ...offending.map((o) => `  • #${o.id} ${o.email} at ${o.complained_at}`),
      'Run `!resume` to lift the pause once the cause is investigated.',
    ];
    if (hooks.slackPost) {
      try { await hooks.slackPost(lines.join('\n')); } catch (e) { console.warn('[threshold-pause] slack post failed:', e.message); }
    }
    if (hooks.healthcheckFail) {
      try { hooks.healthcheckFail(); } catch { /* fail-soft */ }
    }
    return { tripped: true, reason, paused_by: pausedBy };
  }

  const [{ sent_n: complaintSent7d, complaint_n: complaints7d }] = await db.query(sql`
    SELECT
      COUNT(*) AS sent_n,
      SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END) AS complaint_n
    FROM outreach_sends
    WHERE sent_at IS NOT NULL AND datetime(sent_at) >= datetime('now', '-7 days')
  `);
  const complaintRate = Number(complaintSent7d) > 0
    ? Number(complaints7d || 0) / Number(complaintSent7d)
    : 0;
  if (Number(complaintSent7d) >= complaintRateMinSent && complaintRate >= complaintRateCap) {
    const percent = (complaintRate * 100).toFixed(3);
    const reason = `${complaints7d}/${complaintSent7d} sends complained in last 7 days (${percent}%; cap: ${(complaintRateCap * 100).toFixed(3)}%)`;
    const pausedBy = 'auto_threshold:complaint_rate_7d';
    writePauseState(statePath, reason, pausedBy);
    if (hooks.slackPost) {
      try {
        await hooks.slackPost([
          `🚨 AUTO-PAUSED — ${reason}`,
          `The rate gate activates after ${complaintRateMinSent} sends.`,
          'Run `!resume` only after the complaint source is investigated.',
        ].join('\n'));
      } catch (e) { console.warn('[threshold-pause] slack post failed:', e.message); }
    }
    if (hooks.healthcheckFail) {
      try { hooks.healthcheckFail(); } catch { /* fail-soft */ }
    }
    return { tripped: true, reason, paused_by: pausedBy, rate: complaintRate };
  }

  return { tripped: false };
}

module.exports = { checkThresholdsAndMaybePause };
