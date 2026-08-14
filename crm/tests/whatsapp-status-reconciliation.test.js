'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { reconcileWhatsAppStatuses } = require('../lib/whatsapp-status-reconciliation');
const { main } = require('../scripts/reconcile-whatsapp-statuses');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-reconcile-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      platform TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT UNIQUE,
      message_text TEXT,
      raw_payload TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('WhatsApp reconciliation is dry-run by default and backfills provider truth atomically', async () => {
  await withDb(async db => {
    const legacySid = 'SM11111111111111111111111111111111';
    const modernSid = 'SM22222222222222222222222222222222';
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, slack_thread_ts, direction, delivery_status
    ) VALUES (
      '2026-08-01T12:00:00.000Z', 'whatsapp', '+14155550100', 'Legacy Guest',
      'SM33333333333333333333333333333333', 'Inbound', '{}', '100.1', NULL, NULL
    )`);
    const [inbound] = await db.query(sql`SELECT id FROM meta_messages WHERE sender_name='Legacy Guest'`);
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, slack_thread_ts, direction, delivery_status,
      provider_status_updated_at
    ) VALUES
      ('2026-08-01T12:01:00.000Z', 'whatsapp', 'outbound', 'Sarah', NULL, 'Legacy reply',
        ${JSON.stringify({ reply_to_dm_id: inbound.id, twilio_sid: legacySid })}, '100.1', NULL, NULL, NULL),
      ('2026-08-12T12:01:00.000Z', 'whatsapp', 'outbound', 'Staff', ${modernSid}, 'Modern reply',
        ${JSON.stringify({ reply_to_dm_id: inbound.id, twilio_sid: modernSid })}, '100.1', 'outbound',
        'accepted_by_provider', '2026-08-12T12:01:00.000Z')`);

    const readStatus = async sid => sid === legacySid ? {
      messageSid: sid,
      status: 'read',
      providerStatus: 'read',
      sentAt: '2026-08-01T12:01:01.000Z',
      statusUpdatedAt: '2026-08-01T12:02:00.000Z',
      errorCode: null,
      errorMessage: null,
    } : {
      messageSid: sid,
      status: 'failed',
      providerStatus: 'undelivered',
      sentAt: '2026-08-12T12:01:01.000Z',
      statusUpdatedAt: '2026-08-12T12:01:02.000Z',
      errorCode: '63016',
      errorMessage: null,
    };

    const dryRun = await reconcileWhatsAppStatuses(db, { readStatus });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.legacyInboundFound, 1);
    assert.equal(dryRun.outboundFound, 2);
    assert.deepEqual(dryRun.statusCounts, {
      read: 1, delivered: 0, failed: 1, sent: 0, queued: 0,
      accepted_by_provider: 0, requested: 0, unresolved: 0,
    });
    assert.equal(dryRun.followUpRequiredMessages, 1);
    const [before] = await db.query(sql`SELECT direction FROM meta_messages WHERE id=${inbound.id}`);
    assert.equal(before.direction, null);

    const applied = await reconcileWhatsAppStatuses(db, { apply: true, readStatus });
    assert.equal(applied.mode, 'apply');
    assert.deepEqual(applied.applied, { inboundNormalized: 1, outboundNormalized: 2 });
    const rows = await db.query(sql`SELECT sender_id, message_id, direction, delivery_status,
        provider_delivery_status, provider_error_code, delivery_status_source,
        provider_status_updated_at, delivered_at, read_at, failed_at
      FROM meta_messages ORDER BY id`);
    assert.equal(rows[0].direction, 'inbound');
    assert.equal(rows[0].delivery_status, 'delivered');
    assert.equal(rows[0].delivery_status_source, 'legacy_inbound_webhook');
    assert.equal(rows[1].message_id, legacySid);
    assert.equal(rows[1].direction, 'outbound');
    assert.equal(rows[1].delivery_status, 'read');
    assert.equal(rows[1].provider_delivery_status, 'read');
    assert.equal(rows[1].delivery_status_source, 'twilio_message_api_readback');
    assert.equal(rows[1].read_at, '2026-08-01T12:02:00.000Z');
    assert.equal(rows[2].delivery_status, 'failed');
    assert.equal(rows[2].provider_delivery_status, 'undelivered');
    assert.equal(rows[2].provider_error_code, '63016');
    assert.equal(rows[2].delivery_status_source, 'twilio_message_api_readback');
    assert.equal(rows[2].failed_at, '2026-08-12T12:01:02.000Z');
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM meta_messages
      WHERE platform='whatsapp' AND (direction IS NULL OR delivery_status IS NULL)`);
    assert.equal(count, 0);
  });
});

test('WhatsApp reconciliation refuses partial apply when any provider SID cannot be read', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, direction, delivery_status
    ) VALUES
      ('2026-08-01T12:00:00.000Z', 'whatsapp', '+14155550100', 'Guest',
        'SM44444444444444444444444444444444', 'Inbound', '{}', NULL, NULL),
      ('2026-08-01T12:01:00.000Z', 'whatsapp', 'outbound', 'Sarah',
        NULL, 'Reply', '{}', NULL, NULL)`);
    await assert.rejects(
      reconcileWhatsAppStatuses(db, { apply: true, readStatus: async () => ({}) }),
      /refusing partial WhatsApp reconciliation/,
    );
    const rows = await db.query(sql`SELECT direction, delivery_status FROM meta_messages ORDER BY id`);
    assert.deepEqual(rows, [
      { direction: null, delivery_status: null },
      { direction: null, delivery_status: null },
    ]);
  });
});

test('production apply flag requires explicit confirmation', async () => {
  await assert.rejects(main(['--apply'], {}), /--confirm-production/);
});
