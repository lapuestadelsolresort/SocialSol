#!/usr/bin/env node
'use strict';
//
// regina/scripts/sent.js — handles `!sent` and `<edited text> + !sent`.
//
// Looks up the active drafted row by Slack thread_ts. Computes edit_distance.
// Updates outreach_sends + voice_drafts_log (closes R3 feedback loop).
// Replies in the thread with the ack.

const fs = require('fs');
const path = require('path');
const levenshtein = require('fast-levenshtein');
const { sql } = require('@databases/sqlite');
const { parseArgs } = require('../lib/cli-args');
const { openDb } = require('../lib/db');
const { findDraftedByThread } = require('../lib/thread-lookup');
const { postToChannel } = require('../../crm/lib/slack-post');
const slackFmt = require('../lib/slack-format');

const REGINA_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REGINA_ROOT, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Strip the trailing `!sent` token (and any whitespace before it) from the
// message. Returns the remaining text, possibly empty.
function extractEditedText(message) {
  const m = String(message || '');
  // Match `!sent` at the end (possibly with trailing whitespace). Multiline
  // anchors so a final-line `!sent` is recognized after a newline.
  const re = /\s*!sent\s*$/m;
  return m.replace(re, '').replace(/\s+$/, '');
}

async function run() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  const threadTs = args['slack-thread-ts'];
  const userId = args['slack-user-id'] || null;
  const message = args['message'] || '';

  if (!threadTs) {
    console.error('[regina/sent] missing --slack-thread-ts');
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

    const draftText = row.draft_text || '';
    const edited = extractEditedText(message);
    const sentVerbatim = edited === '';
    const sentText = sentVerbatim ? draftText : edited;
    const editDistance = sentVerbatim ? 0 : levenshtein.get(draftText, sentText);
    const outcome = editDistance === 0 ? 'sent_as_is' : 'sent_with_edits';

    const sentAt = new Date().toISOString();
    await db.query(sql`
      UPDATE outreach_sends
      SET status = ${'sent'},
          sent_text = ${sentText},
          edit_distance = ${editDistance},
          sent_by_user_id = ${userId},
          sent_at = ${sentAt}
      WHERE id = ${row.id}
    `);

    if (row.voice_drafts_log_id) {
      await db.query(sql`
        UPDATE voice_drafts_log
        SET outcome = ${outcome},
            edit_distance = ${editDistance},
            updated_at = ${sentAt}
        WHERE id = ${row.voice_drafts_log_id}
      `);
    } else {
      console.warn(`[regina/sent] outreach_sends.id=${row.id} has no voice_drafts_log_id — R3 feedback loop entry missing`);
    }

    await postToChannel(channelId, slackFmt.buildSentAck(editDistance), { threadTs });
  } catch (e) {
    console.error('[regina/sent] error:', e);
    await postToChannel(channelId, `❌ !sent failed: ${e.message}`, { threadTs }).catch(() => {});
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[regina/sent] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, extractEditedText };
