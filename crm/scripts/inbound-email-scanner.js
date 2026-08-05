#!/usr/bin/env node
'use strict';
//
// crm/scripts/inbound-email-scanner.js — scan Sarah's Gmail inbox for genuine
// new inbound inquiries that are NOT replies to our outreach, and auto-create
// CRM leads + post Slack notifications.
//
// Runs every 15 minutes from com.lapuestadelsolresort.inbound-email-scanner.
// Uses the same Gmail DWD service-account as gmail-reply-forwarder.
//
// Flags:
//   --dry-run   Log what would be created, no DB writes, no Slack posts.

const path = require('path');
const { execFile } = require('child_process');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { searchInboxSince } = require('../lib/gmail-client');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');
const SCAN_MINUTES = Number(process.env.SCAN_MINUTES) || 120;
const DRY_RUN = process.argv.includes('--dry-run');

const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const SOCIAL_SOL_CHANNEL = process.env.RESORT_SOCIAL_CHANNEL || '';

// Domains / patterns to filter out (no-reply, transactional, internal)
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
]);

function openDb() {
  return createDB(DB_PATH);
}

function shouldIgnoreAddress(address) {
  if (!address) return true;
  const lower = address.toLowerCase().trim();
  const [local, domain] = lower.split('@');
  if (!domain) return true;

  // Ignore known transactional domains
  if (IGNORE_DOMAINS.has(domain)) return true;

  // Ignore known no-reply local parts
  if (IGNORE_LOCAL_PARTS.has(local)) return true;

  // Ignore noreply-style patterns
  if (/^(no[-_.]?reply|mailer[-_.]?daemon|bounce)/i.test(local)) return true;

  return false;
}

function postToSlack(message) {
  return new Promise((resolve) => {
    if (!SLACK_ACCOUNT) {
      console.warn('[inbound-email-scanner] Slack not configured (no OPENCLAW_SLACK_ACCOUNT)');
      resolve(null);
      return;
    }
    execFile(OPENCLAW, [
      'message', 'send',
      '--channel', 'slack',
      '--account', SLACK_ACCOUNT,
      '--target', `channel:${SOCIAL_SOL_CHANNEL}`,
      '--message', message,
    ], { timeout: 12000 }, (err) => {
      if (err) {
        console.warn('[inbound-email-scanner] Slack post failed:', err.message);
      }
      resolve(null);
    });
  });
}

async function alreadyProcessed(db, messageId) {
  const rows = await db.query(sql`
    SELECT 1 FROM processed_gmail_replies WHERE message_id = ${messageId} LIMIT 1
  `);
  return rows.length > 0;
}

async function recordProcessed(db, messageId) {
  const now = new Date().toISOString();
  await db.query(sql`
    INSERT OR IGNORE INTO processed_gmail_replies (message_id, forwarded_at, send_id, matched)
    VALUES (${messageId}, ${now}, ${null}, ${0})
  `);
}

async function loadKnownContactEmails(db) {
  const rows = await db.query(sql`
    SELECT LOWER(email) AS email FROM contacts WHERE email IS NOT NULL
  `);
  return new Set(rows.map((r) => r.email).filter(Boolean));
}

async function loadKnownLeadEmails(db) {
  const rows = await db.query(sql`
    SELECT LOWER(email) AS email FROM leads WHERE email IS NOT NULL
  `);
  return new Set(rows.map((r) => r.email).filter(Boolean));
}

async function run() {
  if (DRY_RUN) console.log('[inbound-email-scanner] DRY-RUN — no DB writes, no Slack posts');

  let messages;
  try {
    messages = await searchInboxSince(SCAN_MINUTES);
  } catch (e) {
    console.error('[inbound-email-scanner] Gmail search failed:', e.message);
    process.exit(1);
  }

  console.log(`[inbound-email-scanner] inbox messages found in last ${SCAN_MINUTES}m: ${messages.length}`);

  const db = DRY_RUN ? null : openDb();
  let created = 0;
  let skipped = 0;
  let filtered = 0;

  try {
    const knownContactEmails = DRY_RUN ? new Set() : await loadKnownContactEmails(db);
    const knownLeadEmails = DRY_RUN ? new Set() : await loadKnownLeadEmails(db);

    for (const m of messages) {
      try {
        const fromAddr = (m.from && m.from.address || '').toLowerCase().trim();
        const fromName = (m.from && m.from.name) || fromAddr.split('@')[0] || 'Unknown';

        // Filter 1: Ignore known no-reply / transactional / internal senders
        if (shouldIgnoreAddress(fromAddr)) {
          filtered++;
          continue;
        }

        // Filter 2: Ignore emails from known outreach contacts
        if (knownContactEmails.has(fromAddr)) {
          filtered++;
          continue;
        }

        // Filter 3: Ignore reply threads (In-Reply-To present AND original is in processed_gmail_replies)
        if (m.inReplyTo && !DRY_RUN) {
          // The In-Reply-To references a Message-ID; check if we've seen it
          const refId = m.inReplyTo.replace(/^<|>$/g, '').trim();
          const [existing] = await db.query(sql`
            SELECT 1 FROM processed_gmail_replies WHERE message_id = ${refId} LIMIT 1
          `);
          if (existing) {
            filtered++;
            continue;
          }
        }

        // Deduplicate: already processed this message ID?
        if (!DRY_RUN && await alreadyProcessed(db, m.id)) {
          skipped++;
          continue;
        }

        // Skip if we already have a lead with this email
        if (knownLeadEmails.has(fromAddr)) {
          if (!DRY_RUN) await recordProcessed(db, m.id);
          skipped++;
          continue;
        }

        const bodyText = (m.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const subject = (m.subject || '(no subject)').slice(0, 200);
        const inquirySnippet = bodyText.slice(0, 500);
        const previewSnippet = bodyText.slice(0, 200);
        const now = new Date().toISOString();

        if (DRY_RUN) {
          console.log(`  [would create] lead: ${fromName} <${fromAddr}> — Subject: ${subject}`);
          console.log(`    Preview: ${previewSnippet.slice(0, 120)}…`);
          created++;
          continue;
        }

        // Create lead
        await db.query(sql`
          INSERT INTO leads (name, email, source, status, inquiry_message, notes)
          VALUES (
            ${fromName},
            ${m.from.address},
            'email_inbound',
            'new',
            ${inquirySnippet},
            ${'Auto-created from inbound email scan on ' + now}
          )
        `);
        created++;

        // Record as processed so we don't re-scan
        await recordProcessed(db, m.id);

        // Add to known set to avoid duplicates within this run
        knownLeadEmails.add(fromAddr);

        // Post Slack notification
        const slackMsg =
          `📧 *New inbound inquiry detected*\n` +
          `*From:* ${fromName} <${m.from.address}>\n` +
          `*Subject:* ${subject}\n` +
          `*Preview:* ${previewSnippet || '(empty body)'}${bodyText.length > 200 ? '…' : ''}\n` +
          `_Auto-detected from Sarah's inbox — lead created in CRM._`;
        await postToSlack(slackMsg);

        console.log(`[inbound-email-scanner] created lead: ${fromName} <${fromAddr}> — ${subject}`);
      } catch (e) {
        console.error(`[inbound-email-scanner] message ${m.id} failed:`, e.message);
      }
    }
  } finally {
    if (db) await db.dispose();
  }

  console.log(
    `[inbound-email-scanner] scanned=${messages.length} created=${created} ` +
    `skipped=${skipped} filtered=${filtered}`
  );
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[inbound-email-scanner] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
