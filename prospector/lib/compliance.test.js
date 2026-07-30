/**
 * Unit tests for the compliance gate (Phase D Step 3.1b).
 *
 * Exercises each of the 7 items with passing + failing fixtures, plus an
 * aggregate multi-failure case to validate the `failures` array shape and
 * the `pauseCampaign` matrix.
 *
 * Run: node prospector/lib/compliance.test.js
 * Expect: every assertion passes; final line "✓ ALL TESTS PASSED".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_CRM = path.join(REPO_ROOT, 'crm');
const REPO_PROSPECTOR = path.join(REPO_ROOT, 'prospector');

const u = require(`${REPO_CRM}/lib/unsubscribe`);
u.setSecret('test-only-unsubscribe-secret');

const compliance = require('./compliance');
const { buildUnsubscribeArtifacts } = require('./headers');

// Stub Slack so recordComplianceFailure tests don't actually post.
let slackPosts = [];
compliance._setSlackForTesting(
  async (channel, message) => {
    slackPosts.push({ channel, message });
    return { ok: true };
  },
  () => 'CTEST123'
);

const TEST_DB = '/tmp/crm-compliance-test.db';
const PHYSICAL_ADDRESS =
  'Del Mirador 300, Pescadores, 63720 La Peñita de Jaltemba, Nayarit, Mexico';

function setupDB() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  // Apply all migrations in sorted order from ${REPO_CRM}/migrations/*.sql.
  // Naming convention is NNN_description.sql, so sort = chronological.
  // Future migrations are picked up automatically — do NOT add inline ALTERs
  // here. Drift between this test setup and production schema cost ~10 min of
  // diagnosis on 2026-05-06 when migration 004 added compliance_failures.source
  // and this file still only applied 001 + inline reproductions of 002/003.
  const migrationsDir = path.join(REPO_CRM, 'migrations');
  const migrations = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of migrations) {
    execFileSync('sqlite3', [TEST_DB], {
      input: fs.readFileSync(path.join(migrationsDir, f)),
    });
  }
  return createDB(TEST_DB);
}

const CONFIG = {
  physical_address: PHYSICAL_ADDRESS,
  weekly_send_caps: {
    week_1: 5,
    week_2: 10,
    week_3: 15,
    week_4_plus: 20,
  },
};

let passed = 0;
let failed = 0;

function assert(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

function compliantBody(token) {
  return [
    `Hi Vanessa, I came across your portfolio and thought of La Puesta del Sol.`,
    `We're a 9-suite resort in Riviera Nayarit doing private buyouts for weddings.`,
    `Take a look — https://weddings.lapuestadelsolresort.com — see if it's a fit for any upcoming clients.`,
    ``,
    PHYSICAL_ADDRESS,
    `Reply 'unsubscribe' to unsubscribe@outreach.lapuestadelsolresort.com or click here to unsubscribe: https://webhook.lapuestadelsolresort.com/unsubscribe?token=${token}`,
  ].join('\n');
}

async function buildBaseInput(db, contactId, campaignId, campaignName) {
  const { token, headers } = buildUnsubscribeArtifacts(contactId, campaignName);
  return {
    email: 'vanessa@example.com',
    contactId,
    campaignId,
    campaignName,
    subject: 'Quick question about your destination weddings',
    // ^ note: 'quick question' IS a banned phrase. Tests that need clean
    // subject must override.
    body: compliantBody(token),
    headers,
    whyContactingPresent: true,
    whyContactingSource: 'public portfolio',
  };
}

async function seedFixture(db) {
  // One campaign, one contact, no suppressions, no prior sends.
  await db.query(sql`
    INSERT INTO outreach_campaigns (id, name, persona, landing_page_url, status)
    VALUES (1, 'planner_outreach_v1', 'wedding_planner', 'https://weddings.lapuestadelsolresort.com', 'active')
  `);
  await db.query(sql`
    INSERT INTO contacts (id, name, email, dedup_key, context_source, status, do_not_contact)
    VALUES (1001, 'Vanessa Example', 'vanessa@example.com', 'vanessa-test', 'synthetic_test_fixture', 'new', 0)
  `);
}

// ─── Tests ──────────────────────────────────────────────────────────────

async function testItem1() {
  console.log('\n=== Item 1: not in suppressions ===');
  const db = setupDB();
  await seedFixture(db);

  // Passing: clean.
  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello'; // avoid banned-phrase noise
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[1] === true, 'item 1 passes when email not suppressed', r.items);
  assert(!r.failures.some((f) => f.startsWith('item_1')), 'no item_1 failure', r.failures);

  // Failing: insert suppression.
  await db.query(sql`
    INSERT INTO suppressions (email, reason, source, added_by)
    VALUES ('vanessa@example.com', 'manual', 'slack_command', 'slack_command:UTEST123')
  `);
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[1] === false, 'item 1 fails when email suppressed');
  assert(r.failures.includes('item_1_in_suppressions'), 'failure code present', r.failures);
  assert(r.pauseCampaign === true, 'item 1 fail triggers pauseCampaign');

  await db.dispose();
}

async function testItem2() {
  console.log('\n=== Item 2: contact.do_not_contact = 0 ===');
  const db = setupDB();
  await seedFixture(db);

  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[2] === true, 'item 2 passes when DNC=0');

  await db.query(sql`UPDATE contacts SET do_not_contact = 1 WHERE id = 1001`);
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[2] === false, 'item 2 fails when DNC=1');
  assert(r.failures.includes('item_2_do_not_contact'), 'failure code present', r.failures);
  assert(r.pauseCampaign === true, 'item 2 fail triggers pauseCampaign');

  await db.dispose();
}

async function testItem3() {
  console.log('\n=== Item 3: weekly cap ===');
  const db = setupDB();
  await seedFixture(db);

  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';

  // Pass: zero sends so far.
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[3] === true, 'item 3 passes at count=0/cap=5');

  // Fail: 5 sends already this week (cap = 5 for week 1, NULL first_send_at).
  // Insert sends with sent_at "now" so they fall in current calendar week.
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    await db.query(sql`
      INSERT INTO outreach_sends (contact_id, campaign_id, subject, body_full, status, sent_at)
      VALUES (1001, 1, 'old', 'old', 'sent', ${now})
    `);
  }
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[3] === false, 'item 3 fails at count=5/cap=5');
  const f3 = r.failures.find((f) => f.startsWith('item_3_'));
  assert(/count=5/.test(f3), 'failure includes count', f3);
  assert(/cap=5/.test(f3), 'failure includes cap', f3);
  assert(/week=1/.test(f3), 'week_index = 1 when first_send_at is NULL', f3);
  assert(r.pauseCampaign === true, 'item 3 fail triggers pauseCampaign');

  // Stamp first_send_at to 3 calendar weeks ago — cap should be week_4_plus (20).
  // 3 weeks ago Monday at 00:00 PT.
  const now2 = new Date();
  const threeWeeksAgo = new Date(now2.getTime() - 21 * 24 * 3600 * 1000);
  await db.query(
    sql`UPDATE outreach_campaigns SET first_send_at = ${threeWeeksAgo.toISOString()} WHERE id = 1`
  );
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  // count = 5 (still), cap should now be 20 (week 4+, since 3 calendar weeks have passed → cap_index = 4)
  assert(r.items[3] === true, 'item 3 passes at count=5/cap=20 (week_4_plus)');

  await db.dispose();
}

async function testItem4() {
  console.log('\n=== Item 4: token signs to contact (header AND body) ===');
  const db = setupDB();
  await seedFixture(db);

  // Passing: matching token in both surfaces.
  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[4] === true, 'item 4 passes when tokens match contactId');

  // Failing 1: token signed for a different contactId.
  const wrong = buildUnsubscribeArtifacts(9999, 'planner_outreach_v1');
  input.headers = wrong.headers;
  input.body = compliantBody(wrong.token);
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[4] === false, 'item 4 fails on mismatched contactId');
  assert(
    r.failures.some((f) => f.startsWith('item_4_token_mismatch:header')),
    'header mismatch flagged',
    r.failures
  );
  assert(
    r.failures.some((f) => f.startsWith('item_4_token_mismatch:body')),
    'body mismatch flagged',
    r.failures
  );

  // Failing 2: no token in headers at all (header value missing entirely).
  input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  input.headers = {}; // strip
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[4] === false, 'item 4 fails when header lacks URL');
  assert(r.failures.includes('item_4_no_token_in_header'), 'no_token_in_header flagged');

  // Failing 3: no token in body.
  input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  input.body = `${PHYSICAL_ADDRESS}\nReply 'unsubscribe' — no link in body.`;
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[4] === false, 'item 4 fails when body lacks URL');
  assert(r.failures.includes('item_4_no_token_in_body'), 'no_token_in_body flagged');

  // Failing 4: tampered token in header.
  input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  const tampered = input.headers['List-Unsubscribe'].replace(
    /token=[^>]+>/,
    'token=152.planner_outreach_v1.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz>'
  );
  input.headers['List-Unsubscribe'] = tampered;
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[4] === false, 'item 4 fails on tampered HMAC');
  assert(
    r.failures.some((f) => f.startsWith('item_4_token_invalid:header')),
    'token_invalid:header flagged',
    r.failures
  );

  await db.dispose();
}

async function testItem5() {
  console.log('\n=== Item 5: postal address present ===');
  const db = setupDB();
  await seedFixture(db);

  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[5] === true, 'item 5 passes with full canonical address');

  // Truncate address.
  input.body = input.body.replace('Del Mirador 300, Pescadores, 63720', 'Del Mirador 300');
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[5] === false, 'item 5 fails with truncated address');
  assert(r.failures.includes('item_5_postal_address_missing'), 'address_missing flagged');

  await db.dispose();
}

async function testItem6() {
  console.log('\n=== Item 6: why-contacting (pattern + manual) ===');
  const db = setupDB();
  await seedFixture(db);

  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[6] === 'manual', 'item 6 returns manual when pattern matches', r.items);

  // No-pattern body — generic opener.
  const { token } = buildUnsubscribeArtifacts(1001, 'planner_outreach_v1');
  input.body = [
    `Hi Vanessa,`,
    `Wanted to share a venue option for destination weddings — La Puesta del Sol in Riviera Nayarit.`,
    `https://weddings.lapuestadelsolresort.com`,
    ``,
    PHYSICAL_ADDRESS,
    `Reply 'unsubscribe' to unsubscribe@outreach.lapuestadelsolresort.com or click here to unsubscribe: https://webhook.lapuestadelsolresort.com/unsubscribe?token=${token}`,
  ].join('\n');
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[6] === false, 'item 6 fails on no recipient-anchor pattern', r.items);
  assert(r.failures.includes('item_6_no_disclosure_pattern'), 'disclosure_pattern code present');
  assert(r.pauseCampaign === true, 'item 6 pattern-fail triggers pauseCampaign');

  // Composer asserts whyContactingPresent = false → same failure.
  input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  input.whyContactingPresent = false;
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[6] === false, 'item 6 fails when composer asserts false');
  assert(r.failures.includes('item_6_no_disclosure_pattern'), 'disclosure code on composer-false');

  await db.dispose();
}

async function testItem7() {
  console.log('\n=== Item 7: banned phrases ===');
  const db = setupDB();
  await seedFixture(db);

  // Passing: clean text.
  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello'; // override default which has 'quick question'
  let r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[7] === true, 'item 7 passes on clean text', r.items);

  // Failing: 'circle back' in body.
  const { token } = buildUnsubscribeArtifacts(1001, 'planner_outreach_v1');
  input.body = [
    `Hi — I came across your portfolio. Let me circle back next month with a proposal.`,
    PHYSICAL_ADDRESS,
    `Reply 'unsubscribe' to unsubscribe@outreach.lapuestadelsolresort.com or click here to unsubscribe: https://webhook.lapuestadelsolresort.com/unsubscribe?token=${token}`,
  ].join('\n');
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[7] === false, 'item 7 fails on circle back');
  assert(
    r.failures.some((f) => f === 'item_7_banned_phrase:circle back'),
    'banned_phrase code includes phrase'
  );
  assert(r.pauseCampaign === false, 'item 7 alone does NOT trigger pauseCampaign', r);

  // Failing: banned phrase in subject (default subject "Quick question…" hits).
  input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  // leave default subject "Quick question about your destination weddings"
  r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.items[7] === false, 'item 7 fails on banned phrase in subject');
  assert(
    r.failures.some((f) => f === 'item_7_banned_phrase:quick question'),
    'subject banned phrase caught'
  );

  await db.dispose();
}

async function testAggregate() {
  console.log('\n=== Aggregate: multi-failure case ===');
  const db = setupDB();
  await seedFixture(db);

  // Set up a contact that's already DNC'd, address truncated, banned subject.
  await db.query(sql`UPDATE contacts SET do_not_contact = 1 WHERE id = 1001`);
  await db.query(sql`
    INSERT INTO suppressions (email, reason, source, added_by)
    VALUES ('vanessa@example.com', 'manual', 'slack_command', 'slack_command:UTEST123')
  `);

  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  // input.subject already 'Quick question…' — banned
  input.body = input.body.replace(PHYSICAL_ADDRESS, 'Del Mirador 300'); // truncate

  const r = await compliance.evaluateCompliance(db, CONFIG, input);
  assert(r.failures.includes('item_1_in_suppressions'), 'aggregate: item 1 caught');
  assert(r.failures.includes('item_2_do_not_contact'), 'aggregate: item 2 caught');
  assert(r.failures.includes('item_5_postal_address_missing'), 'aggregate: item 5 caught');
  assert(
    r.failures.some((f) => f === 'item_7_banned_phrase:quick question'),
    'aggregate: item 7 caught'
  );
  assert(r.pauseCampaign === true, 'aggregate: pauseCampaign true');
  assert(r.pass === false, 'aggregate: pass false');

  await db.dispose();
}

async function testRecordFailure() {
  console.log('\n=== recordComplianceFailure side effects ===');
  const db = setupDB();
  await seedFixture(db);
  await db.query(sql`UPDATE contacts SET do_not_contact = 1 WHERE id = 1001`);

  let input = await buildBaseInput(db, 1001, 1, 'planner_outreach_v1');
  input.subject = 'Hello';
  const r = await compliance.evaluateCompliance(db, CONFIG, input);

  slackPosts = [];
  // Use a temporary state file and restore/remove it afterward.
  const realStatePath = path.join(REPO_PROSPECTOR, 'state.json');
  const stateExisted = fs.existsSync(realStatePath);
  const stateBackup = stateExisted ? fs.readFileSync(realStatePath, 'utf8') : null;
  fs.writeFileSync(realStatePath, '{}\n');
  try {
    await compliance.recordComplianceFailure(
      db,
      CONFIG,
      {
        contactId: 1001,
        outreachSendId: null,
        contactEmail: 'vanessa@example.com',
        campaignName: 'planner_outreach_v1',
      },
      r
    );

    // Verify compliance_failures rows.
    const rows = await db.query(sql`SELECT failed_check, details FROM compliance_failures ORDER BY id`);
    assert(rows.length === r.failures.length, 'one row per failure', { rows: rows.length, expected: r.failures.length });

    // Verify Slack post fired.
    assert(slackPosts.length === 1, 'one slack post fired');
    assert(slackPosts[0].channel === 'channel:CTEST123', 'slack channel correct');
    assert(/Compliance gate FAIL/.test(slackPosts[0].message), 'slack message has FAIL marker');

    // Verify state.json paused.
    const newState = JSON.parse(fs.readFileSync(realStatePath, 'utf8'));
    assert(newState.paused === true, 'state.json paused = true');
    assert(newState.paused_by === 'compliance_gate', 'paused_by = compliance_gate');
  } finally {
    if (stateExisted) fs.writeFileSync(realStatePath, stateBackup);
    else fs.unlinkSync(realStatePath);
  }

  await db.dispose();
}

async function main() {
  await testItem1();
  await testItem2();
  await testItem3();
  await testItem4();
  await testItem5();
  await testItem6();
  await testItem7();
  await testAggregate();
  await testRecordFailure();

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
