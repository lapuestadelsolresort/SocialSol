/**
 * Regression tests for Regina's re-selection semantics (F-050).
 *
 * (a) The status-set campaigns blocked re-selection only on
 *     sent/rejected/drafted (+ active deferred). A row left 'ambiguous' by a
 *     Resend 5xx — where the provider may in fact have accepted the email —
 *     or left 'approved' by a mid-run crash did NOT block, so the contact was
 *     selectable again and a second send row (new idempotency key) could send
 *     a duplicate email. Both statuses now block.
 *
 * (b) Anniversary eligibility blocks on ANY row inside 300 days. A send
 *     abandoned to a Resend rate limit was never delivered, yet it consumed
 *     the contact's anniversary for the year. Rate-limit-cancelled rows are
 *     now excluded from that block (auto-send also retries in-run first).
 *
 * (c) The `smoke` escape hatch bypasses eligibility SQL entirely and is
 *     `!batch`'s default slug — its contact_ids list must stay empty in Git.
 *
 * Run: node regina/lib/eligibility.test.js
 * Expect: every assertion passes; final line "✓ ALL TESTS PASSED".
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_CRM = path.join(REPO_ROOT, 'crm');
const { loadCampaign } = require('./campaign-loader');

const TEST_DB = path.join(os.tmpdir(), 'crm-regina-eligibility-test.db');

let passed = 0;
let failed = 0;

function assert(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

function setupDB() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const migrationsDir = path.join(REPO_CRM, 'migrations');
  const migrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) {
    execFileSync('sqlite3', [TEST_DB], { input: fs.readFileSync(path.join(migrationsDir, f)) });
  }
  return createDB(TEST_DB);
}

async function selectIds(db, slug, { today = '2026-08-17', batchSize = 50 } = {}) {
  const loaded = loadCampaign(slug);
  const bound = loaded.bindParams({ batchSize, today });
  const rows = await db.query(sql.__dangerous__rawValue(bound));
  return rows.map((r) => r.id);
}

async function seedContact(db, { id, email, relationship, lastStay = null, language = 'en' }) {
  await db.query(sql`
    INSERT INTO contacts (id, name, email, dedup_key, context_source, status, do_not_contact, relationship_type, last_stay_date)
    VALUES (${id}, ${'Guest ' + id}, ${email}, ${'dedup-' + id}, 'synthetic_test_fixture', 'new', 0, ${relationship}, ${lastStay})
  `);
  await db.query(sql`
    INSERT INTO guest_dossiers (contact_ids, extraction_status, extraction_model, language)
    VALUES (${JSON.stringify([id])}, 'extracted', 'test-fixture', ${language})
  `);
}

async function seedCampaign(db, { id, kind, slug }) {
  await db.query(sql`
    INSERT INTO outreach_campaigns (id, name, persona, landing_page_url, status, campaign_kind)
    VALUES (${id}, ${slug}, 'past_guest', 'https://lapuestadelsolresort.com/', 'active', ${kind})
  `);
}

async function seedSend(db, { contactId, campaignId, status, error = null, createdAt = null }) {
  await db.query(sql`
    INSERT INTO outreach_sends (contact_id, campaign_id, sequence_step, subject, body_full, status, error, created_at)
    VALUES (${contactId}, ${campaignId}, 1, 'subject', 'body', ${status}, ${error},
            ${createdAt || new Date().toISOString().slice(0, 19).replace('T', ' ')})
  `);
}

// ─── Cases ──────────────────────────────────────────────────────────────

async function testStatusSetBlocking() {
  console.log('\n=== (a) ambiguous / approved block re-selection ===');
  const db = setupDB();
  await seedCampaign(db, { id: 10, kind: 'reactivation_winback', slug: 'winback' });

  // One contact per status, all in the winback cohort.
  const cases = [
    { id: 201, status: 'ambiguous', shouldSelect: false },
    { id: 202, status: 'approved', shouldSelect: false },
    { id: 203, status: 'sent', shouldSelect: false },
    { id: 204, status: 'cancelled', shouldSelect: true },
    { id: 205, status: null, shouldSelect: true }, // never contacted
  ];
  for (const c of cases) {
    await seedContact(db, { id: c.id, email: `g${c.id}@example.com`, relationship: 'past_guest_cancelled' });
    if (c.status) await seedSend(db, { contactId: c.id, campaignId: 10, status: c.status });
  }

  const selected = await selectIds(db, 'winback_cancelled');
  for (const c of cases) {
    const got = selected.includes(c.id);
    assert(
      got === c.shouldSelect,
      `status ${c.status || 'none'} → ${c.shouldSelect ? 'selectable' : 'blocked'}`,
      { contact: c.id, selected: got },
    );
  }
  await db.dispose();
}

async function testStatusSetAppliedToEveryCampaign() {
  console.log('\n=== (a) every status-set campaign carries the same blocking set ===');
  const slugs = ['winback_cancelled', 'vip', 'referral_mining', 'inquiry_conversion', 'feedback_closure'];
  for (const slug of slugs) {
    const { sqlText } = loadCampaign(slug);
    assert(
      /s\.status IN \('sent', 'rejected', 'drafted', 'ambiguous', 'approved'\)/.test(sqlText),
      `${slug} blocks on ambiguous + approved`,
    );
  }
}

async function testAnniversaryRateLimitDoesNotConsumeTheYear() {
  console.log('\n=== (b) a rate-limited anniversary row stays selectable ===');
  const db = setupDB();
  await seedCampaign(db, { id: 20, kind: 'reactivation_anniversary', slug: 'anniversary' });

  // Both stayed on 2024-08-17, so today (08-17) is their anniversary.
  await seedContact(db, { id: 301, email: 'g301@example.com', relationship: 'past_guest_stayed', lastStay: '2024-08-17' });
  await seedContact(db, { id: 302, email: 'g302@example.com', relationship: 'past_guest_stayed', lastStay: '2024-08-17' });
  await seedContact(db, { id: 303, email: 'g303@example.com', relationship: 'past_guest_stayed', lastStay: '2024-08-17' });

  // 301: abandoned to a rate limit today — never delivered.
  await seedSend(db, { contactId: 301, campaignId: 20, status: 'cancelled', error: 'resend_rate_limit' });
  // 302: actually sent today.
  await seedSend(db, { contactId: 302, campaignId: 20, status: 'sent' });
  // 303: cancelled for a different reason (compliance) — still consumes the year.
  await seedSend(db, { contactId: 303, campaignId: 20, status: 'cancelled', error: 'compliance_gate:item_1_in_suppressions' });

  const selected = await selectIds(db, 'anniversary', { today: '2026-08-17' });
  assert(selected.includes(301), 'rate-limited row does not consume the anniversary', selected);
  assert(!selected.includes(302), 'a real send still blocks for the year', selected);
  assert(!selected.includes(303), 'a non-rate-limit cancel still blocks for the year', selected);
  await db.dispose();
}

async function testSmokeEscapeHatchIsEmpty() {
  console.log('\n=== (c) the smoke escape hatch carries no contact ids ===');
  const { config } = loadCampaign('smoke');
  assert(Array.isArray(config.contact_ids), 'smoke still declares contact_ids (loader escape hatch)');
  assert(config.contact_ids.length === 0, 'smoke contact_ids is empty in Git', config.contact_ids);
}

async function main() {
  await testStatusSetBlocking();
  await testStatusSetAppliedToEveryCampaign();
  await testAnniversaryRateLimitDoesNotConsumeTheYear();
  await testSmokeEscapeHatchIsEmpty();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('✗ TESTS FAILED');
    process.exit(1);
  }
  console.log('✓ ALL TESTS PASSED');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
