#!/usr/bin/env node
'use strict';
//
// sarah-coach/scripts/outcome.js — handles `!sent` and `!edit <text>`.
//
// Sol parses the reply in #sarah-coach and dispatches:
//   node outcome.js --command sent --thread-ts <ts> --slack-user-id <user>
//   node outcome.js --command edit --thread-ts <ts> --slack-user-id <user> --edit-text "..."
//
// We look up voice_drafts_log via sarah_coach_thread_log.thread_ts, compute
// edit_distance for !edit, update voice_drafts_log (closes R3 feedback loop),
// and post an in-thread ack.

const fs = require('fs');
const path = require('path');
const levenshtein = require('fast-levenshtein');
const { parseArgs } = require('../../regina/lib/cli-args');
// Import `sql` from regina/lib/db (not '@databases/sqlite' directly) so the
// SQLQuery class identity matches what openDb() returns. See regina-test-db.js
// header for the gotcha.
const { openDb, sql } = require('../../regina/lib/db');
const { postToChannel } = require('../../crm/lib/slack-post');
const slackFmt = require('../lib/slack-format');

const SARAH_COACH_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(SARAH_COACH_ROOT, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function lookupDraft(db, threadTs) {
  const rows = await db.query(sql`
    SELECT scl.voice_drafts_log_id AS vdl_id, vdl.draft_text AS draft_text
    FROM sarah_coach_thread_log scl
    JOIN voice_drafts_log vdl ON vdl.id = scl.voice_drafts_log_id
    WHERE scl.thread_ts = ${threadTs}
    LIMIT 1
  `);
  return rows[0] || null;
}

async function run() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  const threadTs = args['thread-ts'] || args['slack-thread-ts'];
  const command = args.command;
  const editText = args['edit-text'];

  if (!command || !['sent', 'edit'].includes(command)) {
    console.error('[sarah-coach/outcome] --command must be sent|edit');
    process.exit(2);
  }
  if (!threadTs) {
    console.error('[sarah-coach/outcome] missing --thread-ts');
    process.exit(2);
  }
  if (command === 'edit' && (!editText || !String(editText).trim())) {
    console.error('[sarah-coach/outcome] --edit-text required for !edit');
    process.exit(2);
  }

  const db = openDb();
  try {
    const row = await lookupDraft(db, threadTs);
    if (!row) {
      await postToChannel(channelId, slackFmt.buildNoDraftFoundForThread(), { threadTs });
      return;
    }

    const now = new Date().toISOString();

    if (command === 'sent') {
      await db.query(sql`
        UPDATE voice_drafts_log
        SET outcome = ${'sent_as_is'},
            edit_distance = ${0},
            updated_at = ${now}
        WHERE id = ${row.vdl_id}
      `);
      await postToChannel(channelId, slackFmt.buildSentAck(), { threadTs });
      return;
    }

    // command === 'edit'
    const editStr = String(editText);
    const distance = levenshtein.get(row.draft_text || '', editStr);
    await db.query(sql`
      UPDATE voice_drafts_log
      SET outcome = ${'sent_with_edits'},
          edit_distance = ${distance},
          sent_text = ${editStr},
          updated_at = ${now}
      WHERE id = ${row.vdl_id}
    `);
    await postToChannel(channelId, slackFmt.buildEditAck(distance), { threadTs });
  } catch (e) {
    console.error('[sarah-coach/outcome] error:', e);
    await postToChannel(channelId, `❌ outcome failed: ${e.message}`, { threadTs }).catch(() => {});
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[sarah-coach/outcome] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, lookupDraft };
