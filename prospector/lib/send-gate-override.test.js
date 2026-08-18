/**
 * Regression tests for the send-time edit-override carve-out (F-047).
 *
 * The carve-out exists so that a human rewrite which trips a CONTENT check
 * (item 6 why-contacting disclosure, item 7 banned phrase) still sends. It
 * used to downgrade EVERY failed item to advisory, including the consent
 * hard stops — a suppressed or do_not_contact address with an edit_override
 * marker was sent to (QC-7a FIXTURE case D). These tests pin the scoped
 * behavior: items 1-5 always enforce at send time.
 *
 * Run: node prospector/lib/send-gate-override.test.js
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

// The orchestrator resolves secrets at call time through the runtime-paths
// env contract. Point it at a scratch dir holding only an unsubscribe secret:
// no zerobounce.json means verifyEmail gets a null apiKey and fails closed
// without any network I/O. Must be set before requiring the orchestrator.
const SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paulina-gate-secrets-'));
fs.writeFileSync(
  path.join(SECRETS_DIR, 'unsubscribe.json'),
  JSON.stringify({ secret: 'test-only-unsubscribe-secret' }),
);
process.env.SOCIALSOL_SECRETS_DIR = SECRETS_DIR;
// No Slack account configured → postSlackThreadReply short-circuits, no spawn.
delete process.env.OPENCLAW_SLACK_ACCOUNT;

const compliance = require('./compliance');
const { processSend } = require('../orchestrator');

// Stub Slack so recordComplianceFailure never posts.
const slackPosts = [];
compliance._setSlackForTesting(
  async (channel, message) => { slackPosts.push({ channel, message }); return { ok: true }; },
  () => 'CTEST123',
);

// Nothing in these cases may reach a provider. Any fetch is a test failure.
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  throw new Error(`unexpected network call: ${url}`);
};

const TEST_DB = path.join(os.tmpdir(), 'crm-send-gate-override-test.db');
const PHYSICAL_ADDRESS =
  'Del Mirador 300, Pescadores, 63720 La Peñita de Jaltemba, Nayarit, Mexico';

const CONFIG = {
  physical_address: PHYSICAL_ADDRESS,
  weekly_send_caps: { week_1: 5, week_2: 10, week_3: 15, week_4_plus: 20 },
  email_verification: { fail_closed: true },
  slack: { draft_review_channel_id: 'CTEST123' },
};

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

/**
 * Seed one campaign, one contact and one approved send row.
 * Role-based address (`info@`) so the post-gate verification stage blocks
 * before any DNS or ZeroBounce call — see the carve-out case below.
 */
async function seed(db, { email = 'info@example.com', doNotContact = 0, body, subject }) {
  await db.query(sql`
    INSERT INTO outreach_campaigns (id, name, persona, landing_page_url, status)
    VALUES (1, 'planner_outreach_v1', 'wedding_planner', 'https://planners.lapuestadelsolresort.com/', 'active')
  `);
  await db.query(sql`
    INSERT INTO contacts (id, name, email, dedup_key, context_source, status, do_not_contact)
    VALUES (1001, 'Vanessa Example', ${email}, 'vanessa-test', 'synthetic_test_fixture', 'new', ${doNotContact})
  `);
  await db.query(sql`
    INSERT INTO outreach_sends (id, contact_id, campaign_id, sequence_step, subject, body_full, body_preview, status, scheduled_at)
    VALUES (1, 1001, 1, 1, ${subject}, ${body}, ${body.slice(0, 200)}, 'approved', datetime('now'))
  `);
  return {
    send: { id: 1, subject, body_full: body, slack_channel_id: null, slack_message_ts: null },
    contact: { id: 1001, email },
    campaign: { id: 1, slug: 'planner_outreach_v1', name: 'planner_outreach_v1', allowRoleEmails: false },
  };
}

async function markEditOverride(db) {
  await db.query(sql`
    INSERT INTO compliance_failures (contact_id, outreach_send_id, failed_check, details, source)
    VALUES (1001, 1, 'item_6_no_disclosure_pattern', null, 'edit_override')
  `);
}

async function rowState(db) {
  const rows = await db.query(sql`SELECT status, error FROM outreach_sends WHERE id = 1`);
  return rows[0];
}

async function failureSources(db) {
  const rows = await db.query(sql`
    SELECT source, failed_check FROM compliance_failures WHERE outreach_send_id = 1 AND source != 'edit_override'
  `);
  return rows;
}

// A body that passes item 6 (the "i came across" disclosure pattern).
// processSend renders the compliance footer itself, so the seeded body needs
// no postal address (item 5) and no unsubscribe token (item 4) — those come
// from renderHtmlBody + buildUnsubscribeArtifacts inside the pipeline.
function compliantBody() {
  return [
    `Hi there, I came across your portfolio and thought of La Puesta del Sol.`,
    `Take a look — https://planners.lapuestadelsolresort.com/ — and see if the venue partner program fits.`,
  ].join('\n');
}

// ─── Cases ──────────────────────────────────────────────────────────────

async function testSuppressedWithOverrideIsCancelled() {
  console.log('\n=== item_1 suppression + edit_override → cancelled, never sent ===');
  const db = setupDB();
  const body = compliantBody();
  const fx = await seed(db, { body, subject: 'A note about your weddings' });
  await db.query(sql`INSERT INTO suppressions (email, reason) VALUES ('info@example.com', 'unsubscribed')`);
  await markEditOverride(db);

  const before = fetchCalls.length;
  const result = await processSend(db, CONFIG, fx.send, fx.contact, fx.campaign);
  const row = await rowState(db);
  const sources = await failureSources(db);

  assert(result.ok === false && result.reason === 'gate_failed', 'processSend reports gate_failed', result);
  assert(row.status === 'cancelled', 'send row is cancelled', row);
  assert(String(row.error || '').startsWith('compliance_send_time:'), 'error records a send-time compliance stop', row);
  assert(String(row.error || '').includes('item_1_in_suppressions'), 'error names the suppression item', row);
  assert(sources.every((r) => r.source === 'send_time'), 'failures logged as send_time, not send_time_override', sources);
  assert(fetchCalls.length === before, 'no provider call was made', fetchCalls.slice(before));
  await db.dispose();
}

async function testDoNotContactWithOverrideIsCancelled() {
  console.log('\n=== item_2 do_not_contact + edit_override → cancelled, never sent ===');
  const db = setupDB();
  const body = compliantBody();
  const fx = await seed(db, { body, subject: 'A note about your weddings', doNotContact: 1 });
  await markEditOverride(db);

  const before = fetchCalls.length;
  const result = await processSend(db, CONFIG, fx.send, fx.contact, fx.campaign);
  const row = await rowState(db);
  const sources = await failureSources(db);

  assert(result.ok === false && result.reason === 'gate_failed', 'processSend reports gate_failed', result);
  assert(row.status === 'cancelled', 'send row is cancelled', row);
  assert(String(row.error || '').includes('item_2_do_not_contact'), 'error names the do_not_contact item', row);
  assert(sources.every((r) => r.source === 'send_time'), 'failures logged as send_time, not send_time_override', sources);
  assert(fetchCalls.length === before, 'no provider call was made', fetchCalls.slice(before));
  await db.dispose();
}

async function testContentOnlyOverrideStillCarvesOut() {
  console.log('\n=== item_7 banned phrase + edit_override → carve-out still applies ===');
  const db = setupDB();
  // 'quick question' is a banned phrase → item_7 fails, items 1-5 pass.
  const body = compliantBody();
  const fx = await seed(db, { body, subject: 'Quick question about your destination weddings' });
  await markEditOverride(db);

  const before = fetchCalls.length;
  const result = await processSend(db, CONFIG, fx.send, fx.contact, fx.campaign);
  const row = await rowState(db);
  const sources = await failureSources(db);

  assert(sources.some((r) => r.source === 'send_time_override'), 'content failure logged as send_time_override', sources);
  assert(
    !String(row.error || '').startsWith('compliance_send_time:'),
    'the gate did NOT cancel the row — the carve-out let it through',
    row,
  );
  // The send is then stopped by the verification stage (role-based address),
  // which is what keeps this regression test off the network.
  assert(result.ok === false, 'the send still stops later in the pipeline', result);
  assert(
    String(result.reason || '').startsWith('email_verification_failed'),
    'stopped at verification, not at the compliance gate',
    result,
  );
  assert(fetchCalls.length === before, 'no provider call was made', fetchCalls.slice(before));
  await db.dispose();
}

async function testConsentItemsConstant() {
  console.log('\n=== the carve-out scope is items 1-5 ===');
  const { CONSENT_ITEMS } = require('../orchestrator');
  assert(
    JSON.stringify(CONSENT_ITEMS) === JSON.stringify([1, 2, 3, 4, 5]),
    'CONSENT_ITEMS covers suppression, DNC, cap, token and postal address',
    CONSENT_ITEMS,
  );
}

async function main() {
  await testSuppressedWithOverrideIsCancelled();
  await testDoNotContactWithOverrideIsCancelled();
  await testContentOnlyOverrideStillCarvesOut();
  await testConsentItemsConstant();

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
