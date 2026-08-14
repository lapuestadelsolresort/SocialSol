'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { executeGraph, startGraph } = require('../lib/workflow-engine');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { tokenMatches } = require('../routes/workflows');
const { getDefinition, listDefinitions } = require('../workflows/registry');
const { runVerifiedCommand } = require('../workflows/paulina-prepare');
const { matchingPost } = require('../workflows/social-publish');
const { _internal: readModelInternals } = require('../workflows/read-models');
const { projectBankTransactionQboWrites } = require('../workflows/operational-jobs');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-domains-'));
  const db = createDB(path.join(directory, 'crm.db'));
  const priorPolicyPath = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const priorAccountingPath = process.env.ACCOUNTING_CONFIG_PATH;
  const policyPath = path.join(directory, 'policy.json');
  const accountingPath = path.join(directory, 'accounting.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: false,
    live_workflows: [],
    autonomous_workflows: [],
    always_on_effects: [],
    channels: {
      'RECEIPT-A': { name: 'receipt-a', capabilities: ['receipts.write'] },
      'RECEIPT-B': { name: 'receipt-b', capabilities: ['receipts.write'] },
      'PAULINA': { name: 'prospector-paulina', capabilities: ['paulina.send'] },
      'REGINA': { name: 'reengager-regina', capabilities: ['regina.send'] },
    },
    restricted_capabilities: {},
    write_notifications: { user_ids: [], channel_ids: [] },
  }));
  fs.writeFileSync(accountingPath, JSON.stringify({
    qbo_accounts: {
      expenses: {
        maintenance: { id: '10', name: 'Maintenance' },
        cleaning_services: { id: '11', name: 'Cleaning Services' },
      },
    },
    receipt_payment: { approver_user_ids: ['U123MAYELA'] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  process.env.ACCOUNTING_CONFIG_PATH = accountingPath;
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
    if (priorPolicyPath === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = priorPolicyPath;
    if (priorAccountingPath === undefined) delete process.env.ACCOUNTING_CONFIG_PATH;
    else process.env.ACCOUNTING_CONFIG_PATH = priorAccountingPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function seedWorkflowRun(db, {
  id,
  workflowName,
  status,
  state = {},
  startedAt,
  completedAt,
}) {
  await db.query(sql`INSERT INTO workflow_runs (
      id, workflow_name, workflow_version, idempotency_key, status,
      trigger_type, input_json, state_json, started_at, completed_at
    ) VALUES (
      ${id}, ${workflowName}, 1, ${`seed:${id}`}, ${status},
      'system', '{}', ${JSON.stringify(state)}, ${startedAt}, ${completedAt}
    )`);
}

test('registry exposes fixed domain graphs instead of arbitrary command execution', () => {
  const definitions = new Map(listDefinitions().map(item => [item.name, item]));
  for (const expected of [
    'whatsapp.reply', 'whatsapp.inbound.process', 'meta.dm.reply', 'receipt.ingest', 'receipt.process',
    'receipt.payment_source.select', 'receipt.annotate', 'receipt.reconcile',
    'social.content.upsert', 'social.content.publish', 'social.publish_routine',
    'paulina.daily', 'paulina.prepare_daily', 'paulina.performance.read', 'regina.daily', 'regina.campaign',
    'guest.reply.draft', 'crm.sync', 'crm.pipeline.read', 'crm.contacts.read',
    'ownerrez.occupancy.read', 'squarespace.summary.read',
    'ownerrez.mutation.propose', 'ownerrez.mutation.confirm',
    'email.activity.read', 'email.message.observe', 'email.reply.propose', 'email.reply.confirm', 'email.message.classify',
    'qbo.write', 'qbo.bank_balances.read', 'qbo.report.read', 'accounting.reconciliation.read',
    'business.snapshot.read', 'whatsapp.status.read',
  ]) assert.equal(definitions.has(expected), true, expected);
  assert.equal(definitions.get('business.snapshot.read').mutates, false);
  assert.equal(definitions.get('email.activity.read').capability, 'email.read');
  assert.equal(definitions.get('crm.contacts.read').capability, 'crm.read');
  assert.equal(definitions.get('whatsapp.status.read').version, 3);
  assert.equal(definitions.get('qbo.write').autonomous, true);
  assert.equal(definitions.get('accounting.reconciliation.read').mutates, false);
  assert.equal(definitions.has('shell.exec'), false);
});

test('accounting reconciliation read returns the latest verified QBO run and projected bank rows', async () => {
  await withDb(async db => {
    const qboRunId = 'qbo-read-source';
    await db.query(sql`INSERT INTO workflow_runs (
      id, workflow_name, workflow_version, idempotency_key, status,
      trigger_type, input_json, output_json, state_json, created_at, completed_at
    ) VALUES (
      ${qboRunId}, 'qbo.write', 2, 'seed:qbo-read-source', 'completed',
      'system', ${JSON.stringify({ csvPath: 'accounting/inbox/processed/latest.csv' })},
      ${JSON.stringify({ status: 'verified_by_readback', evidenceId: 'qbo-evidence', qbo: {
        complete: true, principalRecorded: 1, principalTotal: 1,
        feeRecordsRecorded: 0, feeRecordsExpected: 0, held: 0,
      } })}, '{}', datetime('now','-1 minute'), datetime('now'))`);
    await db.query(sql`INSERT INTO accounting_bank_transactions (
      id, source_key, transaction_date, description, reference, direction,
      currency, amount, amount_usd, category_key, category_name,
      classification_tier, source_file_hash, workflow_run_id,
      qbo_workflow_run_id, qbo_entity_type, qbo_entity_id,
      qbo_category_key, qbo_category_name, qbo_recorded_at, status
    ) VALUES (
      'bank-1', 'bank-source-1', '2026-08-14', 'INSTITUCIONALES BAHIA', 'card-ref', 'debit',
      'MXN', 513.93, 30.16, 'supplies', 'Supplies',
      'auto', 'file-hash', ${qboRunId}, ${qboRunId}, 'Purchase', '2601',
      'supplies', 'Supplies', datetime('now'), 'posted'
    )`);
    const read = await startGraph(db, getDefinition('accounting.reconciliation.read'), {
      idempotencyKey: 'accounting-read:test', triggerType: 'model_tool',
      triggerRef: 'slack-1', channelId: 'C-ACCOUNTING', actorUserId: 'U-JASON', input: { detail: true },
    });
    assert.equal(read.status, 'completed', read.error_message);
    assert.equal(read.output.latest.workflowRunId, qboRunId);
    assert.equal(read.output.latest.evidenceId, 'qbo-evidence');
    assert.equal(read.output.latest.summary.complete, true);
    assert.equal(read.output.latest.transactions[0].qbo_entity_id, '2601');
    assert.equal(read.output.latest.sourceCsv, 'latest.csv');
  });
});

test('receipt status reads apply narrow transaction filters and reconciled scope', async () => {
  await withDb(async db => {
    for (const receipt of [
      {
        id: 'receipt-posted', message: 'Fidencio Lopez ref 0674062090', status: 'posted',
        vendor: 'Fidencio Lopez', date: '2026-08-14', amount: 3300, qboId: '2602', submitted: '2026-08-14T21:10:00Z',
      },
      {
        id: 'receipt-review', message: 'Fidencio Lopez duplicate', status: 'needs_review',
        vendor: 'Fidencio Lopez', date: '2026-08-14', amount: 3300, qboId: null, submitted: '2026-08-14T21:00:00Z',
      },
      {
        id: 'receipt-other', message: 'Other vendor', status: 'posted',
        vendor: 'Other Vendor', date: '2026-08-13', amount: 100, qboId: '2601', submitted: '2026-08-13T21:00:00Z',
      },
    ]) {
      await db.query(sql`INSERT INTO accounting_receipts (
        id, slack_channel_id, slack_message_id, submitted_by, submitted_at,
        message_text, source_hash, status, vendor, transaction_date, currency,
        amount, qbo_entity_type, qbo_entity_id, posted_at
      ) VALUES (
        ${receipt.id}, 'RECEIPT-A', ${receipt.id}, 'U-JASON', ${receipt.submitted},
        ${receipt.message}, ${`hash-${receipt.id}`}, ${receipt.status}, ${receipt.vendor},
        ${receipt.date}, 'MXN', ${receipt.amount},
        ${receipt.qboId ? 'JournalEntry' : null}, ${receipt.qboId},
        ${receipt.qboId ? receipt.submitted : null}
      )`);
    }
    const lookup = await startGraph(db, getDefinition('receipts.status.read'), {
      idempotencyKey: 'receipt-read:lookup', triggerType: 'model_tool',
      channelId: 'C-ACCOUNTING', actorUserId: 'U-JASON',
      input: { query: 'Fidencio Lopez', date: '2026-08-14', currency: 'MXN', amount: 3300, order: 'desc' },
    });
    assert.equal(lookup.status, 'completed', lookup.error_message);
    assert.deepEqual(lookup.output.receipts.map(receipt => receipt.id), ['receipt-posted', 'receipt-review']);
    assert.equal(lookup.output.filters.query, 'Fidencio Lopez');

    const reconciled = await startGraph(db, getDefinition('receipts.status.read'), {
      idempotencyKey: 'receipt-read:reconciled', triggerType: 'model_tool',
      channelId: 'C-ACCOUNTING', actorUserId: 'U-JASON',
      input: { scope: 'reconciled', order: 'desc' },
    });
    assert.equal(reconciled.status, 'completed', reconciled.error_message);
    assert.deepEqual(reconciled.output.receipts.map(receipt => receipt.id), ['receipt-posted', 'receipt-other']);
  });
});

test('QBO projection resolves exact transactions retained from overlapping Kapital source files', async () => {
  await withDb(async db => {
    const qboRunId = 'qbo-overlap-projection';
    await db.query(sql`INSERT INTO workflow_runs (
      id, workflow_name, workflow_version, idempotency_key, status,
      trigger_type, input_json, state_json
    ) VALUES (
      ${qboRunId}, 'qbo.write', 2, 'seed:qbo-overlap-projection', 'running',
      'system', '{}', '{}'
    )`);
    for (const [id, reference, sourceFileHash] of [
      ['bank-old', 'Clave: 136-06/08/2026/old', 'older-file-hash'],
      ['bank-new', 'Clave: 136-06/08/2026/new', 'current-file-hash'],
    ]) {
      await db.query(sql`INSERT INTO accounting_bank_transactions (
        id, source_key, transaction_date, description, reference, direction,
        currency, amount, category_key, category_name, classification_tier,
        source_file_hash, workflow_run_id, status
      ) VALUES (
        ${id}, ${`source-${id}`}, '2026-08-06', 'Sergio payment', ${reference}, 'debit',
        'MXN', 2105, 'maintenance', 'Maintenance', 'auto',
        ${sourceFileHash}, ${qboRunId}, 'classified'
      )`);
    }
    const projected = await projectBankTransactionQboWrites(db, qboRunId, {
      source_file_hash: 'current-file-hash',
      dedup_details: [{
        date: '2026-08-06', amount: 2105,
        reference: 'Clave: 136-06/08/2026/old', status: 'EXISTING',
        qbo_id: '2522', qbo_entity_type: 'Purchase',
        category_key: 'maintenance', category: 'Maintenance',
      }],
      details: [{
        date: '2026-08-06', amount: 2105,
        reference: 'Clave: 136-06/08/2026/new', status: 'PUSHED',
        qbo_id: '2523', record_type: 'expense', request_id: 'request-2523',
        category_key: 'uncategorized_expense', category: 'Uncategorized Expense',
        requires_review: true,
      }],
    });
    assert.equal(projected, true);
    const rows = await db.query(sql`SELECT id, source_file_hash, status, qbo_entity_id,
      qbo_category_key, review_required FROM accounting_bank_transactions ORDER BY id`);
    assert.deepEqual(rows, [
      {
        id: 'bank-new', source_file_hash: 'current-file-hash', status: 'posted_review',
        qbo_entity_id: '2523', qbo_category_key: 'uncategorized_expense', review_required: 1,
      },
      {
        id: 'bank-old', source_file_hash: 'older-file-hash', status: 'already_recorded',
        qbo_entity_id: '2522', qbo_category_key: 'maintenance', review_required: 0,
      },
    ]);
  });
});

test('email activity reads live Gmail and reports durable ledger coverage separately', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE contacts (id INTEGER PRIMARY KEY)`);
    await db.query(sql`CREATE TABLE leads (id INTEGER PRIMARY KEY)`);
    await db.query(sql`CREATE TABLE outreach_sends (id INTEGER PRIMARY KEY)`);
    await db.query(sql`INSERT INTO email_threads (
      direction, subject, received_at, provider, provider_message_id,
      processing_status, slack_channel_id, slack_message_ts
    ) VALUES (
      'inbound', 'Captured subject', '2026-08-13T16:32:28.000Z', 'gmail', 'gmail-captured',
      'processed', 'SARAH-EMAIL', '171.1'
    )`);
    const run = await startGraph(db, getDefinition('email.activity.read'), {
      idempotencyKey: 'email-activity-1', triggerType: 'slack',
      channelId: 'SARAH-EMAIL', actorUserId: 'TEST-OWNER',
      input: { start: '2026-08-13', end: '2026-08-13', direction: 'inbound', limit: 25 },
    }, {
      readEmailActivity: async input => {
        assert.equal(input.start, '2026-08-13T07:00:00.000Z');
        assert.equal(input.end, '2026-08-14T07:00:00.000Z');
        return {
          total: 2, inbound: 2, outbound: 0, unread: 2, spam: 0, truncated: false,
          messages: [
            { id: 'gmail-captured', threadId: 'thread-1', direction: 'inbound',
              internalDate: '2026-08-13T16:32:28.000Z', from: { name: 'Guest One', address: 'one@example.com' },
              to: 'sarah@example.com', subject: 'Captured subject', text: 'First message', labelIds: ['INBOX', 'UNREAD'] },
            { id: 'gmail-missing', threadId: 'thread-2', direction: 'inbound',
              internalDate: '2026-08-13T16:39:28.000Z', from: { name: 'Guest Two', address: 'two@example.com' },
              to: 'sarah@example.com', subject: 'Missing subject', text: 'Second message', labelIds: ['INBOX', 'UNREAD'] },
          ],
        };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.authority, 'Sarah Gmail live mailbox');
    assert.equal(run.output.totalMessages, 2);
    assert.equal(run.output.unreadMessages, 2);
    assert.equal(run.output.ledgerCapturedMessages, 1);
    assert.equal(run.output.ledgerMissingMessages, 1);
    assert.equal(run.output.messages[0].ledger.slackProjected, true);
    assert.equal(run.output.messages[1].ledger.captured, false);
    assert.equal(run.output._evidence.source, 'gmail.live_mailbox_api+sqlite.email_threads');
  });
});

test('email activity local date windows honor Pacific daylight-saving boundaries', () => {
  assert.equal(readModelInternals.zonedMidnightUtc('2026-03-08'), '2026-03-08T08:00:00.000Z');
  assert.equal(readModelInternals.zonedMidnightUtc('2026-03-09'), '2026-03-09T07:00:00.000Z');
  assert.equal(readModelInternals.zonedMidnightUtc('2026-11-01'), '2026-11-01T07:00:00.000Z');
  assert.equal(readModelInternals.zonedMidnightUtc('2026-11-02'), '2026-11-02T08:00:00.000Z');
  assert.throws(() => readModelInternals.validateEmailActivityInput({ start: '2026-08-13', end: '2026-10-01' }), /31 days/);
});

test('WhatsApp status reads default to outbound, resolve recipients, and disclose legacy coverage', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, slack_thread_ts, direction, delivery_status,
      provider_status_updated_at, delivered_at, read_at
    ) VALUES
      ('2026-08-10T12:00:00.000Z', 'whatsapp', '+14155550100', 'Legacy Guest',
        'SM-LEGACY', 'Old inbound', '{}', '100.1', NULL, NULL, NULL, NULL, NULL),
      ('2026-08-13T12:00:00.000Z', 'whatsapp', '+14155550101', 'Current Guest',
        'SM-INBOUND', 'Hello', '{}', '200.1', 'inbound', 'delivered',
        '2026-08-13T12:00:00.000Z', '2026-08-13T12:00:00.000Z', NULL)`);
    const [inbound] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='SM-INBOUND'`);
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, slack_thread_ts, direction, delivery_status,
      provider_status_updated_at, delivered_at, read_at
    ) VALUES (
      '2026-08-13T12:05:00.000Z', 'whatsapp', 'outbound', 'Jason',
      'SM-OUTBOUND', 'Welcome', ${JSON.stringify({ reply_to_dm_id: inbound.id, twilio_sid: 'SM-OUTBOUND' })},
      '200.1', 'outbound', 'read', '2026-08-13T12:06:00.000Z',
      '2026-08-13T12:05:30.000Z', '2026-08-13T12:06:00.000Z'
    )`);

    const outbound = await startGraph(db, getDefinition('whatsapp.status.read'), {
      idempotencyKey: 'whatsapp-status-outbound', triggerType: 'slack',
      channelId: 'C-WA', actorUserId: 'U-JASON', input: {},
    });
    assert.equal(outbound.status, 'completed', outbound.error_message);
    assert.equal(outbound.output.direction, 'outbound');
    assert.equal(outbound.output.totalMessages, 1);
    assert.equal(outbound.output.displayedMessages, 1);
    assert.equal(outbound.output.messages[0].contact_name, 'Current Guest');
    assert.equal(outbound.output.messages[0].sent_by_name, 'Jason');
    assert.equal(outbound.output.messages[0].delivery_status, 'read');
    assert.deepEqual(outbound.output.statusCounts, {
      read: 1, delivered: 0, failed: 0, unconfirmed: 0,
    });
    assert.equal(outbound.output.followUpRequiredMessages, 0);
    assert.equal(outbound.output.legacyUntrackedMessages, 1);
    assert.match(outbound.output.legacyCoverageNote, /can be recovered/);
    assert.equal(outbound.output._evidence.source, 'twilio.delivery_ledger');

    const all = await startGraph(db, getDefinition('whatsapp.status.read'), {
      idempotencyKey: 'whatsapp-status-all', triggerType: 'slack',
      channelId: 'C-BI', actorUserId: 'U-JASON', input: { direction: 'all' },
    });
    assert.equal(all.output.totalMessages, 3);
    assert.equal(all.output.messages.find(message => message.message_id === 'SM-LEGACY').direction, 'legacy_untracked');
    assert.equal(all.output.messages.find(message => message.message_id === 'SM-LEGACY').delivery_status, 'untracked_legacy');
  });
  assert.throws(() => readModelInternals.validateWhatsAppStatusInput({ direction: 'recent' }), /outbound, inbound, or all/);
  assert.throws(() => readModelInternals.validateWhatsAppStatusInput({ detail: true }), /unsupported whatsapp\.status\.read input: detail/);
});

test('CRM contact reads consolidate full POCs across CRM sources and WhatsApp history', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, company TEXT,
      source TEXT, status TEXT, relationship_type TEXT, preferred_channel TEXT,
      do_not_contact INTEGER, do_not_contact_reason TEXT, addressable INTEGER, updated_at TEXT
    )`);
    await db.query(sql`CREATE TABLE leads (
      id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, source TEXT,
      status TEXT, updated_at TEXT
    )`);
    await db.query(sql`CREATE TABLE squarespace_customers (
      squarespace_customer_id TEXT PRIMARY KEY, contact_id INTEGER,
      first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
      accepts_marketing INTEGER, created_on TEXT, synced_at TEXT
    )`);
    await db.query(sql`INSERT INTO contacts (
      id, name, email, phone, company, source, status, relationship_type,
      preferred_channel, do_not_contact, addressable, updated_at
    ) VALUES
      (1, 'Bethany Guest', 'bethany@example.com', '+14155550101', NULL,
        'ownerrez', 'inquiry', 'past_guest_inquired', 'whatsapp', 0, 1,
        '2026-08-13T12:00:00.000Z'),
      (2, 'Fakhara Guest', 'fakhara@example.com', '+14155550102', NULL,
        'manual', 'inquiry', NULL, 'whatsapp', 1, 1,
        '2026-08-12T12:00:00.000Z')`);
    await db.query(sql`INSERT INTO leads (
      id, name, email, phone, source, status, updated_at
    ) VALUES (
      10, 'Bethany inquiry', NULL, '+14155550101', 'whatsapp', 'new',
      '2026-08-14T12:00:00.000Z'
    )`);
    await db.query(sql`INSERT INTO squarespace_customers (
      squarespace_customer_id, contact_id, first_name, last_name, email, phone,
      accepts_marketing, created_on, synced_at
    ) VALUES (
      'sq-1', NULL, 'Mery', 'Client', 'mery@example.com', '+5215555550103',
      1, '2026-08-10T12:00:00.000Z', '2026-08-14T11:00:00.000Z'
    )`);
    const recentInbound = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, slack_thread_ts, direction, delivery_status
    ) VALUES (
      ${recentInbound}, 'whatsapp', '+14155550101', 'Bethany WA', 'SM-BETHANY',
      'Hello', '{}', '300.1', 'inbound', 'delivered'
    )`);

    const run = await startGraph(db, getDefinition('crm.contacts.read'), {
      idempotencyKey: 'crm-contacts-multiple', triggerType: 'slack',
      channelId: 'C-WA', actorUserId: 'U-JASON',
      input: { queries: ['Bethany', 'Mery', 'Missing Person'], limit: 10 },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.authority, 'CRM consolidated contact ledger');
    assert.equal(run.output.totalMatches, 2);
    assert.equal(run.output.displayedContacts, 2);
    assert.deepEqual(run.output.unmatchedQueries, ['Missing Person']);
    const bethany = run.output.contacts.find(contact => contact.name === 'Bethany Guest');
    assert.equal(bethany.contactRef, 'contact:1');
    assert.equal(bethany.phone, '+14155550101');
    assert.equal(bethany.email, 'bethany@example.com');
    assert.deepEqual(bethany.recordRefs.sort(), ['contact:1', 'lead:10', `whatsapp:${bethany.whatsapp.dmId}`].sort());
    assert.ok(bethany.sources.includes('contacts:ownerrez'));
    assert.ok(bethany.sources.includes('leads:whatsapp'));
    assert.ok(bethany.sources.includes('whatsapp_inbound'));
    assert.equal(bethany.whatsapp.knownInbound, true);
    assert.equal(bethany.whatsapp.serviceWindowOpen, true);
    assert.equal(bethany.whatsapp.eligibility, 'known_whatsapp_contact');
    assert.equal(run.output._evidence.source, 'crm.contacts+leads+meta_messages+squarespace_customers');

    const dnc = await startGraph(db, getDefinition('crm.contacts.read'), {
      idempotencyKey: 'crm-contacts-dnc', triggerType: 'slack',
      channelId: 'C-WA', actorUserId: 'U-JASON', input: { query: 'Fakhara' },
    });
    assert.equal(dnc.output.contacts[0].doNotContact, true);
    assert.equal(dnc.output.contacts[0].whatsapp.eligibility, 'blocked_do_not_contact');
  });
  assert.deepEqual(readModelInternals.normalizeContactQueries({ query: 'Bethany, Mery; Jim Simard' }), [
    'Bethany', 'Mery', 'Jim Simard',
  ]);
  assert.throws(() => readModelInternals.validateCrmContactsInput({ includeSecrets: true }), /unsupported crm\.contacts\.read input/);
  assert.throws(() => readModelInternals.validateCrmContactsInput({ queries: 'Bethany' }), /must be an array/);
});

test('durable shell jobs preserve review gates for ambiguous non-idempotent outcomes', async () => {
  const execute = getDefinition('squarespace.crm.sync').steps
    .find(step => step.key === 'execute');
  assert.equal(execute.maxAttempts, 2);
  let commandCalls = 0;
  const base = {
    run: { id: '11111111-1111-4111-8111-111111111111' },
    input: {},
    state: { register_effect: { effectId: 'effect-1' } },
    stepKey: 'execute',
    services: {
      shadowMode: false,
      runCommand: async () => {
        commandCalls += 1;
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    },
  };

  await assert.rejects(() => execute.run({
    ...base,
    db: { query: async () => { throw new Error('SQLITE_BUSY: database is locked'); } },
    store: {},
  }), error => (
    error.code === 'pre_dispatch_state_unavailable'
    && error.retryable === true
    && error.requiresManualReview !== true
  ));
  assert.equal(commandCalls, 0);

  await assert.rejects(() => execute.run({
    ...base,
    db: { query: async () => [{ id: 'effect-1', status: 'requested', provider_ref: null }] },
    store: {
      sha256: () => 'hash',
      transitionEffect: async () => { throw new Error('SQLITE_BUSY: database is locked'); },
    },
  }), error => (
    error.code === 'post_dispatch_projection_failed'
    && error.retryable === false
    && error.requiresManualReview === true
  ));
  assert.equal(commandCalls, 1);

  const nonIdempotentExecute = getDefinition('paulina.daily').steps
    .find(step => step.key === 'execute');
  await assert.rejects(() => nonIdempotentExecute.run({
    ...base,
    db: { query: async () => [{ id: 'effect-1', status: 'requested', provider_ref: null }] },
    services: {
      shadowMode: false,
      runCommand: async () => { throw new Error('connection closed after dispatch'); },
    },
    store: {},
  }), error => (
    error.code === 'ambiguous_external_result'
    && error.retryable === false
  ));
});

test('CRM source-sync command failures retry without opening external-mutation review', async () => {
  await withDb(async db => {
    const definition = getDefinition('ownerrez.crm.sync');
    const execute = definition.steps.find(step => step.key === 'execute');
    assert.equal(definition.crashRecovery, 'retry');
    assert.equal(execute.effectClass, 'external_idempotent');

    let commandCalls = 0;
    const services = {
      runCommand: async () => {
        commandCalls += 1;
        if (commandCalls === 1) {
          const error = new Error('workflow command failed (node, exit 1): OwnerRez sync incomplete: inquiries: Timeout');
          error.code = 'workflow_command_failed';
          throw error;
        }
        return {
          exitCode: 0,
          stderr: '',
          stdout: '{"inquiries":1,"bookings":0,"contacts_created":0,"contacts_updated":1,"leads_created":0}',
        };
      },
    };
    const first = await startGraph(db, definition, {
      idempotencyKey: 'ownerrez-timeout-retry', triggerType: 'system', input: {},
    }, services);
    assert.equal(first.status, 'retry');
    assert.equal(first.error_code, 'workflow_command_failed');
    assert.equal(first.steps.find(step => step.step_key === 'execute').status, 'retry');
    assert.equal(first.manualReviews.length, 0);
    assert.equal(first.effects[0].status, 'requested');

    await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
      WHERE run_id=${first.id} AND step_key='execute'`);
    const completed = await executeGraph(db, definition, first.id, services);
    assert.equal(completed.status, 'completed', completed.error_message);
    assert.equal(commandCalls, 2);
    assert.equal(completed.manualReviews.length, 0);
    assert.equal(completed.effects[0].status, 'verified_by_readback');
  });
});

test('exhausted CRM source-sync retries fail the effect without manual review', async () => {
  await withDb(async db => {
    const definition = getDefinition('ownerrez.crm.sync');
    const services = {
      runCommand: async () => {
        const error = new Error('workflow command failed (node, exit 1): OwnerRez sync incomplete: bookings: Timeout');
        error.code = 'workflow_command_failed';
        throw error;
      },
    };
    let run = await startGraph(db, definition, {
      idempotencyKey: 'ownerrez-timeout-exhausted', triggerType: 'system', input: {},
    }, services);
    assert.equal(run.status, 'retry');
    await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
      WHERE run_id=${run.id} AND step_key='execute'`);
    run = await executeGraph(db, definition, run.id, services);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'workflow_command_failed');
    assert.equal(run.manualReviews.length, 0);
    assert.equal(run.effects[0].status, 'failed');
    assert.equal(run.effects[0].provider_status, 'command_failed');
  });
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

test('Meta DM replies use a command-only durable effect and never claim delivery', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, raw_payload, direction)
      VALUES ('2026-08-11T17:00:00Z', 'instagram', 'IG-RECIPIENT', 'Guest', 'MID-IN', 'Hello', '{}', 'inbound')`);
    const [message] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='MID-IN'`);
    let sends = 0;
    const request = {
      idempotencyKey: 'slack:C-SOCIAL:meta-reply', triggerType: 'slack_meta_dm_command',
      channelId: 'C-SOCIAL', actorUserId: 'U-JASON',
      input: { dmId: message.id, message: 'Welcome', actorName: 'Jason' },
    };
    const services = {
      sendMetaDm: async () => { sends += 1; return { message_id: 'MID-OUT' }; },
    };
    const first = await startGraph(db, getDefinition('meta.dm.reply'), request, services);
    const replay = await startGraph(db, getDefinition('meta.dm.reply'), request, services);
    assert.equal(first.status, 'completed');
    assert.equal(first.output.status, 'accepted_by_provider');
    assert.equal(first.output.deliveryConfirmed, undefined);
    assert.equal(replay.id, first.id);
    assert.equal(sends, 1);
  });
});

test('Meta acceptance survives a local projection failure without a second provider send', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, raw_payload, direction)
      VALUES ('2026-08-11T17:00:00Z', 'instagram', 'IG-PROJECTION', 'Guest',
        'MID-IN-PROJECTION', 'Hello', '{}', 'inbound')`);
    const [message] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='MID-IN-PROJECTION'`);
    await db.query(sql`CREATE TRIGGER fail_meta_projection BEFORE INSERT ON meta_messages
      WHEN NEW.direction='outbound' BEGIN SELECT RAISE(FAIL, 'injected projection failure'); END`);
    let sends = 0;
    const definition = getDefinition('meta.dm.reply');
    const services = {
      sendMetaDm: async () => { sends += 1; return { message_id: 'MID-OUT-PROJECTION' }; },
    };
    const first = await startGraph(db, definition, {
      idempotencyKey: 'meta-projection-one-send', triggerType: 'slack_meta_dm_command',
      channelId: 'C-SOCIAL', actorUserId: 'U-JASON',
      input: { dmId: message.id, message: 'One Meta message', actorName: 'Jason' },
    }, services);
    assert.equal(first.status, 'retry');
    assert.equal(first.effects[0].status, 'accepted_by_provider');
    assert.equal(first.effects[0].verification_mode, 'provider_acceptance');
    assert.equal(sends, 1);
    await db.query(sql`DROP TRIGGER fail_meta_projection`);
    await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
      WHERE run_id=${first.id} AND step_key='persist_outbound_projection'`);
    const completed = await executeGraph(db, definition, first.id, services);
    assert.equal(completed.status, 'completed', completed.error_message);
    assert.equal(sends, 1);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM meta_messages
      WHERE message_id='MID-OUT-PROJECTION'`);
    assert.equal(count, 1);
  });
});

test('receipt ingestion is idempotent, hash-verified, and channel-scoped', async () => {
  await withDb(async db => {
    const definition = getDefinition('receipt.ingest');
    const request = {
      idempotencyKey: 'slack:RECEIPT-A:171.2:receipt.ingest',
      triggerType: 'slack_receipt_hook', triggerRef: '171.2', channelId: 'RECEIPT-A', actorUserId: 'UTESTWORKER',
      input: { slackMessageId: '171.2' },
    };
    const services = { fetchSlackReceipt: async () => ({
      channelId: 'RECEIPT-A', messageId: '171.2', messageText: 'Materials 1250 MXN',
      submittedAt: '2026-08-10T12:00:00.000Z', shouldProcess: true,
      files: [{ id: 'F1', name: 'receipt.jpg', mimetype: 'image/jpeg', size: 100,
        sha256: 'a'.repeat(64), localPath: '/runtime/receipt.jpg' }],
    }) };
    const first = await startGraph(db, definition, request, services);
    const replay = await startGraph(db, definition, request);
    assert.equal(first.id, replay.id);
    assert.equal(first.output.status, 'queued');
    assert.ok(first.output.processRunId);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM accounting_receipts`);
    assert.equal(count, 1);

    const annotate = getDefinition('receipt.annotate');
    const annotated = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-A:171.3:receipt.annotate',
      triggerType: 'slack', channelId: 'RECEIPT-A', actorUserId: 'UTESTWORKER',
      input: {
        receiptId: first.output.receiptId, amount: 1250, currency: 'MXN',
        transactionDate: '2026-08-10', vendor: 'Hardware',
        categoryKey: 'maintenance', categoryName: 'Maintenance',
        description: 'Replacement hardware for villa doors',
        paymentSource: 'personal_reimbursement',
        items: [
          {
            fileRefId: 'F1', amount: 1000, currency: 'MXN', transactionDate: '2026-08-10',
            vendor: 'Hardware A', categoryKey: 'maintenance', categoryName: 'Maintenance',
            description: 'Door locks',
          },
          {
            amount: 250, currency: 'MXN', transactionDate: '2026-08-10',
            vendor: 'Cleaner', categoryKey: 'cleaning_services', categoryName: 'Cleaning Services',
            description: 'Cleanup after installation',
          },
        ],
      },
    });
    assert.equal(annotated.status, 'completed', annotated.error_message);
    assert.equal(annotated.output.receiptStatus, 'extracted');
    const [receipt] = await db.query(sql`SELECT description, category_key, category_name,
      payment_reference, reimbursement_recipient_user_id, payment_instruction_queued_at
      FROM accounting_receipts WHERE id=${first.output.receiptId}`);
    assert.equal(receipt.description, 'Replacement hardware for villa doors');
    assert.equal(receipt.category_key, 'maintenance');
    assert.equal(receipt.category_name, 'Maintenance');
    assert.match(receipt.payment_reference, /^LPDSR[A-F0-9]{16}$/);
    assert.equal(receipt.reimbursement_recipient_user_id, 'UTESTWORKER');
    assert.ok(receipt.payment_instruction_queued_at);
    assert.equal(annotated.output.paymentReference, receipt.payment_reference);
    assert.equal(annotated.output.instructionStatus, 'pending');
    const [instruction] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${annotated.output.outboxId}`);
    const instructionPayload = JSON.parse(instruction.payload_json);
    assert.equal(instructionPayload.channelId, 'RECEIPT-A');
    assert.equal(instructionPayload.threadTs, '171.2');
    assert.match(instructionPayload.message, /<@U123MAYELA> por favor confirma que el gasto y la clasificación son válidos/);
    assert.match(instructionPayload.message, /MXN \$1,000\.00 · Maintenance/);
    assert.match(instructionPayload.message, /MXN \$250\.00 · Cleaning Services/);
    assert.match(instructionPayload.message, new RegExp(receipt.payment_reference));
    assert.equal(annotated.output.itemCount, 2);
    const items = await db.query(sql`SELECT item_index, file_ref_id, amount, category_key
      FROM accounting_receipt_items WHERE receipt_id=${first.output.receiptId} ORDER BY item_index`);
    assert.deepEqual(items, [
      { item_index: 1, file_ref_id: 'F1', amount: 1000, category_key: 'maintenance' },
      { item_index: 2, file_ref_id: null, amount: 250, category_key: 'cleaning_services' },
    ]);

    await db.query(sql`UPDATE accounting_receipts
      SET payment_reference='LPDS-R-A1B2C3D4E5F60718'
      WHERE id=${first.output.receiptId}`);
    const corrected = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-A:171.3:receipt.annotate:kapital-safe',
      triggerType: 'slack', channelId: 'RECEIPT-A', actorUserId: 'UTESTWORKER',
      input: {
        receiptId: first.output.receiptId, amount: 1250, currency: 'MXN',
        transactionDate: '2026-08-10', vendor: 'Hardware',
        categoryKey: 'maintenance', categoryName: 'Maintenance',
        description: 'Replacement hardware for villa doors',
      },
    });
    assert.equal(corrected.status, 'completed', corrected.error_message);
    assert.equal(corrected.output.paymentReference, 'LPDSRA1B2C3D4E5F60718');
    assert.equal(corrected.output.paymentReferenceMigrated, true);
    const [correctedInstruction] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${corrected.output.outboxId}`);
    assert.match(JSON.parse(correctedInstruction.payload_json).message,
      /Instrucción corregida para el reembolso en Kapital/);

    assert.throws(() => annotate.validate({
      receiptId: first.output.receiptId, amount: 1250, currency: 'MXN',
      items: [{ amount: 1200, currency: 'MXN' }],
    }), /does not equal receipt amount/);

    const denied = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-B:171.4:receipt.annotate',
      triggerType: 'slack', channelId: 'RECEIPT-B', actorUserId: 'TEST-OTHER',
      input: { receiptId: first.output.receiptId, amount: 1, currency: 'MXN' },
    });
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error_code, 'receipt_scope_violation');
  });
});

test('receipt reconciliation uses an exact payment reference before the legacy date window', async () => {
  await withDb(async db => {
    const receipts = [
      ['11111111-1111-4111-8111-111111111111', 'LPDSRA1B2C3D4E5F60718', 2105, '2026-08-06'],
      ['22222222-2222-4222-8222-222222222222', 'LPDS-R-B1C2D3E4F5061728', 3086, '2026-08-13'],
      ['33333333-3333-4333-8333-333333333333', null, 500, '2026-08-10'],
    ];
    for (const [id, reference, amount, transactionDate] of receipts) {
      await db.query(sql`INSERT INTO accounting_receipts (
        id, slack_channel_id, slack_message_id, submitted_at, source_hash, status,
        transaction_date, currency, amount, payment_reference
      ) VALUES (${id}, 'RECEIPT-A', ${id}, '2026-08-13T12:00:00Z', ${id}, 'extracted',
        ${transactionDate}, 'MXN', ${amount}, ${reference})`);
    }
    const bankRows = [
      ['bank-ref-match', '2026-08-20', 'Reembolso LPDSRA1B2C3D4E5F60718', 2105],
      ['bank-uncoded-duplicate', '2026-08-06', 'Uncoded duplicate reimbursement', 2105],
      ['bank-ref-wrong-amount', '2026-08-13', 'LPDS-R-B1C2D3E4F5061728', 3000],
      ['bank-date-only-decoy', '2026-08-13', 'Other payment', 3086],
      ['bank-legacy', '2026-08-11', 'Legacy reimbursement', 500],
    ];
    for (const [sourceKey, transactionDate, description, amount] of bankRows) {
      await db.query(sql`INSERT INTO accounting_bank_transactions (
        id, source_key, transaction_date, description, currency, amount,
        classification_tier, source_file_hash
      ) VALUES (${sourceKey}, ${sourceKey}, ${transactionDate}, ${description}, 'MXN', ${amount},
        'unknown', 'statement-hash')`);
    }
    const run = await startGraph(db, getDefinition('receipt.reconcile'), {
      idempotencyKey: 'receipt-reconcile-reference-first',
      triggerType: 'system',
      input: {},
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.matched, 2);
    assert.equal(run.output.referenceMatched, 1);
    assert.equal(run.output.legacyMatched, 1);
    assert.equal(run.output.ambiguous, 1);
    const states = await db.query(sql`SELECT id, status, review_reason FROM accounting_receipts ORDER BY id`);
    assert.deepEqual(states, [
      { id: receipts[0][0], status: 'matched', review_reason: null },
      { id: receipts[1][0], status: 'needs_review', review_reason: 'payment_reference_amount_or_currency_mismatch' },
      { id: receipts[2][0], status: 'matched', review_reason: null },
    ]);
    const reconciliations = await db.query(sql`SELECT receipt_id, evidence_json
      FROM accounting_reconciliations ORDER BY receipt_id`);
    assert.equal(JSON.parse(reconciliations[0].evidence_json).rule, 'exact_payment_reference_amount_currency');
    assert.equal(JSON.parse(reconciliations[1].evidence_json).rule, 'unique_amount_currency_date_window');
    const lateCorrection = await startGraph(db, getDefinition('receipt.annotate'), {
      idempotencyKey: 'receipt-correction-after-match',
      triggerType: 'slack', channelId: 'RECEIPT-A', actorUserId: 'UTESTWORKER',
      input: { receiptId: receipts[0][0], amount: 2105, currency: 'MXN', transactionDate: '2026-08-06' },
    });
    assert.equal(lateCorrection.status, 'failed');
    assert.equal(lateCorrection.error_code, 'receipt_already_reconciled');
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

test('Postiz ambiguity and readback lag never create a second post', async () => {
  await withDb(async db => {
    const contentId = '11111111-1111-4111-8111-111111111111';
    await db.query(sql`INSERT INTO social_content
      (id, status, caption, media_refs_json, scheduled_for, created_by, updated_by)
      VALUES (${contentId}, 'approved', 'One post only',
        ${JSON.stringify([{ id: 'media-1', path: 'https://example.test/media.jpg' }])},
        '2026-08-20T17:00:00.000Z', 'U-JASON', 'U-JASON')`);
    let creates = 0;
    const services = {
      listPostizPosts: async () => [],
      createPostizPost: async () => {
        creates += 1;
        const error = new Error('provider accepted but connection closed');
        error.code = 'ambiguous_external_result';
        error.retryable = false;
        throw error;
      },
    };
    const definition = getDefinition('social.content.publish');
    const first = await startGraph(db, definition, {
      idempotencyKey: 'social-ambiguous-first', triggerType: 'model_tool',
      input: { contentId, scheduledFor: '2026-08-20T17:00:00.000Z' },
    }, services);
    assert.equal(first.status, 'failed');
    assert.equal(first.manualReviews[0].status, 'open');
    assert.equal(creates, 1);

    await assert.rejects(() => startGraph(db, definition, {
      idempotencyKey: 'social-ambiguous-second', triggerType: 'model_tool',
      input: { contentId, scheduledFor: '2026-08-20T17:00:00.000Z' },
    }, services), error => error.code === 'workflow_manual_review_open');
    assert.equal(creates, 1);
  });
});

test('a definitive Postiz rejection restores approved content for a corrected retry', async () => {
  await withDb(async db => {
    const contentId = '22222222-2222-4222-8222-222222222222';
    await db.query(sql`INSERT INTO social_content
      (id, status, caption, media_refs_json, scheduled_for, created_by, updated_by)
      VALUES (${contentId}, 'approved', 'Correctable post',
        ${JSON.stringify([{ id: 'media-2', path: 'https://example.test/media.jpg' }])},
        '2026-08-21T17:00:00.000Z', 'U-JASON', 'U-JASON')`);
    const error = new Error('Postiz rejected the request');
    error.code = 'postiz_api_error';
    error.status = 400;
    error.retryable = false;
    const run = await startGraph(db, getDefinition('social.content.publish'), {
      idempotencyKey: 'social-definitive-rejection', triggerType: 'model_tool',
      input: { contentId, scheduledFor: '2026-08-21T17:00:00.000Z' },
    }, {
      listPostizPosts: async () => [],
      createPostizPost: async () => { throw error; },
    });
    assert.equal(run.status, 'failed');
    assert.equal(run.manualReviews.length, 0);
    assert.equal(run.effects[0].status, 'failed');
    const [content] = await db.query(sql`SELECT status, workflow_run_id FROM social_content WHERE id=${contentId}`);
    assert.equal(content.status, 'approved');
    assert.equal(content.workflow_run_id, null);
  });
});

test('Paulina verification counts only attributed rows without posting an individual notification', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.daily'), {
      idempotencyKey: 'paulina-attribution-test', triggerType: 'system', input: {},
    }, {
      runCommand: async command => {
        commandCalls += 1;
        if (commandCalls === 1) {
          assert.match(command.env.WORKFLOW_RUN_ID, /^[0-9a-f-]{36}$/);
          await db.query(sql`INSERT INTO outreach_sends (status, sent_at, workflow_run_id)
            VALUES ('sent','2026-08-11T18:00:00Z',${command.env.WORKFLOW_RUN_ID}),
                   ('sent','2026-08-11T18:00:00Z','another-run')`);
          return {
            exitCode: 0,
            stdout: '[orchestrator] exit ok: {"processed":1,"sent":1,"failed":0,"ambiguous":0}\n',
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            generated_at: '2026-08-11T18:01:00Z',
            scope: { owner: 'paulina', active_campaign_slug: 'planner' },
            active_queue: { verified_ready: 2 },
          }),
          stderr: '',
        };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.sent, 1);
    assert.equal(run.state.verify_readback.evidence.attributedRows.sent, 1);
    const [evidence] = await db.query(sql`SELECT payload_json FROM workflow_evidence
      WHERE run_id=${run.id} AND source='crm.outreach_sends'`);
    assert.equal(JSON.parse(evidence.payload_json).attributedRows.sent, 1);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    assert.equal(count, 0);
  });
});

test('Paulina verified no-op runs do not post misleading Resend write notifications', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.daily'), {
      idempotencyKey: 'paulina-noop-notification-test', triggerType: 'system', input: {},
    }, {
      runCommand: async () => {
        commandCalls += 1;
        if (commandCalls === 1) {
          return {
            exitCode: 0,
            stdout: '[orchestrator] exit ok: {"processed":0,"sent":0,"failed":0,"ambiguous":0}\n',
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            generated_at: '2026-08-12T14:30:00Z',
            scope: { owner: 'paulina', active_campaign_slug: 'planner' },
            active_queue: { verified_ready: 11 },
          }),
          stderr: '',
        };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.sent, 0);
    assert.equal(run.steps.some(step => step.step_key === 'notify_humans'), false);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    assert.equal(count, 0);
  });
});

test('Paulina preparation is a run-scoped graph with verified stage effects', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY, slug TEXT, status TEXT, persona TEXT
    )`);
    await db.query(sql`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, email TEXT, email_status TEXT, do_not_contact INTEGER,
      status TEXT, source_query TEXT
    )`);
    await db.query(sql`CREATE TABLE campaign_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, contact_id INTEGER,
      attached_by TEXT, attached_at TEXT DEFAULT (datetime('now')),
      UNIQUE(campaign_id, contact_id)
    )`);
    await db.query(sql`CREATE TABLE suppressions (email TEXT)`);
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER,
      workflow_run_id TEXT, status TEXT, sent_at TEXT
    )`);
    await db.query(sql`INSERT INTO outreach_campaigns (id, slug, status, persona)
      VALUES (7, 'planner_partner_program_v1', 'active', 'wedding_planner')`);
    await db.query(sql`INSERT INTO contacts
      (id, email, email_status, do_not_contact, status, source_query)
      VALUES (1, 'one@example.test', 'verified', 0, 'new', 'run_wedding_planner'),
             (2, 'two@example.test', 'verified', 0, 'new', 'run_wedding_planner')`);

    const now = Date.now();
    await seedWorkflowRun(db, {
      id: 'prepare-previous', workflowName: 'paulina.prepare_daily', status: 'completed',
      startedAt: new Date(now - 26 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 25 * 60 * 60_000).toISOString(),
    });
    await seedWorkflowRun(db, {
      id: 'dispatch-one', workflowName: 'paulina.daily', status: 'completed',
      startedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      state: { verify_readback: { summary: { processed: 1, sent: 1, failed: 0, queueReady: 9 } } },
    });
    await seedWorkflowRun(db, {
      id: 'dispatch-two', workflowName: 'paulina.daily', status: 'completed',
      startedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 60 * 60_000).toISOString(),
      state: { verify_readback: { summary: { processed: 2, sent: 1, failed: 1, queueReady: 11 } } },
    });
    const policy = JSON.parse(fs.readFileSync(process.env.RESORT_WORKFLOW_POLICY_PATH, 'utf8'));
    policy.write_notifications.user_ids = ['SARAH'];
    fs.writeFileSync(process.env.RESORT_WORKFLOW_POLICY_PATH, JSON.stringify(policy));

    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.prepare_daily'), {
      idempotencyKey: 'paulina-prepare-2026-08-12', triggerType: 'system', input: {},
    }, {
      now: '2026-08-12T15:30:00.000Z',
      paulinaConfig: {
        reporting: { active_campaign_slug: 'planner_partner_program_v1' },
        email_verification: { queue_buffer_days: 2, max_per_daily_run: 25 },
      },
      paulinaState: { paused: false },
      runCommand: async command => {
        commandCalls += 1;
        const script = path.basename(command.args[0]);
        if (script === 'engagement-analysis.js') {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true,
            recent: { window_days: 14, production_sent: 4, external_replies: 1 },
          }) };
        }
        if (script === 'daily-capacity.js') {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, batch_size: 2, daily_target: 10, weekly_cap: 50, campaign_week: 1,
          }) };
        }
        if (script === 'run-research.js') {
          assert.equal(command.env.PAULINA_WORKFLOW_NO_SLACK, '1');
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, status: 'completed', inserted: 2, import_errors: 0,
          }) };
        }
        if (script === 'preverify-queue.js') {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, checked: 0, verified_available_before: 2,
            verified_available_after: 2, target_met: false,
          }) };
        }
        if (script === 'composer.js') {
          assert.match(command.env.WORKFLOW_RUN_ID, /^[0-9a-f-]{36}$/);
          await db.query(sql`INSERT INTO outreach_sends
            (campaign_id, workflow_run_id, status)
            VALUES (7, ${command.env.WORKFLOW_RUN_ID}, 'pending_approval'),
                   (7, ${command.env.WORKFLOW_RUN_ID}, 'pending_approval')`);
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, already_composed: 0,
            composed: [{ draft_id: 1 }, { draft_id: 2 }], failed: [],
          }) };
        }
        throw new Error(`unexpected command ${script}`);
      },
    });

    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(commandCalls, 5);
    assert.equal(run.output.batchSize, 2);
    assert.equal(run.output.attached, 2);
    assert.equal(run.output.composition.attributed_drafts, 2);
    const effects = await db.query(sql`SELECT status FROM workflow_effects
      WHERE run_id=${run.id} ORDER BY requested_at, id`);
    assert.equal(effects.length, 4);
    assert.deepEqual(new Set(effects.map(effect => effect.status)), new Set(['verified_by_readback']));
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, /Send digest: processed 3, sent 2, failed 1 across 2 CRM-verified runs; latest verified queue ready 11\./);
    assert.match(message, /composed 2 new drafts/);
    assert.doesNotMatch(message, /<@SARAH>|Sarah/);
    assert.equal(run.output.notification.digest.sent, 2);
  });
});

test('Paulina preparation records a weekend no-op without external effects', async () => {
  await withDb(async db => {
    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.prepare_daily'), {
      idempotencyKey: 'paulina-prepare-weekend', triggerType: 'system', input: {},
    }, {
      now: '2026-08-16T15:30:00.000Z',
      paulinaConfig: { reporting: { active_campaign_slug: 'planner_partner_program_v1' } },
      paulinaState: { paused: false },
      runCommand: async () => { commandCalls += 1; throw new Error('must not run'); },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.status, 'skipped');
    assert.equal(run.output.reason, 'weekend');
    assert.equal(commandCalls, 0);
    assert.equal(run.effects.length, 0);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE run_id=${run.id}`);
    assert.equal(count, 0);
  });
});

test('Paulina weekend preparation still posts one digest when the prior interval had sends', async () => {
  await withDb(async db => {
    const now = Date.now();
    await seedWorkflowRun(db, {
      id: 'weekend-dispatch', workflowName: 'paulina.daily', status: 'completed',
      startedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 60 * 60_000).toISOString(),
      state: { verify_readback: { summary: { processed: 1, sent: 1, failed: 0, queueReady: 7 } } },
    });
    const run = await startGraph(db, getDefinition('paulina.prepare_daily'), {
      idempotencyKey: 'paulina-prepare-weekend-with-sends', triggerType: 'system', input: {},
    }, {
      now: '2026-08-16T15:30:00.000Z',
      paulinaConfig: { reporting: { active_campaign_slug: 'planner_partner_program_v1' } },
      paulinaState: { paused: false },
      runCommand: async () => { throw new Error('must not run'); },
    });

    assert.equal(run.status, 'completed', run.error_message);
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, /processed 1, sent 1, failed 0 across 1 CRM-verified run/);
    assert.match(message, /Preparation skipped \(weekend\)/);
  });
});

test('Paulina preparation distinguishes safe pre-dispatch retry from post-command review', async () => {
  const base = {
    db: {},
    run: { id: '11111111-1111-4111-8111-111111111111' },
    state: { preflight: { campaignSlug: 'planner' } },
    stepKey: 'research',
    services: { runCommand: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }) },
  };
  const options = {
    provider: 'research', operation: 'test', request: {}, command: {},
    readback: async () => ({ ok: true }),
  };
  await assert.rejects(() => runVerifiedCommand({
    ...base,
    store: { createEffect: async () => { throw new Error('database locked'); } },
  }, options), error => error.retryable === true && error.requiresManualReview !== true);

  await assert.rejects(() => runVerifiedCommand({
    ...base,
    store: {
      createEffect: async () => ({ id: 'effect-1', status: 'requested' }),
      transitionEffect: async () => { throw new Error('projection failed'); },
    },
  }, options), error => error.retryable === false && error.requiresManualReview === true);
});

test('Regina daily aggregates verified runs without mentioning configured users', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    const now = Date.now();
    await seedWorkflowRun(db, {
      id: 'regina-daily-previous', workflowName: 'regina.daily', status: 'completed',
      startedAt: new Date(now - 26 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 25 * 60 * 60_000).toISOString(),
    });
    await seedWorkflowRun(db, {
      id: 'regina-campaign-recent', workflowName: 'regina.campaign', status: 'completed',
      startedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      state: { verify_readback: { summary: {
        campaignSlug: 'vip', created: 2, sent: 1, failed: 1,
      } } },
    });
    const policy = JSON.parse(fs.readFileSync(process.env.RESORT_WORKFLOW_POLICY_PATH, 'utf8'));
    policy.write_notifications.user_ids = ['SARAH'];
    fs.writeFileSync(process.env.RESORT_WORKFLOW_POLICY_PATH, JSON.stringify(policy));

    const run = await startGraph(db, getDefinition('regina.daily'), {
      idempotencyKey: 'regina-attribution-test', triggerType: 'system', input: {},
    }, {
      runCommand: async command => {
        assert.match(command.env.WORKFLOW_RUN_ID, /^[0-9a-f-]{36}$/);
        assert.equal(command.env.REGINA_WORKFLOW_NO_SUMMARY, '1');
        await db.query(sql`INSERT INTO outreach_sends (status, sent_at, workflow_run_id)
          VALUES ('sent','2026-08-11T18:00:00Z',${command.env.WORKFLOW_RUN_ID}),
                 ('sent','2026-08-11T18:00:00Z','legacy-producer')`);
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.created, 1);
    assert.equal(run.output.report.sent, 1);
    assert.equal(run.output.digest.created, 3);
    assert.equal(run.output.digest.sent, 2);
    assert.equal(run.output.digest.failed, 1);
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, /created 3, sent 2, failed 1 across 2 CRM-verified runs/);
    assert.match(message, /Campaign runs: anniversary 1, vip 1/);
    assert.doesNotMatch(message, /<@SARAH>|Sarah/);
  });
});

test('Regina ad-hoc campaigns feed the next digest without posting a run summary', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    const run = await startGraph(db, getDefinition('regina.campaign'), {
      idempotencyKey: 'regina-campaign-no-notification', triggerType: 'model_tool',
      input: { campaignSlug: 'vip', count: 1 },
    }, {
      runCommand: async command => {
        assert.equal(command.env.REGINA_WORKFLOW_NO_SUMMARY, '1');
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.campaignSlug, 'vip');
    assert.equal(run.steps.some(step => step.step_key === 'notify_humans'), false);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    assert.equal(count, 0);
  });
});

test('workflow control token is length-checked and compared exactly', () => {
  const token = 'a'.repeat(32);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, 'a'.repeat(31)), false);
  assert.equal(tokenMatches('short', 'short'), false);
});
