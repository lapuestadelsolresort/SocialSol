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
 *   - 3 bounces in 24h    → paused_by='auto_threshold:bounce_24h'
 *   - 1 complaint in 7d   → paused_by='auto_threshold:complaint_7d'
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
  const bounceCap = thresholds.bounces_24h ?? 3;
  const complaintCap = thresholds.complaints_7d ?? 1;

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

  return { tripped: false };
}

module.exports = { checkThresholdsAndMaybePause };
