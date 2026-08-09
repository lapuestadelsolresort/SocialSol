'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { capForWeek } = require('./compliance');
const { calculateDailyCapacity, dailyTargetForWeek } = require('./throughput');

const CONFIG = {
  weekly_send_caps: {
    week_1: 20,
    week_2: 40,
    week_3: 50,
    week_4: 75,
    week_5_plus: 100,
  },
  composer: { compose_batch_max_n: 20 },
  orchestrator: { send_days_per_week: 5 },
};

test('arbitrary week_N_plus tiers preserve the 50 → 75 → 100 ramp', () => {
  assert.equal(capForWeek(CONFIG, 3), 50);
  assert.equal(capForWeek(CONFIG, 4), 75);
  assert.equal(capForWeek(CONFIG, 5), 100);
  assert.equal(capForWeek(CONFIG, 12), 100);
  assert.equal(dailyTargetForWeek(CONFIG, 3), 10);
  assert.equal(dailyTargetForWeek(CONFIG, 4), 15);
  assert.equal(dailyTargetForWeek(CONFIG, 5), 20);
});

test('daily capacity subtracts committed rows and is rerun-safe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paulina-throughput-'));
  const dbPath = path.join(directory, 'test.db');
  const db = createDB(dbPath);
  t.after(async () => {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.query(sql`
    CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER,
      created_at TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT
    )
  `);

  // Monday in campaign week 3. Two delivered rows and one approved row have
  // already committed three of the ten daily slots.
  const now = new Date('2026-08-10T16:00:00.000Z');
  const campaign = {
    id: 7,
    slug: 'planner_partner_program_v1',
    first_send_at: '2026-07-27T16:00:00.000Z',
  };
  for (let id = 1; id <= 2; id++) {
    await db.query(sql`
      INSERT INTO outreach_sends (id, campaign_id, created_at, scheduled_at, sent_at, status)
      VALUES (${id}, 7, '2026-08-10T15:00:00.000Z', '2026-08-10T16:00:00.000Z',
              '2026-08-10T16:00:00.000Z', 'delivered')
    `);
  }
  await db.query(sql`
    INSERT INTO outreach_sends (id, campaign_id, created_at, scheduled_at, sent_at, status)
    VALUES (3, 7, '2026-08-10T15:30:00.000Z', '2026-08-10T18:00:00.000Z', NULL, 'approved')
  `);

  const result = await calculateDailyCapacity(db, sql, CONFIG, campaign, now);
  assert.equal(result.campaign_week, 3);
  assert.equal(result.weekly_cap, 50);
  assert.equal(result.daily_target, 10);
  assert.equal(result.daily_committed, 3);
  assert.equal(result.batch_size, 7);
});
