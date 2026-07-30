#!/usr/bin/env node
'use strict';
//
// regina/scripts/gmail-reconcile.js — daily Gmail reconciliation +
// 14-day re-queue sweep + 3-strike auto-suppress.
//
// Two passes per run:
//
//   1. Reconciliation: for each manual_email draft from the last 7 days
//      where sent_text IS NULL, search Sarah's Gmail Sent for that recipient.
//      Compute Levenshtein-based similarity.
//        ≥ auto_mark_threshold (default 0.6) → auto-mark sent + close voice_drafts_log
//        ≥ possible_match_threshold (default 0.4) → post "possible match", no auto-mark
//        < possible_match_threshold → no action
//
//   2. Re-queue sweep: for unactioned drafted rows older than 14 days where
//      last_reminded_at is NULL or older than 14 days:
//        - reminder_count >= 3 → auto-suppress (status='rejected',
//                                voice_drafts_log='discarded',
//                                skip_reason='auto_suppressed_unactioned_3x')
//        - else → post reminder, bump reminder_count, set last_reminded_at
//
// Healthcheck regina-reconciliation-cron pings ONLY after the first
// successful Gmail API call. Token rot from DWD revocation is the failure
// mode this protects against.

const fs = require('fs');
const path = require('path');
const { sql } = require('@databases/sqlite');
const { parseArgs } = require('../lib/cli-args');
const { openDb } = require('../lib/db');
const gmailClientDefault = require('../../crm/lib/gmail-client');
const { similarity, classify } = require('../lib/reconcile-similarity');
const { postToChannel } = require('../../crm/lib/slack-post');
const slackFmt = require('../lib/slack-format');
const hc = require('../lib/healthcheck');

const REGINA_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REGINA_ROOT, 'config.json');
const HC_KEY = 'regina-reconciliation-cron';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Strip Gmail quote/forward chrome that creeps into reply chains. Conservative:
// only nukes the standard "On <date>... wrote:" block and everything after.
function stripQuoteTail(s) {
  if (!s) return '';
  return String(s).split(/\nOn .{0,80}wrote:\n/)[0].trim();
}

async function pass1Reconciliation(db, cfg, channelId, postFn, healthcheckPinged, deps = {}) {
  const searchSentSince = deps.searchSentSince || gmailClientDefault.searchSentSince;
  const lookbackDays = cfg.reconciliation.lookback_days || 7;
  const autoMark = cfg.reconciliation.auto_mark_threshold || 0.6;
  const possibleMatch = cfg.reconciliation.possible_match_threshold || 0.4;

  const rows = await db.query(sql`
    SELECT s.id, s.draft_text, s.contact_id, s.voice_drafts_log_id,
           s.created_at, s.slack_thread_ts, s.slack_channel_id,
           c.name AS contact_name, c.email AS contact_email
    FROM outreach_sends s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN outreach_campaigns camp ON camp.id = s.campaign_id
    WHERE s.send_method = 'manual_email'
      AND s.sent_text IS NULL
      AND s.status = 'drafted'
      AND s.created_at > date('now', '-' || ${lookbackDays} || ' days')
      AND camp.owning_agent = 'regina'
  `);

  let autoMarked = 0;
  let possibleMatches = 0;
  for (const row of rows) {
    if (!row.contact_email) continue;

    let candidates = [];
    try {
      candidates = await searchSentSince(lookbackDays, { toFilter: row.contact_email });
    } catch (e) {
      console.error('[regina/reconcile] Gmail search failed for', row.contact_email, e.message);
      // Don't ping success on Gmail failure — token rot may be the cause.
      continue;
    }

    // Mark healthcheck successful as soon as Gmail API responded once.
    if (!healthcheckPinged.value) {
      hc.success(HC_KEY);
      healthcheckPinged.value = true;
    }

    if (candidates.length === 0) continue;

    let best = { score: -1, candidate: null };
    for (const cand of candidates) {
      const cleaned = stripQuoteTail(cand.body);
      const score = similarity(row.draft_text, cleaned);
      if (score > best.score) best = { score, candidate: { ...cand, _cleaned: cleaned } };
    }

    const decision = classify(best.score, { autoMark, possibleMatch });

    if (decision === 'auto_mark') {
      const editDistance = best.candidate._cleaned.length === 0
        ? row.draft_text.length
        : Math.round(row.draft_text.length * (1 - best.score));
      const sentAt = best.candidate.sent_at || new Date().toISOString();
      await db.query(sql`
        UPDATE outreach_sends
        SET status = 'sent',
            sent_text = ${best.candidate._cleaned},
            edit_distance = ${editDistance},
            sent_at = ${sentAt}
        WHERE id = ${row.id}
      `);
      if (row.voice_drafts_log_id) {
        await db.query(sql`
          UPDATE voice_drafts_log
          SET outcome = 'sent_with_edits',
              edit_distance = ${editDistance},
              updated_at = ${new Date().toISOString()}
          WHERE id = ${row.voice_drafts_log_id}
        `);
      }
      const channel = row.slack_channel_id || channelId;
      await postFn(
        channel,
        slackFmt.buildAutoReconcilePost({
          contact: { name: row.contact_name },
          sentAtIso: sentAt,
          editDistance,
        }),
        row.slack_thread_ts ? { threadTs: row.slack_thread_ts } : {}
      );
      autoMarked++;
    } else if (decision === 'possible_match') {
      const channel = row.slack_channel_id || channelId;
      await postFn(
        channel,
        slackFmt.buildPossibleMatchPost({
          contact: { name: row.contact_name },
          draftText: row.draft_text || '',
          gmailBody: best.candidate._cleaned,
          similarity: best.score,
        }),
        row.slack_thread_ts ? { threadTs: row.slack_thread_ts } : {}
      );
      possibleMatches++;
    }
    // 'no_match' → silent
  }

  return { autoMarked, possibleMatches, scanned: rows.length };
}

async function pass2RequeueSweep(db, cfg, channelId, postFn) {
  const reminderAfter = cfg.reconciliation.reminder_after_days || 14;
  const maxReminders = cfg.reconciliation.max_reminders_before_suppress || 3;

  const rows = await db.query(sql`
    SELECT s.id, s.draft_text, s.contact_id, s.voice_drafts_log_id,
           s.created_at, s.slack_thread_ts, s.slack_channel_id,
           s.reminder_count, s.last_reminded_at,
           c.name AS contact_name
    FROM outreach_sends s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN outreach_campaigns camp ON camp.id = s.campaign_id
    WHERE s.status = 'drafted'
      AND camp.owning_agent = 'regina'
      AND s.created_at <= date('now', '-' || ${reminderAfter} || ' days')
      AND (
        s.last_reminded_at IS NULL
        OR s.last_reminded_at <= date('now', '-' || ${reminderAfter} || ' days')
      )
  `);

  let reminded = 0;
  let suppressed = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const channel = row.slack_channel_id || channelId;
    if ((row.reminder_count || 0) >= maxReminders) {
      // Auto-suppress
      await db.query(sql`
        UPDATE outreach_sends
        SET status = 'rejected',
            skip_reason = 'auto_suppressed_unactioned_3x'
        WHERE id = ${row.id}
      `);
      if (row.voice_drafts_log_id) {
        await db.query(sql`
          UPDATE voice_drafts_log
          SET outcome = 'discarded', updated_at = ${now}
          WHERE id = ${row.voice_drafts_log_id}
        `);
      }
      await postFn(
        channel,
        slackFmt.buildAutoSuppressPost({
          contact: { name: row.contact_name },
          draftDate: (row.created_at || '').slice(0, 10),
        }),
        row.slack_thread_ts ? { threadTs: row.slack_thread_ts } : {}
      );
      suppressed++;
    } else {
      await db.query(sql`
        UPDATE outreach_sends
        SET reminder_count = COALESCE(reminder_count, 0) + 1,
            last_reminded_at = ${now}
        WHERE id = ${row.id}
      `);
      await postFn(
        channel,
        slackFmt.buildReminderPost({
          contact: { name: row.contact_name },
          draftDate: (row.created_at || '').slice(0, 10),
          count: (row.reminder_count || 0) + 1,
          max: maxReminders,
        }),
        row.slack_thread_ts ? { threadTs: row.slack_thread_ts } : {}
      );
      reminded++;
    }
  }

  return { reminded, suppressed, scanned: rows.length };
}

async function postSlackMessage(channelId, message, opts = {}) {
  const r = await postToChannel(channelId, message, opts);
  if (!r.ok) {
    console.error('[regina/reconcile] Slack post failed:', r.error || '(no ts)', r.stderr || '');
  }
  return r;
}

async function run() {
  const args = parseArgs(process.argv);
  hc.start(HC_KEY);

  const cfg = loadConfig();
  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  if (!channelId || channelId.startsWith('PLACEHOLDER')) {
    const msg = 'slack channel_id not configured';
    console.error('[regina/reconcile]', msg);
    hc.fail(HC_KEY, msg);
    process.exit(2);
  }

  const db = openDb();
  const healthcheckPinged = { value: false };
  try {
    const p1 = await pass1Reconciliation(db, cfg, channelId, postSlackMessage, healthcheckPinged);
    console.log(`[regina/reconcile] pass1: scanned=${p1.scanned} auto_marked=${p1.autoMarked} possible=${p1.possibleMatches}`);

    const p2 = await pass2RequeueSweep(db, cfg, channelId, postSlackMessage);
    console.log(`[regina/reconcile] pass2: scanned=${p2.scanned} reminded=${p2.reminded} suppressed=${p2.suppressed}`);

    // If we never got a Gmail success but pass2 did its work, we still
    // ping success at the end to record an "alive" run — the token-rot
    // protection only kicks in when there are pass1 candidates AND Gmail
    // never answered. If there were no manual_email candidates this run,
    // an "alive" ping is correct.
    if (!healthcheckPinged.value && p1.scanned === 0) {
      hc.success(HC_KEY);
    } else if (!healthcheckPinged.value && p1.scanned > 0) {
      // Had candidates but Gmail never answered → token rot suspected.
      hc.fail(HC_KEY, 'pass1_had_candidates_but_no_gmail_success');
    }
  } catch (e) {
    console.error('[regina/reconcile] unexpected error:', e);
    hc.fail(HC_KEY, e.message || String(e));
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[regina/reconcile] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, pass1Reconciliation, pass2RequeueSweep, stripQuoteTail };
