#!/usr/bin/env node
'use strict';

require('../../lib/runtime-paths');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { DB_PATH } = require('../../lib/runtime-paths');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { searchMailboxSinceDays } = require('../lib/gmail-client');
const { ingestEmailEvent, resolveOutreachSend } = require('../lib/email-conversations');

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function gmailEvent(message, direction, sendId = null) {
  return {
    provider: 'gmail', providerMessageId: message.id, providerThreadId: message.threadId,
    rfcMessageId: message.messageId, inReplyTo: message.inReplyTo,
    references: message.references, from: message.from?.address || message.from || '',
    to: message.to || '', subject: message.subject || '', text: message.text || '',
    internalDate: message.internalDate, direction, outreachSendId: sendId,
  };
}

async function main(args = process.argv.slice(2), deps = {}) {
  const days = Math.max(1, Math.min(3650, Number(option(args, '--days', '365')) || 365));
  const apply = args.includes('--apply');
  const includeUnthreaded = args.includes('--include-unthreaded');
  const search = deps.searchMailboxSinceDays || searchMailboxSinceDays;
  const db = deps.db || createDB(DB_PATH);
  let ownsDb = !deps.db;
  const summary = {
    ok: true, mode: apply ? 'apply' : 'dry-run', days,
    inboxScanned: 0, sentScanned: 0, replyCandidates: 0,
    matchedInbound: 0, unmatchedInbound: 0, matchedOutbound: 0,
    skippedWithoutSlackThread: 0, created: 0, existing: 0,
  };
  try {
    await ensureSchemaAsync(db, sql);
    const mailbox = await search(days, { maxResults: 5000 });
    summary.inboxScanned = mailbox.inbox.length;
    summary.sentScanned = mailbox.sent.length;
    const processed = await db.query(sql`SELECT message_id, send_id FROM processed_gmail_replies WHERE send_id IS NOT NULL`);
    const hints = new Map(processed.map(row => [String(row.message_id), Number(row.send_id)]));
    const inbound = mailbox.inbox.filter(message => message.inReplyTo);
    summary.replyCandidates = inbound.length;

    for (const message of inbound) {
      const hint = hints.get(String(message.id)) || null;
      const candidate = gmailEvent(message, 'inbound', hint);
      const send = await resolveOutreachSend(db, candidate);
      if (send) summary.matchedInbound += 1;
      else summary.unmatchedInbound += 1;
      if (send && (!send.slack_channel_id || !send.slack_message_ts) && !includeUnthreaded) {
        summary.skippedWithoutSlackThread += 1;
        continue;
      }
      if (!apply) continue;
      const result = await ingestEmailEvent(db, { ...candidate, outreachSendId: send?.id || hint });
      if (result.created) summary.created += 1;
      else summary.existing += 1;
      await db.query(sql`INSERT OR IGNORE INTO processed_gmail_replies
        (message_id, forwarded_at, send_id, matched)
        VALUES (${message.id}, ${message.internalDate || new Date().toISOString()},
          ${send?.id || hint}, ${send || hint ? 1 : 0})`);
    }

    for (const message of mailbox.sent.filter(item => item.inReplyTo || item.references)) {
      const candidate = gmailEvent(message, 'outbound');
      const send = await resolveOutreachSend(db, candidate);
      if (!send) continue;
      summary.matchedOutbound += 1;
      if ((!send.slack_channel_id || !send.slack_message_ts) && !includeUnthreaded) {
        summary.skippedWithoutSlackThread += 1;
        continue;
      }
      if (!apply) continue;
      const result = await ingestEmailEvent(db, { ...candidate, outreachSendId: send.id });
      if (result.created) summary.created += 1;
      else summary.existing += 1;
    }
    return summary;
  } finally {
    if (ownsDb) await db.dispose();
  }
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`[reconcile-email-conversations] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { gmailEvent, main, option };
