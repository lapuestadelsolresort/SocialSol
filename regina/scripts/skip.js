#!/usr/bin/env node
'use strict';
//
// regina/scripts/skip.js — handles `!skip [reason]`.
//
// Marks the draft rejected. Writes voice_drafts_log.outcome='discarded'.
// Reason is the free text after `!skip`; if empty, stored as 'unspecified'.

const fs = require('fs');
const path = require('path');
const { sql } = require('@databases/sqlite');
const { parseArgs } = require('../lib/cli-args');
const { openDb } = require('../lib/db');
const { findDraftedByThread } = require('../lib/thread-lookup');
const { postToChannel } = require('../../crm/lib/slack-post');
const slackFmt = require('../lib/slack-format');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Extract reason from `!skip <reason>` — the leading `!skip` token plus any
// surrounding whitespace is stripped. Returns 'unspecified' if no reason.
function extractReason(message) {
  const m = String(message || '').trim();
  const re = /^!skip\b\s*/i;
  if (!re.test(m)) return 'unspecified';
  const rest = m.replace(re, '').trim();
  return rest || 'unspecified';
}

async function run() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  const threadTs = args['slack-thread-ts'];
  const message = args['message'] || '';

  if (!threadTs) {
    console.error('[regina/skip] missing --slack-thread-ts');
    process.exit(2);
  }

  const db = openDb();
  try {
    const row = await findDraftedByThread(db, threadTs);
    if (!row) {
      await postToChannel(channelId, '⚠ No active draft found for this thread.', { threadTs });
      return;
    }
    if (row._stale_status) {
      await postToChannel(
        channelId,
        `⚠ This draft was already actioned (status='${row._stale_status}'). No change.`,
        { threadTs }
      );
      return;
    }

    const reason = extractReason(message);
    const now = new Date().toISOString();

    await db.query(sql`
      UPDATE outreach_sends
      SET status = ${'rejected'},
          skip_reason = ${reason}
      WHERE id = ${row.id}
    `);

    if (row.voice_drafts_log_id) {
      await db.query(sql`
        UPDATE voice_drafts_log
        SET outcome = ${'discarded'},
            updated_at = ${now}
        WHERE id = ${row.voice_drafts_log_id}
      `);
    } else {
      console.warn(`[regina/skip] outreach_sends.id=${row.id} has no voice_drafts_log_id`);
    }

    await postToChannel(channelId, slackFmt.buildSkippedAck(), { threadTs });
  } catch (e) {
    console.error('[regina/skip] error:', e);
    await postToChannel(channelId, `❌ !skip failed: ${e.message}`, { threadTs }).catch(() => {});
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[regina/skip] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, extractReason };
