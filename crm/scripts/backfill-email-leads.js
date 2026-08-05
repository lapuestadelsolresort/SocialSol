#!/usr/bin/env node
'use strict';
//
// crm/scripts/backfill-email-leads.js — Full historical inbox backfill.
//
// Scans Sarah's ENTIRE inbox history via Gmail API, filters noise/outreach,
// groups by thread, and outputs raw extracted emails to JSON for classification.
//
// Usage:
//   node crm/scripts/backfill-email-leads.js [--dry-run]
//
// Env:
//   GMAIL_IMPERSONATE_USER  sarah@lapuestadelsolresort.com
//   SOCIALSOL_SECRETS_DIR   path to secrets/

const path = require('path');
const fs = require('fs');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { getGmailClient, _internal } = require('../lib/gmail-client');
const { decodeBody, extractTextBody, header, parseAddress } = _internal;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');
const OUTPUT_PATH = path.join(REPO_ROOT, 'crm', 'data', 'backfill-emails.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Ignore filters (same as inbound-email-scanner.js) ──
const IGNORE_DOMAINS = new Set([
  'lapuestadelsolresort.com',
  'lapuestadelsol.com',
  'airbnb.com',
  'booking.com',
  'google.com',
  'googlemail.com',
  'vrbo.com',
  'expedia.com',
  'tripadvisor.com',
  'facebook.com',
  'facebookmail.com',
  'instagram.com',
  'meta.com',
  // Additional transactional/noise domains
  'squarespace.com',
  'squarespacescheduling.com',
  'calendly.com',
  'stripe.com',
  'paypal.com',
  'venmo.com',
  'intuit.com',
  'quickbooks.com',
  'mailchimp.com',
  'constantcontact.com',
  'hubspot.com',
  'zendesk.com',
  'freshdesk.com',
  'icloud.com',         // Apple notifications
  'apple.com',
]);

const IGNORE_LOCAL_PARTS = new Set([
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'notifications',
  'notification',
  'alerts',
  'support',
  'info',
  'newsletter',
  'marketing',
  'updates',
  'billing',
  'receipts',
  'invoices',
  'hello',           // generic addresses often used by SaaS
]);

function shouldIgnoreAddress(address) {
  if (!address) return true;
  const lower = address.toLowerCase().trim();
  const atIdx = lower.indexOf('@');
  if (atIdx < 0) return true;
  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  if (IGNORE_DOMAINS.has(domain)) return true;
  // Sub-domains too (e.g. mail.google.com, bounce.paypal.com)
  for (const d of IGNORE_DOMAINS) {
    if (domain.endsWith('.' + d)) return true;
  }
  if (IGNORE_LOCAL_PARTS.has(local)) return true;
  if (/^(no[-_.]?reply|mailer[-_.]?daemon|bounce|auto[-_.]?reply|daemon)/i.test(local)) return true;

  return false;
}

/**
 * Paginated Gmail inbox search — fetches ALL messages matching the query.
 */
async function fetchAllInboxMessages(gmail, query) {
  const allIds = [];
  let pageToken = undefined;
  let page = 0;

  while (true) {
    page++;
    const params = { userId: 'me', q: query, maxResults: 500 };
    if (pageToken) params.pageToken = pageToken;

    const list = await gmail.users.messages.list(params);
    const msgs = list.data.messages || [];
    allIds.push(...msgs.map((m) => m.id));

    console.log(`  [page ${page}] fetched ${msgs.length} message IDs (total so far: ${allIds.length})`);

    pageToken = list.data.nextPageToken;
    if (!pageToken) break;
  }
  return allIds;
}

/**
 * Fetch full message details with rate-limit-friendly batching.
 */
async function fetchMessageDetails(gmail, ids) {
  const results = [];
  const BATCH_SIZE = 20; // conservative to avoid rate limits
  const DELAY_MS = 100;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (id) => {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const payload = full.data.payload || {};
        const fromRaw = header(payload.headers, 'From');
        const from = parseAddress(fromRaw);
        return {
          id,
          threadId: full.data.threadId,
          messageId: header(payload.headers, 'Message-ID'),
          from,
          to: header(payload.headers, 'To'),
          subject: header(payload.headers, 'Subject'),
          text: extractTextBody(payload),
          internalDate: full.data.internalDate
            ? new Date(Number(full.data.internalDate)).toISOString()
            : null,
          inReplyTo: header(payload.headers, 'In-Reply-To'),
          references: header(payload.headers, 'References'),
        };
      } catch (e) {
        console.error(`  [WARN] Failed to fetch message ${id}: ${e.message}`);
        return null;
      }
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter(Boolean));

    if (i + BATCH_SIZE < ids.length) {
      process.stdout.write(`\r  [fetch] ${results.length}/${ids.length} messages...`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  console.log(`\n  [fetch] Done: ${results.length} messages fetched`);
  return results;
}

async function run() {
  console.log('[backfill-email-leads] Starting full historical inbox scan...');
  if (DRY_RUN) console.log('  (DRY-RUN mode)');

  // ── Load exclusion sets from CRM ──
  const db = createDB(DB_PATH);
  let knownContactEmails, processedMessageIds, knownLeadEmails;
  try {
    const contactRows = await db.query(sql`SELECT LOWER(email) AS email FROM contacts WHERE email IS NOT NULL`);
    knownContactEmails = new Set(contactRows.map((r) => r.email).filter(Boolean));
    console.log(`  Loaded ${knownContactEmails.size} known contact emails to exclude`);

    const processedRows = await db.query(sql`SELECT message_id FROM processed_gmail_replies`);
    processedMessageIds = new Set(processedRows.map((r) => r.message_id));
    console.log(`  Loaded ${processedMessageIds.size} processed message IDs to exclude`);

    const leadRows = await db.query(sql`SELECT LOWER(email) AS email FROM leads WHERE email IS NOT NULL`);
    knownLeadEmails = new Set(leadRows.map((r) => r.email).filter(Boolean));
    console.log(`  Loaded ${knownLeadEmails.size} known lead emails`);
  } finally {
    await db.dispose();
  }

  // ── Gmail API: fetch ALL inbox messages ever ──
  const gmail = getGmailClient();
  // Search all inbox messages, no date limit
  const query = 'in:inbox -in:chats -in:sent';
  console.log(`  Gmail query: "${query}"`);

  const messageIds = await fetchAllInboxMessages(gmail, query);
  console.log(`  Total message IDs found: ${messageIds.length}`);

  if (messageIds.length === 0) {
    console.log('  No messages found. Exiting.');
    return;
  }

  // ── Fetch full message details ──
  const allMessages = await fetchMessageDetails(gmail, messageIds);
  console.log(`  Total messages fetched with details: ${allMessages.length}`);

  // ── Apply filters ──
  const stats = { total: allMessages.length, ignoredDomain: 0, knownContact: 0, processedAlready: 0, knownLead: 0, noEmail: 0, kept: 0 };
  const qualifying = [];

  for (const m of allMessages) {
    const fromAddr = (m.from?.address || '').toLowerCase().trim();

    if (!fromAddr || !fromAddr.includes('@')) {
      stats.noEmail++;
      continue;
    }

    if (shouldIgnoreAddress(fromAddr)) {
      stats.ignoredDomain++;
      continue;
    }

    if (knownContactEmails.has(fromAddr)) {
      stats.knownContact++;
      continue;
    }

    // Check if this specific message was already processed
    if (processedMessageIds.has(m.id)) {
      stats.processedAlready++;
      continue;
    }

    stats.kept++;
    qualifying.push(m);
  }

  console.log(`\n  ── Filter results ──`);
  console.log(`  Total scanned:           ${stats.total}`);
  console.log(`  Ignored (domain/sender): ${stats.ignoredDomain}`);
  console.log(`  Ignored (known contact): ${stats.knownContact}`);
  console.log(`  Ignored (already proc):  ${stats.processedAlready}`);
  console.log(`  Ignored (no email):      ${stats.noEmail}`);
  console.log(`  Qualifying emails:       ${stats.kept}`);

  // ── Group by thread ──
  // Use Gmail's threadId for grouping. For each thread, collect all messages
  // sorted by date, keep the earliest as the "lead" message.
  const threadMap = new Map();
  for (const m of qualifying) {
    const key = m.threadId || m.id; // fallback to message id if no threadId
    if (!threadMap.has(key)) {
      threadMap.set(key, []);
    }
    threadMap.get(key).push(m);
  }

  // Sort each thread's messages by date (earliest first)
  const threads = [];
  for (const [threadId, messages] of threadMap) {
    messages.sort((a, b) => {
      const da = a.internalDate ? new Date(a.internalDate).getTime() : 0;
      const db_ = b.internalDate ? new Date(b.internalDate).getTime() : 0;
      return da - db_;
    });

    const earliest = messages[0];
    // Combine all message bodies for classification context
    const combinedText = messages.map((m) => {
      const prefix = m === earliest ? '' : `[Follow-up ${m.internalDate}] `;
      return prefix + (m.text || '').trim();
    }).filter(Boolean).join('\n\n---\n\n');

    threads.push({
      threadId,
      messageCount: messages.length,
      messageIds: messages.map((m) => m.id),
      from_name: earliest.from?.name || '',
      from_email: (earliest.from?.address || '').trim(),
      subject: (earliest.subject || '(no subject)').slice(0, 300),
      body_text: combinedText.slice(0, 5000), // cap for sanity
      timestamp: earliest.internalDate,
      all_timestamps: messages.map((m) => m.internalDate).filter(Boolean),
    });
  }

  // Sort threads by timestamp (oldest first)
  threads.sort((a, b) => {
    const da = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const db_ = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return da - db_;
  });

  console.log(`  Unique threads (leads):  ${threads.length}`);

  // ── Deduplicate against existing leads by email ──
  const dedupedThreads = [];
  const seenEmails = new Set();
  for (const t of threads) {
    const email = t.from_email.toLowerCase();
    if (knownLeadEmails.has(email)) {
      continue; // already a lead
    }
    if (seenEmails.has(email)) {
      continue; // duplicate within this batch
    }
    seenEmails.add(email);
    dedupedThreads.push(t);
  }

  console.log(`  After lead-dedup:        ${dedupedThreads.length}`);

  // ── Write output ──
  const output = {
    extracted_at: new Date().toISOString(),
    scan_stats: stats,
    thread_count: dedupedThreads.length,
    threads: dedupedThreads,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n  Output written to: ${OUTPUT_PATH}`);
  console.log('[backfill-email-leads] Done.');
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[backfill-email-leads] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
