'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const {
  buildPerformanceReport,
  formatPerformanceReport,
} = require('./performance-report');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paulina-performance-'));
  const db = createDB(path.join(directory, 'test.db'));
  t.after(async () => {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await db.query(sql`
    CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY, slug TEXT, name TEXT, status TEXT, owning_agent TEXT
    )
  `);
  await db.query(sql`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, name TEXT, company TEXT, status TEXT,
      reply_status TEXT, do_not_contact INTEGER, do_not_contact_reason TEXT,
      email_status TEXT, source TEXT, airbnb_account_id INTEGER
    )
  `);
  await db.query(sql`
    CREATE TABLE campaign_contacts (
      id INTEGER PRIMARY KEY, campaign_id INTEGER, contact_id INTEGER
    )
  `);
  await db.query(sql`
    CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY, contact_id INTEGER, campaign_id INTEGER,
      created_at TEXT, status TEXT, sent_at TEXT, delivered_at TEXT,
      opened_at TEXT, clicked_at TEXT, bounced_at TEXT, complained_at TEXT,
      reply_detected_at TEXT, cancelled_at TEXT, error TEXT,
      rejected_reason TEXT
    )
  `);

  await db.query(sql`
    INSERT INTO outreach_campaigns (id, slug, name, status, owning_agent) VALUES
      (1, 'planner_outreach_v1', 'Legacy planner', 'paused', NULL),
      (2, 'planner_partner_program_v1', 'Planner partner', 'active', 'paulina'),
      (3, 'corporate_retreat_v1', 'Corporate', 'active', 'regina')
  `);
  await db.query(sql`
    INSERT INTO contacts
      (id, name, company, status, reply_status, do_not_contact,
       do_not_contact_reason, email_status, source, airbnb_account_id)
    VALUES
      (1, 'Legacy Planner', 'Legacy Co', 'contacted', NULL, 0, NULL, 'verified', 'directory', NULL),
      (2, 'Real Planner', 'Planner Co', 'replied', 'positive', 0, NULL, 'verified', 'directory', NULL),
      (3, 'Owner Test', NULL, 'dead', NULL, 0, NULL, 'verified', 'manual', NULL),
      (4, 'Cancelled Planner', NULL, 'new', NULL, 0, NULL, 'verified', 'directory', NULL),
      (5, 'Drafted Planner', NULL, 'new', NULL, 0, NULL, 'verified', 'directory', NULL),
      (6, 'Ready Planner', NULL, 'new', NULL, 0, NULL, 'verified', 'directory', NULL),
      (7, 'Corporate Person', NULL, 'contacted', NULL, 0, NULL, 'verified', 'directory', NULL),
      (8, 'Past Guest', NULL, 'new', NULL, 0, NULL, 'unknown', 'airbnb_export', 123)
  `);
  await db.query(sql`
    INSERT INTO campaign_contacts (id, campaign_id, contact_id) VALUES
      (1, 2, 2), (2, 2, 3), (3, 2, 4), (4, 2, 5), (5, 2, 6)
  `);
  await db.query(sql`
    INSERT INTO outreach_sends
      (id, contact_id, campaign_id, created_at, status, sent_at,
       delivered_at, reply_detected_at, cancelled_at)
    VALUES
      (1, 1, 1, '2026-06-01 10:00:00', 'delivered', '2026-06-01 10:05:00', '2026-06-01 10:05:02', NULL, NULL),
      (2, 2, 2, '2026-08-02 10:00:00', 'replied', '2026-08-02 10:05:00', '2026-08-02 10:05:02', '2026-08-03 09:00:00', NULL),
      (3, 3, 2, '2026-08-02 11:00:00', 'delivered', '2026-08-02 11:05:00', '2026-08-02 11:05:02', '2026-08-03 10:00:00', NULL),
      (4, 4, 2, '2026-08-04 10:00:00', 'cancelled', NULL, NULL, NULL, '2026-08-04 10:05:00'),
      (5, 5, 2, '2026-08-05 10:00:00', 'pending_approval', NULL, NULL, NULL, NULL),
      (6, 7, 3, '2026-08-02 12:00:00', 'delivered', '2026-08-02 12:05:00', '2026-08-02 12:05:02', NULL, NULL)
  `);
  return db;
}

test('canonical report counts sent_at only and keeps Paulina, tests, and CRM pools separate', async (t) => {
  const db = await fixture(t);
  const report = await buildPerformanceReport(db, sql, {
    reporting: {
      active_campaign_slug: 'planner_partner_program_v1',
      legacy_campaign_slugs: ['planner_outreach_v1'],
      window_days: 14,
      open_tracking_enabled: false,
      test_contact_names: ['Owner Test'],
    },
    email_verification: { queue_target_verified: 2 },
  }, new Date('2026-08-09T12:00:00Z'));

  assert.equal(report.all_time.actual_sent, 3);
  assert.equal(report.all_time.production_sent, 2);
  assert.equal(report.all_time.test_sent, 1);
  assert.equal(report.all_time.external_replies, 1);
  assert.equal(report.all_time.test_replies, 1);
  assert.equal(report.all_time.production_reply_rate_percent, 50);
  assert.equal(report.all_time.opens, null);

  assert.equal(report.recent.actual_sent, 2);
  assert.equal(report.recent.records_created, 4);
  assert.equal(report.recent.records_cancelled, 1);
  assert.deepEqual(report.recent.cancellation_reasons, { reason_not_recorded: 1 });

  assert.equal(report.active_queue.attached_contacts, 5);
  assert.equal(report.active_queue.remaining_contacts, 2);
  assert.equal(report.active_queue.verified_ready, 2);
  assert.equal(report.active_queue.verification_buffer_status, 'target_met');

  assert.equal(report.crm_context.all_outreach_records, 6);
  assert.equal(report.crm_context.all_actual_sends, 4);
  assert.equal(report.crm_context.other_campaign_actual_sends, 1);
  assert.equal(report.crm_context.global_new_contacts, 4);
  assert.equal(report.crm_context.global_new_airbnb_contacts, 1);
});

test('formatted report states that unconfigured opens are unavailable, not zero percent', async (t) => {
  const db = await fixture(t);
  const report = await buildPerformanceReport(db, sql, {
    reporting: {
      test_contact_names: ['Owner Test'],
      open_tracking_enabled: false,
    },
  }, new Date('2026-08-09T12:00:00Z'));
  const output = formatPerformanceReport(report);

  assert.match(output, /Opens: unavailable/);
  assert.match(output, /must not be interpreted as a 0% open rate/);
  assert.match(output, /only 4 actual sends across every campaign/);
  assert.match(output, /does not prove inbox placement, sender reputation, warmup health/);
  assert.match(output, /without calling it healthy, strong, weak, or poor/);
  assert.match(output, /contact marked new is already attached/i);
  assert.doesNotMatch(output, /317 emails sent/);
});

test('open metrics exclude every send before the tracking activation timestamp', async (t) => {
  const db = await fixture(t);
  await db.query(sql`
    UPDATE outreach_sends
    SET opened_at = CASE id
      WHEN 1 THEN '2026-06-01 10:10:00'
      WHEN 2 THEN '2026-08-02 10:10:00'
      WHEN 3 THEN '2026-08-02 11:10:00'
      ELSE opened_at
    END
    WHERE id IN (1, 2, 3)
  `);

  const report = await buildPerformanceReport(db, sql, {
    reporting: {
      test_contact_names: ['Owner Test'],
      open_tracking_enabled: true,
      open_tracking_enabled_at: '2026-08-02T10:30:00Z',
      open_tracking_subdomain: 'links.outreach.example.com',
    },
  }, new Date('2026-08-09T12:00:00Z'));

  assert.equal(report.tracking.opens_available, true);
  assert.equal(report.tracking.opens_enabled_at, '2026-08-02T10:30:00.000Z');
  assert.equal(report.all_time.opens, 1);
  assert.equal(report.all_time.open_tracking_eligible_sent, 1);
  assert.equal(report.all_time.open_tracking_eligible_delivered, 1);
  assert.equal(report.all_time.open_rate_percent, 100);
  assert.match(report.tracking.opens_note, /historical opens cannot be backfilled/i);

  const output = formatPerformanceReport(report);
  assert.match(output, /Opens: 1 across 1 delivered messages sent since/);
  assert.doesNotMatch(output, /Opens: 3/);
});

test('enabled open tracking without an activation timestamp remains unavailable', async (t) => {
  const db = await fixture(t);
  const report = await buildPerformanceReport(db, sql, {
    reporting: {
      open_tracking_enabled: true,
      open_tracking_enabled_at: null,
    },
  }, new Date('2026-08-09T12:00:00Z'));

  assert.equal(report.tracking.opens_available, false);
  assert.equal(report.all_time.opens, null);
  assert.match(report.tracking.opens_note, /missing or invalid/);
});
