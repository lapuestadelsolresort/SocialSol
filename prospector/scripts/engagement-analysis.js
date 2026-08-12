#!/usr/bin/env node
/**
 * Prospector Paulina — Daily Engagement Analysis + Hypothesis Engine
 *
 * Pulls engagement data from the CRM, calls Claude to:
 *   1. Summarize what happened (opens, replies, bounces)
 *   2. Form a hypothesis about what's working / not working
 *   3. Recommend tomorrow's test (subject variant, hook angle, persona shift)
 *
 * Saves state to scripts/iteration-state.json.
 * Posts findings to #prospector-paulina via openclaw.
 *
 * Usage:
 *   node engagement-analysis.js [--dry-run] [--no-slack] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const Anthropic = require('@anthropic-ai/sdk');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const {
  DB_PATH,
  OPENCLAW_BIN: OPENCLAW,
} = require('../../lib/runtime-paths');
const {
  buildPerformanceReport,
  parseDatabaseTimestamp,
} = require('../lib/performance-report');

const SCRIPTS_DIR = __dirname;
const STATE_PATH = path.join(SCRIPTS_DIR, 'iteration-state.json');
const CONFIG_PATH = path.join(SCRIPTS_DIR, '..', 'config.json');
const SLACK_CHANNEL = process.env.PROSPECTOR_SLACK_CHANNEL;
const CAMPAIGN_SLUG = process.env.PAULINA_CAMPAIGN_SLUG || 'planner_partner_program_v1';
const ARGS = process.argv.slice(2);
const DRY_RUN = process.argv.includes('--dry-run');
const NO_SLACK = process.argv.includes('--no-slack');
const JSON_OUTPUT = process.argv.includes('--json');
const WORKFLOW_RUN_ID = (() => {
  const index = ARGS.indexOf('--workflow-run-id');
  const supplied = index >= 0 ? ARGS[index + 1] : process.env.WORKFLOW_RUN_ID;
  return typeof supplied === 'string' && /^[0-9a-f-]{36}$/i.test(supplied)
    ? supplied
    : null;
})();

const MODEL = 'claude-haiku-4-5';

function log(...args) {
  process.stderr.write(`[engagement-analysis] ${new Date().toISOString()} ${args.join(' ')}\n`);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      day: 0,
      hypotheses: [],
      current_hypothesis: null,
      active_test: null,
      subject_variants_tried: [],
      hook_angles_tried: [],
      personas_tried: [],
      send_history: [],
    };
  }
}

function saveState(state) {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_PATH);
}

function workflowReplay(state, workflowRunId) {
  if (!workflowRunId) return null;
  const prior = (state.hypotheses || [])
    .find(entry => entry.workflow_run_id === workflowRunId);
  return prior?.workflow_result ? { ...prior.workflow_result, replayed: true } : null;
}

function slackPost(msg) {
  if (DRY_RUN || NO_SLACK) return;
  if (!SLACK_CHANNEL || !process.env.OPENCLAW_SLACK_ACCOUNT) {
    log('WARN: Slack post skipped; configure PROSPECTOR_SLACK_CHANNEL and OPENCLAW_SLACK_ACCOUNT');
    return;
  }
  try {
    execFileSync(OPENCLAW, [
      'message', 'send',
      '--channel', 'slack',
      '--account', process.env.OPENCLAW_SLACK_ACCOUNT,
      '--target', SLACK_CHANNEL,
      '--message', msg,
    ], { timeout: 15000 });
  } catch (e) {
    log('WARN: Slack post failed:', e.message);
  }
}

/**
 * Pull supplementary hook-angle and subject-prefix breakdowns for the
 * hypothesis engine. Top-level stats come from the canonical
 * buildPerformanceReport(); this query adds the per-variant detail it
 * doesn't carry.
 */
async function pullHypothesisSupplementary(db, config) {
  const reporting = config.reporting || {};
  const openTrackingStart = parseDatabaseTimestamp(reporting.open_tracking_enabled_at);
  const opensAvailable = reporting.open_tracking_enabled === true && Boolean(openTrackingStart);

  const sends = await db.query(sql`
    SELECT
      os.subject, os.hook_angle, os.sent_at,
      os.delivered_at, os.opened_at, os.reply_detected_at,
      os.bounced_at, os.status
    FROM outreach_sends os
    JOIN outreach_campaigns oc ON oc.id = os.campaign_id
    WHERE os.sent_at >= datetime('now', '-14 days')
      AND oc.slug = ${CAMPAIGN_SLUG}
      AND os.status NOT IN ('drafted', 'pending_approval', 'cancelled')
    ORDER BY os.sent_at DESC
  `);

  // By hook angle
  const byHook = {};
  for (const s of sends) {
    const angle = s.hook_angle || 'unknown';
    if (!byHook[angle]) byHook[angle] = {
      sent: 0, open_eligible_delivered: 0, opened: 0, replied: 0, bounced: 0,
    };
    byHook[angle].sent++;
    const sentAt = parseDatabaseTimestamp(s.sent_at);
    const openEligibleForSend = opensAvailable && sentAt && sentAt >= openTrackingStart;
    if (openEligibleForSend && s.delivered_at) byHook[angle].open_eligible_delivered++;
    if (openEligibleForSend && s.delivered_at && s.opened_at) byHook[angle].opened++;
    if (s.reply_detected_at) byHook[angle].replied++;
    if (s.bounced_at || s.status === 'bounced') byHook[angle].bounced++;
  }
  if (!opensAvailable) {
    for (const metrics of Object.values(byHook)) {
      metrics.opened = null;
      metrics.open_eligible_delivered = null;
    }
  }

  // Subject line patterns (first 4 words)
  const bySubjectPrefix = {};
  for (const s of sends) {
    const prefix = (s.subject || '').split(' ').slice(0, 4).join(' ');
    if (!bySubjectPrefix[prefix]) bySubjectPrefix[prefix] = {
      sent: 0, open_eligible_delivered: 0, opened: 0, replied: 0,
    };
    bySubjectPrefix[prefix].sent++;
    const sentAt = parseDatabaseTimestamp(s.sent_at);
    const openEligibleForSend = opensAvailable && sentAt && sentAt >= openTrackingStart;
    if (openEligibleForSend && s.delivered_at) bySubjectPrefix[prefix].open_eligible_delivered++;
    if (openEligibleForSend && s.delivered_at && s.opened_at) bySubjectPrefix[prefix].opened++;
    if (s.reply_detected_at) bySubjectPrefix[prefix].replied++;
  }
  if (!opensAvailable) {
    for (const metrics of Object.values(bySubjectPrefix)) {
      metrics.opened = null;
      metrics.open_eligible_delivered = null;
    }
  }

  return { byHook, bySubjectPrefix };
}

async function generateHypothesis(report, supplementary, prevState) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const recent = report.recent;
  const tracking = report.tracking;

  const prevHypotheses = (prevState.hypotheses || []).slice(-3)
    .map(h => `Day ${h.day}: ${h.hypothesis} → Test: ${h.test} → Result: ${h.result || 'pending'}`)
    .join('\n');

  const openLine = tracking.opens_available
    ? `${recent.opens}/${recent.open_tracking_eligible_delivered} tracking-eligible delivered messages (open rate: ${recent.open_rate_percent == null ? 'unavailable until a tracked delivery exists' : `${recent.open_rate_percent}%`}; tracking active since ${tracking.opens_enabled_at})`
    : `unavailable. ${tracking.opens_note}`;
  const clickLine = tracking.clicks_available
    ? `${recent.clicks} (secondary click rate: ${recent.click_rate_percent}%)`
    : 'unavailable because click tracking is not configured';
  const replyDetails = recent.external_reply_details || [];

  const prompt = `You are the outreach analyst for La Puesta del Sol Resort (a private oceanfront resort in Riviera Nayarit, Mexico). You run cold email prospecting only to wedding and event planners. The offer is a venue partner program with direct resort access, hosted site visits, co-marketing support, and a documented 10% referral commission. A reply is the primary conversion event. An attributed click to the planner partner page is a secondary engagement signal. The email must not ask for a booking or couple introduction.

## Last ${recent.window_days} Days Engagement Data (canonical)
- Actual sent: ${recent.actual_sent} (${recent.production_sent} production, ${recent.test_sent} test)
- Delivered: ${recent.delivered} (production: ${recent.production_delivered}) | Bounced: ${recent.bounced}
- Opens: ${openLine}
- External replies: ${recent.external_replies} (production reply rate: ${recent.production_reply_rate_percent == null ? 'unavailable' : `${recent.production_reply_rate_percent}%`})
- Clicks: ${clickLine}

## Engagement by Hook Angle
${JSON.stringify(supplementary.byHook, null, 2)}

## Engagement by Subject Line Pattern
${JSON.stringify(supplementary.bySubjectPrefix, null, 2)}

## Recent External Replies
${replyDetails.length > 0 ? JSON.stringify(replyDetails, null, 2) : 'None yet'}

## Previous Hypotheses & Results
${prevHypotheses || 'None yet (Day 1)'}

## Interpretation guardrails
${tracking.delivery_note}
${tracking.sample_note}

## Task
1. In 2-3 sentences: what does the data tell us? Be honest. Do not infer spam
   placement, inbox placement, sender reputation, warmup health, or a 0% open
   rate when open tracking is unavailable. Do not grade a reply rate without an
   approved benchmark and adequate sample size.
2. Form ONE clear hypothesis about what to test tomorrow (subject line style, hook angle, persona segment, send timing, email length, etc.)
3. State the specific test: what exactly changes tomorrow?
4. Define what success looks like using replies among delivered emails. Opens and clicks can diagnose the funnel but cannot be the win condition.

Keep it sharp and actionable. Max 200 words total. Format as JSON:
{
  "data_summary": "...",
  "hypothesis": "...",
  "test": "...",
  "success_metric": "...",
  "composer_hint": "one-line instruction for the composer (e.g., 'Use curiosity-gap subject lines, start with a question')"
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text.trim();
  // Extract JSON
  const jsonMatch = raw.match(/\{[\s\S]+\}/);
  if (!jsonMatch) throw new Error('No JSON in hypothesis response: ' + raw);
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  const db = createDB(DB_PATH);
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const state = loadState();
  const replay = workflowReplay(state, WORKFLOW_RUN_ID);
  if (replay) {
    await db.dispose();
    if (JSON_OUTPUT) process.stdout.write(`${JSON.stringify(replay)}\n`);
    return replay;
  }
  state.day = (state.day || 0) + 1;

  log(`Starting engagement analysis (day ${state.day})`);

  let report, supplementary, hypothesis;

  try {
    report = await buildPerformanceReport(db, sql, config);
    supplementary = await pullHypothesisSupplementary(db, config);
    const recent = report.recent;
    log(`Stats (canonical): ${recent.actual_sent} sent, opens ${report.tracking.opens_available ? recent.opens : 'unavailable'}, ${recent.external_replies} external replies, ${recent.bounced} bounced`);
  } catch (e) {
    log('ERROR pulling stats:', e.message);
    await db.dispose();
    process.exit(1);
  }

  const recent = report.recent;
  const tracking = report.tracking;
  const queue = report.active_queue;

  try {
    hypothesis = await generateHypothesis(report, supplementary, state);
    log('Hypothesis:', hypothesis.hypothesis);
  } catch (e) {
    log('ERROR generating hypothesis:', e.message);
    hypothesis = {
      data_summary: `${recent.actual_sent} emails sent and ${recent.external_replies} external replies. Open data is ${tracking.opens_available ? `${recent.opens} opens among ${recent.open_tracking_eligible_delivered} delivered messages sent after tracking activation` : 'unavailable because tracking is not fully configured'}.`,
      hypothesis: 'Insufficient data — continuing with current approach.',
      test: 'No change today.',
      success_metric: 'At least 1 reply in the next 10 delivered emails.',
      composer_hint: null,
    };
  }

  // Save hypothesis to state
  const entry = {
    day: state.day,
    date: new Date().toISOString().split('T')[0],
    workflow_run_id: WORKFLOW_RUN_ID,
    hypothesis: hypothesis.hypothesis,
    test: hypothesis.test,
    success_metric: hypothesis.success_metric,
    composer_hint: hypothesis.composer_hint,
    result: null,
    stats_snapshot: {
      actual_sent: recent.actual_sent, production_sent: recent.production_sent,
      delivered: recent.delivered, production_delivered: recent.production_delivered,
      bounced: recent.bounced,
      opens: recent.opens, external_replies: recent.external_replies,
      clicks: recent.clicks,
      open_rate_percent: recent.open_rate_percent,
      production_reply_rate_percent: recent.production_reply_rate_percent,
      click_rate_percent: recent.click_rate_percent,
      open_tracking_eligible_delivered: recent.open_tracking_eligible_delivered,
    },
  };
  state.hypotheses = state.hypotheses || [];

  // Build Slack post — all numbers from the canonical report
  const replyDetails = recent.external_reply_details || [];
  const replyLines = replyDetails.length > 0
    ? '\n🎉 *Replies:* ' + replyDetails.map(r => `${r.name} (${r.company})`).join(', ')
    : '';

  const hookLines = Object.entries(supplementary.byHook)
    .map(([angle, d]) => `  • ${angle}: ${d.sent} sent, ${tracking.opens_available ? `${d.opened}/${d.open_eligible_delivered} tracked-delivered opened, ` : ''}${d.replied} replied`)
    .join('\n') || '  • No data yet';

  const clickSummary = tracking.clicks_available
    ? `${recent.clicks} (${recent.click_rate_percent}%)`
    : 'unavailable (tracking disabled)';
  const openSummary = tracking.opens_available
    ? `${recent.opens}/${recent.open_tracking_eligible_delivered} delivered since activation (${recent.open_rate_percent == null ? 'rate pending first tracked delivery' : `${recent.open_rate_percent}%`})`
    : 'unavailable (tracking not configured)';

  const bounceRate = recent.actual_sent > 0
    ? ((recent.bounced / recent.actual_sent) * 100).toFixed(1)
    : '0.0';
  const queueLine = queue
    ? `*Queue:* ${queue.remaining_contacts} remaining | ${queue.verified_ready} verified ready`
    : '';

  const msg = `📈 *Engagement Report — Day ${state.day} (${entry.date})*

*Last ${recent.window_days} days:* ${recent.actual_sent} sent (${recent.production_sent} production, ${recent.test_sent} test) → ${recent.delivered} delivered | ${recent.bounced} bounced (${bounceRate}%)
*Primary — replies:* ${recent.external_replies} (${recent.production_reply_rate_percent == null ? 'rate unavailable' : `${recent.production_reply_rate_percent}% of production delivered`})${replyLines}
*Secondary — clicks:* ${clickSummary} | *Diagnostic opens:* ${openSummary}

*By hook angle:*
${hookLines}

${queueLine}

---
🔬 *Today's hypothesis:*
${hypothesis.data_summary}

*Test:* ${hypothesis.test}
*Win condition:* ${hypothesis.success_metric}`;

  const workflowResult = {
    ok: true,
    replayed: false,
    dry_run: DRY_RUN,
    workflow_run_id: WORKFLOW_RUN_ID,
    day: entry.day,
    date: entry.date,
    recent: {
      window_days: recent.window_days,
      actual_sent: recent.actual_sent,
      production_sent: recent.production_sent,
      test_sent: recent.test_sent,
      delivered: recent.delivered,
      production_delivered: recent.production_delivered,
      bounced: recent.bounced,
      external_replies: recent.external_replies,
      opens: recent.opens,
      open_tracking_eligible_delivered: recent.open_tracking_eligible_delivered,
      clicks: recent.clicks,
    },
    tracking: {
      opens_available: tracking.opens_available,
      clicks_available: tracking.clicks_available,
    },
    queue: queue ? {
      remaining_contacts: queue.remaining_contacts,
      verified_ready: queue.verified_ready,
      verification_buffer_status: queue.verification_buffer_status,
    } : null,
    hypothesis: {
      data_summary: hypothesis.data_summary,
      hypothesis: hypothesis.hypothesis,
      test: hypothesis.test,
      success_metric: hypothesis.success_metric,
      composer_hint: hypothesis.composer_hint,
    },
  };

  entry.workflow_result = workflowResult;
  if (!DRY_RUN) {
    state.hypotheses.push(entry);
    state.current_hypothesis = entry;
    if (hypothesis.composer_hint) state.active_composer_hint = hypothesis.composer_hint;
    saveState(state);
  }

  slackPost(msg);

  await db.dispose();
  log('Done');
  if (JSON_OUTPUT) process.stdout.write(`${JSON.stringify(workflowResult)}\n`);
  return workflowResult;
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { main, pullHypothesisSupplementary, workflowReplay };
