'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { authorizationDecision } = require('../lib/channel-policy');
const { startGraph } = require('../lib/workflow-engine');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { beginStep, createRun, getRun, transitionEffect } = require('../lib/workflow-store');
const { recoverStaleRuns } = require('../scripts/workflow-worker');
const { definition } = require('../workflows/whatsapp-reply');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
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

test('workflow schema is additive and includes durable run/effect/outbox state', async () => {
  await withDb(async db => {
    const tables = await db.query(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = new Set(tables.map(row => row.name));
    for (const expected of ['workflow_runs', 'workflow_steps', 'workflow_events', 'workflow_effects', 'workflow_evidence', 'workflow_outbox']) {
      assert.equal(names.has(expected), true, expected);
    }
    const columns = await db.query(sql`PRAGMA table_info(meta_messages)`);
    const columnNames = new Set(columns.map(row => row.name));
    for (const expected of ['slack_thread_ts', 'delivery_status', 'delivered_at', 'read_at', 'workflow_effect_id']) {
      assert.equal(columnNames.has(expected), true, expected);
    }
  });
});

test('WhatsApp graph is idempotent and distinguishes provider acceptance, delivery, and read', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, slack_thread_ts, direction)
      VALUES ('2026-08-11T12:00:00Z', 'whatsapp', '+14155550100', 'Guest', 'SM-IN', 'Hello', '123.456', 'inbound')`);
    let sends = 0;
    const request = {
      idempotencyKey: 'slack:C-WA:message-1:whatsapp.reply',
      triggerType: 'slack',
      triggerRef: 'message-1',
      channelId: 'C-WA',
      actorUserId: 'U-JASON',
      input: { threadTs: '123.456', message: 'Welcome!', actorName: 'Jason' },
    };
    const services = {
      sendWhatsApp: async ({ toPhone, message }) => {
        sends += 1;
        assert.equal(toPhone, '+14155550100');
        assert.equal(message, 'Welcome!');
        return { sid: 'SM-OUT', status: 'queued', date_created: 'today' };
      },
    };

    const first = await startGraph(db, definition, request, services);
    assert.equal(first.status, 'completed');
    assert.equal(first.output.status, 'queued');
    assert.equal(first.output.deliveryConfirmed, false);
    assert.equal(first.output.readConfirmed, false);
    assert.equal(sends, 1);

    const replay = await startGraph(db, definition, request, services);
    assert.equal(replay.id, first.id);
    assert.equal(sends, 1, 'same Slack event must not send twice');

    const delivered = await transitionEffect(db, {
      provider: 'twilio', providerRef: 'SM-OUT', status: 'delivered', providerStatus: 'delivered',
    });
    assert.equal(delivered.changed, true);
    const stale = await transitionEffect(db, {
      provider: 'twilio', providerRef: 'SM-OUT', status: 'sent', providerStatus: 'sent',
    });
    assert.equal(stale.changed, false, 'out-of-order callback must not regress delivery');
    const read = await transitionEffect(db, {
      provider: 'twilio', providerRef: 'SM-OUT', status: 'read', providerStatus: 'read',
    });
    assert.equal(read.changed, true);
    const finalRun = await getRun(db, first.id);
    assert.equal(finalRun.effects[0].status, 'read');
  });
});

test('channel capabilities allow members by channel and restrict OwnerRez writes by user', () => {
  const policy = {
    version: 1,
    channels: {
      'C-WA': { name: 'whatsapp', capabilities: ['whatsapp.read', 'whatsapp.send'] },
      'C-BI': { name: 'business-intel', capabilities: ['business.read_all'] },
      'C-RES': { name: 'reservations', capabilities: ['ownerrez.read', 'ownerrez.write'] },
    },
    restricted_capabilities: { 'ownerrez.write': { users: ['U-JASON'] } },
    autonomous_workflows: ['paulina.daily'],
  };
  const slack = (channelId, actorUserId) => ({ origin: 'slack', originVerified: true, channelId, actorUserId });
  assert.equal(authorizationDecision({ policy, capability: 'whatsapp.send', workflowName: 'whatsapp.reply', context: slack('C-WA', 'U-SARAH') }).allowed, true);
  assert.equal(authorizationDecision({ policy, capability: 'qbo.write', workflowName: 'qbo.write', context: slack('C-WA', 'U-SARAH') }).allowed, false);
  assert.equal(authorizationDecision({ policy, capability: 'qbo.read', workflowName: 'qbo.query', context: slack('C-BI', 'U-JASON') }).allowed, true);
  assert.equal(authorizationDecision({ policy, capability: 'ownerrez.write', workflowName: 'ownerrez.write', context: slack('C-RES', 'U-SARAH') }).allowed, false);
  assert.equal(authorizationDecision({ policy, capability: 'ownerrez.write', workflowName: 'ownerrez.write', context: slack('C-RES', 'U-JASON') }).allowed, true);
  assert.equal(authorizationDecision({ policy, capability: 'paulina.send', workflowName: 'paulina.daily', context: { origin: 'system' } }).allowed, true);
});

test('an expired WhatsApp step lease fails for review instead of being replayed', async () => {
  await withDb(async db => {
    const created = await createRun(db, {
      definition,
      idempotencyKey: 'stale-whatsapp-run',
      triggerType: 'slack',
      triggerRef: 'message-1',
      channelId: 'C-WA',
      actorUserId: 'U-JASON',
      input: { dmId: 1, message: 'Do not duplicate this' },
    });
    await beginStep(db, created.run.id, 'resolve_conversation', {}, 'dead-worker', -1000);
    const result = await recoverStaleRuns(db);
    assert.equal(result.manualReview, 1);
    const run = await getRun(db, created.run.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'ambiguous_external_result');
    assert.equal(run.steps[0].attempts, 1);
  });
});
