#!/usr/bin/env node
'use strict';
//
// crm/scripts/gmail-reply-forwarder.js — poll Sarah's Gmail mailbox and ingest
// inbound/outbound outreach replies into the durable email conversation ledger.
//
// Runs every 5 minutes from com.lapuestadelsolresort.gmail-reply-forwarder.
// Looks back SINCE_MINUTES via Gmail (gmail.readonly, service-account DWD,
// no read-state mutation). email_threads(provider, provider_message_id) is the
// durable dedupe key; processed_gmail_replies remains a compatibility index.
//
// Matching uses RFC reply headers, Gmail thread id, recipient address, and
// normalized subject. The workflow worker classifies and posts each event.
//
// Flags:
//   --dry-run   List inbox candidates, no DB writes.

const path = require('path');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { searchInboxSince, searchSentSinceMinutes } = require('../lib/gmail-client');
const { ingestEmailEvent, resolveOutreachSend } = require('../lib/email-conversations');
const { ensureSchemaAsync } = require('../lib/workflow-schema');

const SINCE_MINUTES = 60;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');

const DRY_RUN = process.argv.includes('--dry-run');

function openDb() {
  return createDB(DB_PATH);
}

async function recordProcessed(db, { messageId, sendId, matched }) {
  const now = new Date().toISOString();
  await db.query(sql`
    INSERT OR IGNORE INTO processed_gmail_replies (message_id, forwarded_at, send_id, matched)
    VALUES (${messageId}, ${now}, ${sendId}, ${matched ? 1 : 0})
  `);
}

function gmailEvent(message, direction, send = null) {
  return {
    provider: 'gmail',
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    rfcMessageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    from: message.from?.address || message.from || '',
    to: message.to || '',
    subject: message.subject || '',
    text: message.text || message.body || '',
    internalDate: message.internalDate || message.sent_at,
    direction,
    outreachSendId: send?.id || null,
  };
}

async function run() {
  if (DRY_RUN) console.log('[gmail-reply-forwarder] DRY-RUN — no DB writes');

  let inboxMessages;
  let sentMessages;
  try {
    [inboxMessages, sentMessages] = await Promise.all([
      searchInboxSince(SINCE_MINUTES),
      searchSentSinceMinutes(SINCE_MINUTES),
    ]);
  } catch (e) {
    console.error('[gmail-reply-forwarder] Gmail search failed:', e.message);
    process.exit(1);
  }

  console.log(`[gmail-reply-forwarder] mailbox messages in last ${SINCE_MINUTES}m: inbox=${inboxMessages.length} sent=${sentMessages.length}`);

  // Only process emails that are actual replies (have In-Reply-To header).
  // This prevents Sarah's unrelated inbox mail (newsletters, vendor emails, etc.)
  // from being logged as unmatched noise. We only care about responses to our
  // cold outreach from outreach.lapuestadelsol.com.
  const replies = inboxMessages.filter((m) => !!m.inReplyTo);
  console.log(`[gmail-reply-forwarder] reply candidates (have In-Reply-To): ${replies.length}`);

  if (DRY_RUN) {
    for (const m of replies) {
      console.log(`  - id=${m.id} from=${m.from && m.from.address} subject=${(m.subject || '').slice(0, 80)} inReplyTo=${(m.inReplyTo || '').slice(0, 60)}`);
    }
    for (const m of sentMessages.filter(message => message.inReplyTo || message.references)) {
      console.log(`  - sent id=${m.id} to=${m.to} subject=${(m.subject || '').slice(0, 80)} thread=${m.threadId || ''}`);
    }
    console.log(`[gmail-reply-forwarder] scanned=${inboxMessages.length + sentMessages.length} reply_candidates=${replies.length} (dry-run, no DB writes)`);
    return;
  }

  const db = openDb();
  let ingested = 0;
  let matched = 0;
  let skipped = 0;

  try {
    await ensureSchemaAsync(db, sql);

    for (const m of replies) {
      try {
        const result = await ingestEmailEvent(db, gmailEvent(m, 'inbound'));
        const sendId = result.send?.id || result.event?.outreach_send_id || null;
        await recordProcessed(db, { messageId: m.id, sendId, matched: Boolean(sendId) });
        if (result.created) ingested++;
        else skipped++;
        if (sendId) matched++;
        console.log(`[gmail-reply-forwarder] inbound id=${m.id} created=${result.created} matched=${Boolean(sendId)} send_id=${sendId}`);
      } catch (e) {
        console.error(`[gmail-reply-forwarder] message ${m.id} failed:`, e.message);
      }
    }

    for (const m of sentMessages.filter(message => message.inReplyTo || message.references)) {
      try {
        const candidate = gmailEvent(m, 'outbound');
        const send = await resolveOutreachSend(db, candidate);
        if (!send) { skipped++; continue; }
        const result = await ingestEmailEvent(db, gmailEvent(m, 'outbound', send));
        if (result.created) ingested++;
        else skipped++;
        matched++;
        console.log(`[gmail-reply-forwarder] outbound id=${m.id} created=${result.created} send_id=${send.id}`);
      } catch (e) {
        console.error(`[gmail-reply-forwarder] sent message ${m.id} failed:`, e.message);
      }
    }
  } finally {
    await db.dispose();
  }

  console.log(
    `[gmail-reply-forwarder] scanned=${inboxMessages.length + sentMessages.length} reply_candidates=${replies.length} ingested=${ingested} ` +
    `matched=${matched} skipped=${skipped}`
  );
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[gmail-reply-forwarder] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
