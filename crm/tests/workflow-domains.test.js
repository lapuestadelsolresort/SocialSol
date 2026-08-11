'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { startGraph } = require('../lib/workflow-engine');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { tokenMatches } = require('../routes/workflows');
const { getDefinition, listDefinitions } = require('../workflows/registry');
const { matchingPost } = require('../workflows/social-publish');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-domains-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
      platform TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT,
      message_id TEXT UNIQUE, message_text TEXT, raw_payload TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('registry exposes fixed domain graphs instead of arbitrary command execution', () => {
  const definitions = new Map(listDefinitions().map(item => [item.name, item]));
  for (const expected of [
    'whatsapp.reply', 'whatsapp.inbound.process', 'receipt.ingest', 'receipt.annotate', 'receipt.reconcile',
    'social.content.upsert', 'social.content.publish', 'social.publish_routine',
    'paulina.daily', 'paulina.performance.read', 'regina.daily', 'regina.campaign',
    'guest.reply.draft', 'crm.sync', 'crm.pipeline.read',
    'ownerrez.occupancy.read', 'squarespace.summary.read',
    'ownerrez.mutation.propose', 'ownerrez.mutation.confirm',
    'qbo.write', 'qbo.bank_balances.read', 'qbo.report.read', 'business.snapshot.read',
  ]) assert.equal(definitions.has(expected), true, expected);
  assert.equal(definitions.get('business.snapshot.read').mutates, false);
  assert.equal(definitions.get('qbo.write').autonomous, true);
  assert.equal(definitions.has('shell.exec'), false);
});

test('inbound WhatsApp CRM enrichment is resumable and idempotent', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, source TEXT,
      campaign_name TEXT, status TEXT, inquiry_message TEXT, notes TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT
    )`);
    await db.query(sql`CREATE TABLE page_sessions (
      id TEXT PRIMARY KEY, whatsapp_ref TEXT, page_slug TEXT, utm_source TEXT,
      utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, lead_id INTEGER,
      converted INTEGER DEFAULT 0, last_seen TEXT
    )`);
    await db.query(sql`CREATE TABLE attribution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, lead_id INTEGER,
      event_type TEXT, channel TEXT, campaign TEXT, utm_source TEXT,
      utm_medium TEXT, utm_campaign TEXT, meta TEXT
    )`);
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, direction, delivery_status, processing_status
    ) VALUES (
      '2026-08-11T17:00:00.000Z', 'whatsapp', '+14155550123', 'Test Guest',
      'SM-DURABLE-INBOUND', 'Do you have availability?', '{}', 'inbound', 'delivered', 'queued'
    )`);
    const [message] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='SM-DURABLE-INBOUND'`);
    const request = {
      idempotencyKey: 'whatsapp:inbound:SM-DURABLE-INBOUND:process',
      triggerType: 'system', triggerRef: `whatsapp-message:${message.id}`,
      input: { messageId: message.id },
    };
    const first = await startGraph(db, getDefinition('whatsapp.inbound.process'), request);
    const replay = await startGraph(db, getDefinition('whatsapp.inbound.process'), request);
    assert.equal(first.status, 'completed', first.error_message);
    assert.equal(replay.id, first.id);
    assert.ok(first.output.leadId);
    const [processed] = await db.query(sql`SELECT processing_status, crm_lead_id, lead_created
      FROM meta_messages WHERE id=${message.id}`);
    assert.equal(processed.processing_status, 'completed');
    assert.equal(processed.crm_lead_id, first.output.leadId);
    assert.equal(processed.lead_created, 1);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM leads WHERE phone='+14155550123'`);
    assert.equal(count, 1);
  });
});

test('receipt ingestion is idempotent, hash-verified, and channel-scoped', async () => {
  await withDb(async db => {
    const definition = getDefinition('receipt.ingest');
    const request = {
      idempotencyKey: 'slack:RECEIPT-A:171.2:receipt.ingest',
      triggerType: 'slack', triggerRef: '171.2', channelId: 'RECEIPT-A', actorUserId: 'TEST-WORKER',
      input: { slackMessageId: '171.2', messageText: 'Materials 1250 MXN', fileRefs: [{ id: 'F1', name: 'receipt.jpg' }] },
    };
    const first = await startGraph(db, definition, request);
    const replay = await startGraph(db, definition, request);
    assert.equal(first.id, replay.id);
    assert.equal(first.output.status, 'verified_by_readback');
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM accounting_receipts`);
    assert.equal(count, 1);

    const annotate = getDefinition('receipt.annotate');
    const annotated = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-A:171.3:receipt.annotate',
      triggerType: 'slack', channelId: 'RECEIPT-A', actorUserId: 'TEST-WORKER',
      input: { receiptId: first.output.receiptId, amount: 1250, currency: 'MXN', transactionDate: '2026-08-10', vendor: 'Hardware' },
    });
    assert.equal(annotated.status, 'completed', annotated.error_message);
    assert.equal(annotated.output.receiptStatus, 'extracted');

    const denied = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-B:171.4:receipt.annotate',
      triggerType: 'slack', channelId: 'RECEIPT-B', actorUserId: 'TEST-OTHER',
      input: { receiptId: first.output.receiptId, amount: 1, currency: 'MXN' },
    });
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error_code, 'receipt_scope_violation');
  });
});

test('business snapshot names authorities and refuses to imply unqueried occupancy or cash', async () => {
  await withDb(async db => {
    const run = await startGraph(db, getDefinition('business.snapshot.read'), {
      idempotencyKey: 'snapshot-1', triggerType: 'slack', channelId: 'BI-CHANNEL', actorUserId: 'TEST-OWNER', input: {},
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.output.authorityContract.occupancyAvailability.authority, 'OwnerRez');
    assert.equal(run.output.authorityContract.occupancyAvailability.queried, false);
    assert.equal(run.output.authorityContract.bankCash.queried, false);
    assert.ok(run.output._evidence.payloadHash);
  });
});

test('channel-owned social content can be approved and the due dispatcher no-ops safely', async () => {
  await withDb(async db => {
    const scheduledFor = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const content = await startGraph(db, getDefinition('social.content.upsert'), {
      idempotencyKey: 'social-content-approved-1',
      triggerType: 'slack', channelId: 'SOCIAL-CHANNEL', actorUserId: 'TEST-EDITOR',
      input: { caption: 'Approved future content', status: 'approved', scheduledFor, mediaRefs: [] },
    });
    assert.equal(content.status, 'completed');
    assert.equal(content.output.contentStatus, 'approved');

    const due = await startGraph(db, getDefinition('social.publish_due'), {
      idempotencyKey: 'social-due-empty-window-1',
      triggerType: 'system', input: {},
    });
    assert.equal(due.status, 'completed');
    assert.equal(due.output.scheduled, 0);
    assert.ok(due.output.evidenceId);
  });
});

test('Postiz preflight recovery matches exact provider id or caption/date, not caption alone', () => {
  const posts = [
    { id: 'p1', content: 'Sunset view', publishDate: '2026-08-12T17:00:00.000Z' },
    { id: 'p2', content: 'Sunset view', publishDate: '2026-08-15T17:00:00.000Z' },
  ];
  assert.equal(matchingPost(posts, { id: 'p2', caption: 'different', scheduledFor: '2026-08-12T17:00:00.000Z' }).id, 'p2');
  assert.equal(matchingPost(posts, { caption: 'Sunset   view', scheduledFor: '2026-08-12T17:00:30.000Z' }).id, 'p1');
  assert.equal(matchingPost(posts, { caption: 'Sunset view', scheduledFor: '2026-08-13T17:00:00.000Z' }), null);
});

test('workflow control token is length-checked and compared exactly', () => {
  const token = 'a'.repeat(32);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, 'a'.repeat(31)), false);
  assert.equal(tokenMatches('short', 'short'), false);
});
