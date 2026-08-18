/**
 * Regression tests for compliance-failure notification routing (F-049).
 *
 * recordComplianceFailure resolved its Slack channel from
 * prospector/config.json regardless of which agent called it, so Regina's
 * gate failures cross-posted into Paulina's channel. Its caption was also
 * hard-coded to "(item 7 only — campaign NOT paused.)", which was wrong
 * whenever a caller suppressed pausing while a consent item had failed —
 * Regina always passes pauseCampaign:false, so an item_1 suppression stop was
 * announced as a content nit.
 *
 * Run: node prospector/lib/compliance-notify.test.js
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
const compliance = require('./compliance');

const PAULINA_CHANNEL = 'CPAULINA1';
const REGINA_CHANNEL = 'CREGINA1';

const slackPosts = [];
compliance._setSlackForTesting(
  async (channel, message) => { slackPosts.push({ channel, message }); return { ok: true }; },
  () => PAULINA_CHANNEL, // the library default — prospector/config.json
);

const TEST_DB = path.join(os.tmpdir(), 'crm-compliance-notify-test.db');

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

async function seed(db) {
  await db.query(sql`
    INSERT INTO outreach_campaigns (id, name, persona, landing_page_url, status)
    VALUES (1, 'regina_winback', 'past_guest', 'https://lapuestadelsolresort.com/', 'active')
  `);
  await db.query(sql`
    INSERT INTO contacts (id, name, email, dedup_key, context_source, status, do_not_contact)
    VALUES (1001, 'Guest', 'guest@example.com', 'guest-test', 'synthetic_test_fixture', 'new', 0)
  `);
}

// A suppression failure with pausing suppressed by the caller — Regina's shape.
const SUPPRESSION_EVAL = {
  pass: false,
  failures: ['item_1_in_suppressions'],
  items: { 1: false, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true },
  pauseCampaign: false,
};

// A content-only failure — the case the old caption actually described.
const BANNED_PHRASE_EVAL = {
  pass: false,
  failures: ['item_7_banned_phrase:quick question'],
  items: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: false },
  pauseCampaign: false,
};

async function testCallerChannelWins() {
  console.log('\n=== a caller-supplied channel routes the notice ===');
  const db = setupDB();
  await seed(db);
  slackPosts.length = 0;

  await compliance.recordComplianceFailure(db, {}, {
    contactId: 1001, outreachSendId: null, contactEmail: 'guest@example.com',
    campaignName: 'regina_winback', source: 'send_time',
    channelId: REGINA_CHANNEL,
  }, SUPPRESSION_EVAL);

  assert(slackPosts.length === 1, 'one notice posted', slackPosts.length);
  assert(slackPosts[0].channel === `channel:${REGINA_CHANNEL}`, 'posted to the calling agent channel', slackPosts[0].channel);
  assert(!slackPosts[0].channel.includes(PAULINA_CHANNEL), 'did NOT cross-post to Paulina', slackPosts[0].channel);
  await db.dispose();
}

async function testDefaultChannelUnchanged() {
  console.log('\n=== Paulina (no channelId) still uses the config default ===');
  const db = setupDB();
  await seed(db);
  slackPosts.length = 0;

  await compliance.recordComplianceFailure(db, {}, {
    contactId: 1001, outreachSendId: null, contactEmail: 'guest@example.com',
    campaignName: 'planner_outreach_v1', source: 'send_time',
  }, BANNED_PHRASE_EVAL);

  assert(slackPosts.length === 1, 'one notice posted', slackPosts.length);
  assert(slackPosts[0].channel === `channel:${PAULINA_CHANNEL}`, 'falls back to prospector/config.json', slackPosts[0].channel);
  await db.dispose();
}

async function testCaptionIsHonest() {
  console.log('\n=== the caption describes what actually failed ===');
  const db = setupDB();
  await seed(db);

  slackPosts.length = 0;
  await compliance.recordComplianceFailure(db, {}, {
    contactId: 1001, contactEmail: 'guest@example.com', campaignName: 'regina_winback',
    source: 'send_time', channelId: REGINA_CHANNEL,
  }, SUPPRESSION_EVAL);
  const suppressionMsg = slackPosts[0].message;
  assert(!suppressionMsg.includes('item 7 only'), 'a suppression stop is not called "item 7 only"', suppressionMsg);
  assert(suppressionMsg.includes('item_1'), 'the caption names the failed item', suppressionMsg);
  assert(suppressionMsg.includes('pause suppressed by caller'), 'the caption says pausing was suppressed', suppressionMsg);

  slackPosts.length = 0;
  await compliance.recordComplianceFailure(db, {}, {
    contactId: 1001, contactEmail: 'guest@example.com', campaignName: 'planner_outreach_v1',
    source: 'send_time',
  }, BANNED_PHRASE_EVAL);
  assert(slackPosts[0].message.includes('item 7 only'), 'a genuine content-only failure still reads "item 7 only"', slackPosts[0].message);

  slackPosts.length = 0;
  await compliance.recordComplianceFailure(db, {}, {
    contactId: 1001, contactEmail: 'guest@example.com', campaignName: 'planner_outreach_v1',
    source: 'send_time',
  }, { ...SUPPRESSION_EVAL, pauseCampaign: true });
  assert(slackPosts[0].message.includes('auto-paused'), 'the pausing path is unchanged', slackPosts[0].message);
  await db.dispose();
}

async function main() {
  await testCallerChannelWins();
  await testDefaultChannelUnchanged();
  await testCaptionIsHonest();

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
