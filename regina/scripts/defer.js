#!/usr/bin/env node
'use strict';
//
// regina/scripts/defer.js — handles `!defer N`.
//
// TRANSPORT: operator terminal only. No Slack dispatch path invokes this
// script — a `!defer N` typed in a draft thread reaches no machine (F-048).
// Run it from a shell with --slack-thread-ts. It has no send capability.
//
// Marks the draft deferred for N days; defer_until = now + N days.
// voice_drafts_log.outcome stays 'pending' — the draft is still in flight.
// The 14-day reminder + 3-strike auto-suppress in gmail-reconcile.js is what
// eventually flips it to 'discarded' if Sarah never actions it.

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

// Parse `!defer N` → integer N or null. Validates 1..365.
function extractDays(message) {
  const m = String(message || '').trim();
  const match = m.match(/^!defer\s+(\d+)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > 365) return null;
  return n;
}

function addDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

async function run() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  const threadTs = args['slack-thread-ts'];
  const message = args['message'] || '';

  if (!threadTs) {
    console.error('[regina/defer] missing --slack-thread-ts');
    process.exit(2);
  }

  const days = extractDays(message);
  if (days == null) {
    await postToChannel(channelId, '⚠ !defer N must be 1..365.', { threadTs });
    return;
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

    const deferUntil = addDaysIso(days);

    await db.query(sql`
      UPDATE outreach_sends
      SET status = ${'deferred'},
          defer_until = ${deferUntil}
      WHERE id = ${row.id}
    `);

    // Intentionally NOT updating voice_drafts_log — outcome stays 'pending'.

    await postToChannel(channelId, slackFmt.buildDeferredAck(deferUntil), { threadTs });
  } catch (e) {
    console.error('[regina/defer] error:', e);
    await postToChannel(channelId, `❌ !defer failed: ${e.message}`, { threadTs }).catch(() => {});
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[regina/defer] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, extractDays, addDaysIso };
