#!/usr/bin/env node
'use strict';
//
// crm/scripts/apply-staging-approvals.js
//
// Drains pending_contacts_staging rows that have been approved via
// !staging-approve (status='approved') into the live `contacts` table:
//
//   suggested_action='create'  → INSERT a new contact with contact_provenance='direct_email'
//   suggested_action='enrich'  → UPDATE the matched existing contact (additive only)
//
// After applying, flips the staging row to status='applied' and records
// applied_at + applied_contact_id (audit trail).
//
// Idempotent — rerunning skips rows already at 'applied'. Safe to invoke
// after every !staging-approve batch.
//
// Flags:
//   --dry-run    Show what would happen, no writes
//   --limit N    Cap processed rows in one invocation (default: unlimited)

const path = require('path');

const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');

function parseFlags(argv) {
  const out = { dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Number(argv[++i]) || Infinity;
  }
  return out;
}

function fallbackNameFromEmail(email) {
  if (!email) return 'Direct email contact';
  const local = email.split('@')[0] || '';
  if (!local) return 'Direct email contact';
  // crude title-case from local part, drop common separators
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ') || 'Direct email contact';
}

async function loadApproved(db, limit) {
  const rows = await db.query(sql`
    SELECT * FROM pending_contacts_staging
    WHERE status = 'approved'
    ORDER BY id ASC
    LIMIT ${limit === Infinity ? 10000 : limit}
  `);
  return rows;
}

async function applyCreate(db, row) {
  const email = row.extracted_email.toLowerCase();
  const dedupKey = email;
  const name = row.extracted_name || fallbackNameFromEmail(email);

  // Guard against a same-email contact that may have been created since
  // the staging row was written. If so, fall through to enrich instead.
  const existing = await db.query(sql`
    SELECT id FROM contacts WHERE dedup_key = ${dedupKey} OR LOWER(email) = ${email} LIMIT 1
  `);
  if (existing.length > 0) {
    return { action: 'enrich_fallback', contactId: existing[0].id };
  }

  const source = `gmail_direct_import_${row.batch_id}`;
  const inserted = await db.query(sql`
    INSERT INTO contacts (
      name, email, dedup_key, context_source, source, status,
      contact_provenance, preferred_channel
    ) VALUES (
      ${name}, ${email}, ${dedupKey}, 'gmail_direct_inquiry', ${source}, 'new',
      'direct_email', NULL
    )
    RETURNING id
  `);
  return { action: 'created', contactId: inserted[0].id };
}

async function applyEnrich(db, row, contactId) {
  const email = row.extracted_email.toLowerCase();
  // Additive only: fill email if blank, fill preferred_channel if blank,
  // bump updated_at. Do not overwrite name, relationship_type, or any
  // other existing values.
  await db.query(sql`
    UPDATE contacts
    SET
      email = COALESCE(email, ${email}),
      preferred_channel = COALESCE(preferred_channel, 'email'),
      updated_at = datetime('now')
    WHERE id = ${contactId}
  `);
  return { action: 'enriched', contactId };
}

async function markApplied(db, stagingId, contactId) {
  await db.query(sql`
    UPDATE pending_contacts_staging
    SET status = 'applied',
        applied_at = ${new Date().toISOString()},
        applied_contact_id = ${contactId}
    WHERE id = ${stagingId}
  `);
}

async function run() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[apply-staging] flags:', flags);

  const db = createDB(DB_PATH);
  const summary = { created: 0, enriched: 0, enrich_fallback: 0, skipped_no_action: 0 };

  try {
    const rows = await loadApproved(db, flags.limit);
    console.log(`[apply-staging] approved rows: ${rows.length}`);

    for (const row of rows) {
      if (row.suggested_action !== 'create' && row.suggested_action !== 'enrich') {
        console.log(`  - id=${row.id} suggested_action=${row.suggested_action} — leaving as approved (not applicable)`);
        summary.skipped_no_action += 1;
        continue;
      }

      if (flags.dryRun) {
        console.log(
          `  [dry] id=${row.id} action=${row.suggested_action} email=${row.extracted_email}` +
          ` existing_contact_id=${row.existing_contact_id || 'none'}`
        );
        continue;
      }

      let result;
      try {
        if (row.suggested_action === 'create') {
          result = await applyCreate(db, row);
        } else {
          result = await applyEnrich(db, row, row.existing_contact_id);
        }
        await markApplied(db, row.id, result.contactId);
        summary[result.action] = (summary[result.action] || 0) + 1;
        console.log(
          `  applied id=${row.id} ${result.action} → contact #${result.contactId}` +
          ` (${row.extracted_email})`
        );
      } catch (e) {
        console.error(`  FAILED id=${row.id} ${row.extracted_email}: ${e.message}`);
      }
    }
  } finally {
    await db.dispose();
  }

  console.log('[apply-staging] summary:', summary);
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[apply-staging] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
