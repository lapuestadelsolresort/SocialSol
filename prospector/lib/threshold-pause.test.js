'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { checkThresholdsAndMaybePause } = require('./threshold-pause');

const CONFIG = {
  orchestrator: {
    thresholds: {
      bounces_24h: 2,
      bounce_rate_7d: 0.04,
      bounce_rate_min_sent: 20,
      complaints_7d: 1,
      complaint_rate_7d: 0.001,
      complaint_rate_min_sent: 20,
    },
  },
};

async function fixture(t, sendCount, { bounced = 0, complained = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paulina-threshold-'));
  const db = createDB(path.join(directory, 'test.db'));
  const statePath = path.join(directory, 'state.json');
  fs.writeFileSync(statePath, '{"paused":false}\n');
  t.after(async () => {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.query(sql`CREATE TABLE contacts (id INTEGER PRIMARY KEY, email TEXT)`);
  await db.query(sql`
    CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER,
      sent_at TEXT,
      bounced_at TEXT,
      complained_at TEXT
    )
  `);
  const now = new Date().toISOString();
  for (let id = 1; id <= sendCount; id++) {
    await db.query(sql`INSERT INTO contacts (id, email) VALUES (${id}, ${`planner-${id}@example.com`})`);
    await db.query(sql`
      INSERT INTO outreach_sends (id, contact_id, sent_at, bounced_at, complained_at)
      VALUES (${id}, ${id}, ${now}, ${id <= bounced ? now : null},
              ${id > bounced && id <= bounced + complained ? now : null})
    `);
  }
  return { db, statePath };
}

test('rate guard pauses at 5% after the 20-send minimum sample', async (t) => {
  const { db, statePath } = await fixture(t, 20, { bounced: 1 });
  const messages = [];
  const result = await checkThresholdsAndMaybePause(
    db,
    sql,
    CONFIG,
    { slackPost: async (message) => messages.push(message) },
    { statePath },
  );
  assert.equal(result.tripped, true);
  assert.equal(result.paused_by, 'auto_threshold:bounce_rate_7d');
  assert.equal(result.rate, 0.05);
  assert.match(messages[0], /5\.00%/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).paused, true);
});

test('rate guard waits for its minimum sample', async (t) => {
  const { db, statePath } = await fixture(t, 10, { bounced: 1 });
  const result = await checkThresholdsAndMaybePause(
    db, sql, CONFIG, {}, { statePath },
  );
  assert.deepEqual(result, { tripped: false });
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).paused, false);
});

test('one complaint still triggers the absolute zero-tolerance gate', async (t) => {
  const { db, statePath } = await fixture(t, 1, { complained: 1 });
  const result = await checkThresholdsAndMaybePause(
    db, sql, CONFIG, {}, { statePath },
  );
  assert.equal(result.tripped, true);
  assert.equal(result.paused_by, 'auto_threshold:complaint_7d');
});
