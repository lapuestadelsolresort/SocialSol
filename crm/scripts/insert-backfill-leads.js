#!/usr/bin/env node
'use strict';
//
// crm/scripts/insert-backfill-leads.js — Insert classified backfill leads
// into the CRM and record message IDs in processed_gmail_replies.
//
// Reads backfill-classified.json + backfill-emails.json, inserts leads,
// records all associated Gmail message IDs to prevent future duplication.
//
// Usage:
//   node crm/scripts/insert-backfill-leads.js [--dry-run]

const path = require('path');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');
const DRY_RUN = process.argv.includes('--dry-run');

const classified = require('../data/backfill-classified.json');
const extracted = require('../data/backfill-emails.json');

// Build a lookup: idx → thread (for messageIds)
const threadsByIdx = new Map();
for (const t of extracted.threads) {
  // Match by from_email since idx ordering is the same
}
// Actually use from_email + timestamp to match
const extractedByEmail = new Map();
for (const t of extracted.threads) {
  const key = t.from_email.toLowerCase();
  extractedByEmail.set(key, t);
}

async function run() {
  console.log('[insert-backfill-leads] Starting insertion...');
  if (DRY_RUN) console.log('  (DRY-RUN mode)');

  const leads = classified.threads.filter((t) => !t.exclude);
  const excluded = classified.threads.filter((t) => t.exclude);

  console.log(`  Total classified: ${classified.threads.length}`);
  console.log(`  Excluded:         ${excluded.length}`);
  console.log(`  To insert:        ${leads.length}`);

  if (DRY_RUN) {
    for (const l of leads) {
      console.log(`  [would insert] ${l.from_name || l.from_email} — ${l.inquiry_category} / ${l.intent_strength} — ${l.subject}`);
    }
    console.log(`\n  [would record] message IDs for all ${classified.threads.length} threads (including excluded) to prevent reprocessing`);
    return;
  }

  const db = createDB(DB_PATH);
  let inserted = 0;
  let skipped = 0;
  let messageIdsRecorded = 0;

  try {
    // Check for existing email_inbound leads to avoid duplicates
    const existingLeads = await db.query(sql`
      SELECT LOWER(email) AS email FROM leads WHERE source = 'email_inbound' AND email IS NOT NULL
    `);
    const existingEmails = new Set(existingLeads.map((r) => r.email));

    for (const lead of leads) {
      const email = lead.from_email.toLowerCase();

      if (existingEmails.has(email)) {
        console.log(`  [skip] ${email} — already exists as email_inbound lead`);
        skipped++;
        continue;
      }

      // Build inquiry_message from extracted body
      const extractedThread = extractedByEmail.get(email);
      const inquiryMessage = extractedThread
        ? (extractedThread.body_text || '').slice(0, 1000)
        : '';

      const createdAt = lead.timestamp || new Date().toISOString();
      const now = new Date().toISOString();

      await db.query(sql`
        INSERT INTO leads (
          name, email, source, status, inquiry_message, notes,
          created_at, updated_at,
          inquiry_category, intent_strength, group_size_mentioned,
          requested_dates, referral_source_clue, analysis_summary
        ) VALUES (
          ${lead.from_name || null},
          ${lead.from_email},
          'email_inbound',
          ${lead.status || 'new'},
          ${inquiryMessage},
          ${'Backfill: ' + lead.subject},
          ${createdAt},
          ${now},
          ${lead.inquiry_category || null},
          ${lead.intent_strength || null},
          ${lead.group_size_mentioned || null},
          ${lead.requested_dates || null},
          ${lead.referral_source_clue || null},
          ${lead.analysis_summary || null}
        )
      `);

      inserted++;
      existingEmails.add(email); // prevent intra-batch duplicates
      console.log(`  [inserted] ${lead.from_name || email} — ${lead.inquiry_category} / ${lead.intent_strength}`);
    }

    // Record ALL message IDs (including excluded threads) to prevent future reprocessing
    console.log('\n  Recording message IDs in processed_gmail_replies...');
    const now = new Date().toISOString();

    for (const thread of extracted.threads) {
      for (const msgId of (thread.messageIds || [])) {
        try {
          await db.query(sql`
            INSERT OR IGNORE INTO processed_gmail_replies (message_id, forwarded_at, send_id, matched)
            VALUES (${msgId}, ${now}, ${null}, ${0})
          `);
          messageIdsRecorded++;
        } catch (e) {
          // Ignore duplicates
        }
      }
    }

    console.log(`\n  ── Results ──`);
    console.log(`  Leads inserted:     ${inserted}`);
    console.log(`  Leads skipped:      ${skipped}`);
    console.log(`  Message IDs rec'd:  ${messageIdsRecorded}`);

  } finally {
    await db.dispose();
  }

  console.log('[insert-backfill-leads] Done.');
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[insert-backfill-leads] fatal:', e);
    process.exit(1);
  });
}
