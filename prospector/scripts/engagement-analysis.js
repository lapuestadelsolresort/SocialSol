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
 *   node engagement-analysis.js [--dry-run]
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

const SCRIPTS_DIR = __dirname;
const STATE_PATH = path.join(SCRIPTS_DIR, 'iteration-state.json');
const SLACK_CHANNEL = process.env.PROSPECTOR_SLACK_CHANNEL;
const CAMPAIGN_SLUG = process.env.PAULINA_CAMPAIGN_SLUG || 'planner_partner_program_v1';
const DRY_RUN = process.argv.includes('--dry-run');

const MODEL = 'claude-haiku-4-5';

function log(...args) {
  console.log('[engagement-analysis]', new Date().toISOString(), ...args);
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
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function slackPost(msg) {
  if (DRY_RUN) { console.log('[DRY-RUN] Slack:', msg); return; }
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

async function pullEngagementData(db) {
  // Last 14 days of sends with engagement
  const sends = await db.query(sql`
    SELECT
      os.id, os.subject, os.hook_angle, os.sent_at,
      os.opened_at, os.clicked_at, os.reply_detected_at,
      os.bounced_at, os.complained_at, os.status,
      c.name, c.company, c.email, c.source,
      oc.slug as campaign_slug, oc.persona
    FROM outreach_sends os
    JOIN contacts c ON c.id = os.contact_id
    LEFT JOIN outreach_campaigns oc ON oc.id = os.campaign_id
    WHERE os.sent_at >= datetime('now', '-14 days')
      AND oc.slug = ${CAMPAIGN_SLUG}
      AND os.status NOT IN ('drafted', 'pending_approval', 'cancelled')
    ORDER BY os.sent_at DESC
  `);

  // Aggregate stats
  const total = sends.length;
  const delivered = sends.filter(s => !s.bounced_at && s.status !== 'bounced').length;
  const bounced = sends.filter(s => s.bounced_at || s.status === 'bounced').length;
  const opened = sends.filter(s => s.opened_at).length;
  const replied = sends.filter(s => s.reply_detected_at).length;
  const clicked = sends.filter(s => s.clicked_at).length;

  // By hook angle
  const byHook = {};
  for (const s of sends) {
    const angle = s.hook_angle || 'unknown';
    if (!byHook[angle]) byHook[angle] = { sent: 0, opened: 0, replied: 0, bounced: 0 };
    byHook[angle].sent++;
    if (s.opened_at) byHook[angle].opened++;
    if (s.reply_detected_at) byHook[angle].replied++;
    if (s.bounced_at || s.status === 'bounced') byHook[angle].bounced++;
  }

  // Subject line patterns (first 5 words)
  const bySubjectPrefix = {};
  for (const s of sends) {
    const prefix = (s.subject || '').split(' ').slice(0, 4).join(' ');
    if (!bySubjectPrefix[prefix]) bySubjectPrefix[prefix] = { sent: 0, opened: 0, replied: 0 };
    bySubjectPrefix[prefix].sent++;
    if (s.opened_at) bySubjectPrefix[prefix].opened++;
    if (s.reply_detected_at) bySubjectPrefix[prefix].replied++;
  }

  // Recent replies details
  const replyDetails = sends
    .filter(s => s.reply_detected_at)
    .map(s => ({ name: s.name, company: s.company, subject: s.subject, hook_angle: s.hook_angle, sent_at: s.sent_at, replied_at: s.reply_detected_at }));

  // Bounce details
  const bounceDetails = sends
    .filter(s => s.bounced_at || s.status === 'bounced')
    .map(s => ({ name: s.name, email: s.email, company: s.company }));

  return {
    total, delivered, bounced, opened, replied, clicked,
    open_rate: delivered > 0 ? ((opened / delivered) * 100).toFixed(1) : '0.0',
    reply_rate: delivered > 0 ? ((replied / delivered) * 100).toFixed(1) : '0.0',
    click_rate: delivered > 0 ? ((clicked / delivered) * 100).toFixed(1) : '0.0',
    bounce_rate: total > 0 ? ((bounced / total) * 100).toFixed(1) : '0.0',
    byHook, bySubjectPrefix,
    replyDetails, bounceDetails,
    raw_sends: sends.slice(0, 20),
  };
}

async function pullQueueStats(db) {
  const [row] = await db.query(sql`
    SELECT COUNT(*) as eligible FROM campaign_contacts cc
    JOIN outreach_campaigns oc ON oc.id = cc.campaign_id
    WHERE oc.slug = ${CAMPAIGN_SLUG}
      AND
    NOT EXISTS (
      SELECT 1 FROM outreach_sends os
      WHERE os.contact_id = cc.contact_id
        AND os.campaign_id = cc.campaign_id
        AND os.status != 'cancelled'
    )
  `);
  const [contacted] = await db.query(sql`SELECT COUNT(*) as n FROM contacts WHERE status='contacted'`);
  const [newLeads] = await db.query(sql`SELECT COUNT(*) as n FROM contacts WHERE status='new' AND do_not_contact=0`);
  return {
    eligible_in_campaign: row.eligible,
    contacted: contacted.n,
    new_contacts: newLeads.n,
  };
}

async function generateHypothesis(stats, prevState) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prevHypotheses = (prevState.hypotheses || []).slice(-3)
    .map(h => `Day ${h.day}: ${h.hypothesis} → Test: ${h.test} → Result: ${h.result || 'pending'}`)
    .join('\n');

  const prompt = `You are the outreach analyst for La Puesta del Sol Resort (a private oceanfront resort in Riviera Nayarit, Mexico). You run cold email prospecting only to wedding and event planners. The offer is a venue partner program with direct resort access, hosted site visits, co-marketing support, and a documented 10% referral commission. A reply is the primary conversion event. An attributed click to the planner partner page is a secondary engagement signal. The email must not ask for a booking or couple introduction.

## Last 14 Days Engagement Data
- Total sent: ${stats.total}
- Delivered: ${stats.delivered} | Bounced: ${stats.bounced} (${stats.bounce_rate}%)
- Opened: ${stats.opened} (open rate: ${stats.open_rate}%)
- Replied: ${stats.replied} (reply rate: ${stats.reply_rate}%)
- Clicked: ${stats.clicked} (secondary click rate: ${stats.click_rate}%)

## Engagement by Hook Angle
${JSON.stringify(stats.byHook, null, 2)}

## Engagement by Subject Line Pattern
${JSON.stringify(stats.bySubjectPrefix, null, 2)}

## Recent Replies
${stats.replyDetails.length > 0 ? JSON.stringify(stats.replyDetails, null, 2) : 'None yet'}

## Recent Bounces
${stats.bounceDetails.length > 0 ? stats.bounceDetails.map(b => `${b.name} (${b.company}) - ${b.email}`).join('\n') : 'None'}

## Previous Hypotheses & Results
${prevHypotheses || 'None yet (Day 1)'}

## Task
1. In 2-3 sentences: what does the data tell us? Be honest — if we have no opens yet, say so and why that might be.
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
  const state = loadState();
  state.day = (state.day || 0) + 1;

  log(`Starting engagement analysis (day ${state.day})`);

  let stats, queueStats, hypothesis;

  try {
    stats = await pullEngagementData(db);
    queueStats = await pullQueueStats(db);
    log(`Stats: ${stats.total} sent, ${stats.opened} opened, ${stats.replied} replied, ${stats.bounced} bounced`);
  } catch (e) {
    log('ERROR pulling stats:', e.message);
    await db.dispose();
    process.exit(1);
  }

  try {
    hypothesis = await generateHypothesis(stats, state);
    log('Hypothesis:', hypothesis.hypothesis);
  } catch (e) {
    log('ERROR generating hypothesis:', e.message);
    hypothesis = {
      data_summary: `${stats.total} emails sent, ${stats.replied} replied, ${stats.opened} opened.`,
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
    hypothesis: hypothesis.hypothesis,
    test: hypothesis.test,
    success_metric: hypothesis.success_metric,
    composer_hint: hypothesis.composer_hint,
    result: null,
    stats_snapshot: {
      total: stats.total, delivered: stats.delivered, bounced: stats.bounced,
      opened: stats.opened, replied: stats.replied, clicked: stats.clicked,
      open_rate: stats.open_rate, reply_rate: stats.reply_rate, click_rate: stats.click_rate,
    },
  };
  state.hypotheses = state.hypotheses || [];
  state.hypotheses.push(entry);
  state.current_hypothesis = entry;
  if (hypothesis.composer_hint) {
    state.active_composer_hint = hypothesis.composer_hint;
  }
  saveState(state);

  // Build Slack post
  const replyLines = stats.replyDetails.length > 0
    ? '\n🎉 *Replies:* ' + stats.replyDetails.map(r => `${r.name} (${r.company})`).join(', ')
    : '';

  const bounceLines = stats.bounceDetails.length > 0
    ? '\n⚠️ *Bounces:* ' + stats.bounceDetails.slice(0, 3).map(b => b.email).join(', ')
    : '';

  const hookLines = Object.entries(stats.byHook)
    .map(([angle, d]) => `  • ${angle}: ${d.sent} sent, ${d.opened} opened, ${d.replied} replied`)
    .join('\n') || '  • No data yet';

  const msg = `📈 *Engagement Report — Day ${state.day} (${entry.date})*

*Last 14 days:* ${stats.total} sent → ${stats.delivered} delivered | ${stats.bounced} bounced (${stats.bounce_rate}%)
*Primary — replies:* ${stats.replied} (${stats.reply_rate}% of delivered)${replyLines}
*Secondary — clicks:* ${stats.clicked} (${stats.click_rate}%) | *Diagnostic opens:* ${stats.opened} (${stats.open_rate}%)${bounceLines}

*By hook angle:*
${hookLines}

*Queue:* ${queueStats.eligible_in_campaign} eligible | ${queueStats.contacted} in conversation

---
🔬 *Today's hypothesis:*
${hypothesis.data_summary}

*Test:* ${hypothesis.test}
*Win condition:* ${hypothesis.success_metric}`;

  slackPost(msg);

  await db.dispose();
  log('Done');
  return hypothesis;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
