#!/usr/bin/env node
'use strict';
//
// sarah-coach/scripts/coach.js — handles a paste in #sarah-coach.
//
// Sol (the resort agent) reads the channel message, extracts text from any
// image attachment in its own vision context, then spawns this script with
// JSON on stdin:
//   { "inbound_text": "...", "from_user_id": "U...", "inbound_source": "text|image" }
//
// We call POST /api/voice/draft with intent=inbound_inquiry_response, post
// a code-fenced draft to #sarah-coach, and INSERT a sarah_coach_thread_log
// row mapping the post's thread_ts → voice_drafts_log_id so the !sent /
// !edit handlers can find it later.
//
// Args:
//   --dry-run    Skip the Slack post and the DB insert; print what would happen.
//
// Exit codes:
//   0  draft posted (or printed in --dry-run)
//   1  Voice Service down OR validation error OR generic failure
//   2  bad stdin / unauthorized user (Sol picks up stderr message and posts)

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../../regina/lib/cli-args');
// Import `sql` from regina/lib/db (not '@databases/sqlite' directly): the
// regina helper resolves @databases/sqlite from regina/node_modules; pulling
// from there ensures we use the same module instance regina/lib/db's openDb()
// uses, avoiding an SQLQuery class-identity mismatch when db.query(sql\`...\`)
// runs. See regina-test-db.js header comment for the same gotcha.
const { openDb, sql } = require('../../regina/lib/db');
const { callOne, VoiceServiceError } = require('../../crm/lib/voice-service');
const { postToChannel } = require('../../crm/lib/slack-post');
const slackFmt = require('../lib/slack-format');

const SARAH_COACH_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(SARAH_COACH_ROOT, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function run() {
  const args = parseArgs(process.argv);
  const dryRun = Boolean(args['dry-run']);
  const cfg = loadConfig();

  let stdinRaw;
  try {
    stdinRaw = await readStdin();
  } catch (e) {
    console.error(`[sarah-coach/coach] stdin read failed: ${e.message}`);
    process.exit(2);
  }

  let stdin;
  try {
    stdin = JSON.parse(stdinRaw || '{}');
  } catch (e) {
    console.error(`[sarah-coach/coach] stdin not valid JSON: ${e.message}`);
    console.error(slackFmt.buildCouldntReadWarning());
    process.exit(2);
  }

  const inboundText = (stdin.inbound_text || '').trim();
  const fromUserId = stdin.from_user_id || null;
  const isFromImage = stdin.inbound_source === 'image';

  if (!inboundText) {
    console.error('[sarah-coach/coach] missing inbound_text');
    console.error(slackFmt.buildCouldntReadWarning());
    process.exit(2);
  }

  if (!fromUserId || !cfg.slack.authorized_user_ids.includes(fromUserId)) {
    console.error(`[sarah-coach/coach] user ${fromUserId} not authorized`);
    console.error(slackFmt.buildNotAuthorized());
    process.exit(2);
  }

  const channelId = cfg.slack.channel_id;
  const payload = {
    intent: cfg.voice_service.intent,
    message_context: inboundText,
    agent_id: cfg.voice_service.agent_id,
    draft_length: cfg.voice_service.draft_length,
  };

  let draft;
  try {
    draft = await callOne(payload, {
      url: cfg.voice_service.url,
      timeoutMs: cfg.voice_service.timeout_ms,
    });
  } catch (e) {
    if (e instanceof VoiceServiceError && (e.status === 503 || e.status == null)) {
      const reason = e.detail || e.service || e.message;
      console.error(`[sarah-coach/coach] Voice Service down: ${reason}`);
      const msg = slackFmt.buildVoiceServiceDownPost(reason);
      if (dryRun) {
        console.log('[DRY RUN] would post:\n' + msg);
      } else {
        await postToChannel(channelId, msg).catch(() => {});
      }
      process.exit(1);
    }
    // 4xx / unexpected
    console.error(`[sarah-coach/coach] Voice Service error: ${e.message}`);
    if (!dryRun) await postToChannel(channelId, slackFmt.buildGenericDraftFailure()).catch(() => {});
    process.exit(1);
  }

  const message = slackFmt.buildDraftMessage({
    inboundText,
    draftText: draft.draft_text,
    isFromImage,
  });

  if (dryRun) {
    console.log('[DRY RUN] would post:');
    console.log(message);
    console.log(`[DRY RUN] voice_drafts_log_id=${draft.voice_drafts_log_id}`);
    return;
  }

  const postResult = await postToChannel(channelId, message);
  if (!postResult.ok || !postResult.ts) {
    console.error(`[sarah-coach/coach] Slack post failed: ${postResult.error || '(no ts)'}`);
    process.exit(1);
  }

  // Map thread_ts (the top-level post's ts is its own thread_ts in Slack's
  // flat-thread model) → voice_drafts_log_id, so outcome.js can resolve
  // which draft Sarah is acting on without scanning by timestamp.
  if (draft.voice_drafts_log_id != null) {
    const db = openDb();
    try {
      await db.query(sql`
        INSERT INTO sarah_coach_thread_log (thread_ts, voice_drafts_log_id)
        VALUES (${postResult.ts}, ${draft.voice_drafts_log_id})
      `);
    } catch (e) {
      // Non-fatal — the draft is already posted. Sarah just won't be able
      // to !sent/!edit it. Log loudly so this gets investigated.
      console.error(`[sarah-coach/coach] thread_log insert failed (non-fatal): ${e.message}`);
    } finally {
      await db.dispose();
    }
  } else {
    console.warn('[sarah-coach/coach] no voice_drafts_log_id in response — !sent/!edit will not work for this draft');
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[sarah-coach/coach] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
