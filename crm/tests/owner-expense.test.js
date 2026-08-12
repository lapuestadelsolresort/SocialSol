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
const { executeGraph, startGraph } = require('../lib/workflow-engine');
const { getDefinition, listDefinitions } = require('../workflows/registry');
const { extractOwnerExpense } = require('../lib/receipt-extraction');
const { fetchSlackReceiptSource, isReceiptLikeText } = require('../lib/slack-receipt-source');

const CHANNEL = 'C123OWNER';
const ACTOR = 'U-OWNER';

async function withOwnerDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-expense-workflow-'));
  const db = createDB(path.join(directory, 'crm.db'));
  const priorAccounting = process.env.ACCOUNTING_CONFIG_PATH;
  const priorPolicy = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const accountingPath = path.join(directory, 'accounting.json');
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(accountingPath, JSON.stringify({
    qbo_accounts: {
      expenses: {
        maintenance: { id: '5100', name: 'Maintenance' },
        supplies: { id: '5200', name: 'Supplies' },
      },
    },
    owner_expense_channels: {
      [CHANNEL]: {
        name: '#receipt-owner', owner_name: 'Test Owner',
        liability_account: { id: '2100', name: 'Due to Test Owner (Net)' },
        repayment_bank_account: { id: '1100', name: 'Operating Bank' },
        auto_post_min_confidence: 0.9,
      },
    },
  }));
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1, shadow_mode: false,
    live_workflows: ['receipt.owner_expense.ingest', 'receipt.owner_expense.process', 'receipt.owner_expense.confirm'],
    autonomous_workflows: [], always_on_effects: [],
    channels: { [CHANNEL]: { name: 'receipt-owner', capabilities: ['qbo.owner_expense.write'] } },
    restricted_capabilities: {}, write_notifications: { user_ids: [], channel_ids: [] },
  }));
  process.env.ACCOUNTING_CONFIG_PATH = accountingPath;
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await ensureSchemaAsync(db, sql);
    return await run(db, directory);
  } finally {
    await db.dispose();
    if (priorAccounting === undefined) delete process.env.ACCOUNTING_CONFIG_PATH;
    else process.env.ACCOUNTING_CONFIG_PATH = priorAccounting;
    if (priorPolicy === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = priorPolicy;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function source({ messageText = 'The owner paid 4,700 MXN for compressor work', files = [] } = {}) {
  return {
    channelId: CHANNEL, messageId: '1786500000.123', messageText,
    submittedAt: '2026-08-06T12:00:00.000Z', files,
    shouldProcess: files.length > 0 || isReceiptLikeText(messageText),
  };
}

function extraction(overrides = {}) {
  return {
    ok: true,
    responseId: 'resp_test',
    model: 'gpt-4.1',
    requestHash: 'request-hash',
    extracted: {
      document_type: 'receipt', vendor: 'AC Ignacio Rubio', transaction_date: '2026-08-06',
      currency: 'MXN', amount: 4700, description: 'Compressor work', category_key: 'maintenance',
      transaction_kind: 'owner_paid_expense', is_business_expense: true,
      paid_by_owner: true, confidence: 0.98, review_reason: null,
      ...overrides,
    },
  };
}

async function ingest(db, services, suffix = 'base') {
  return startGraph(db, getDefinition('receipt.owner_expense.ingest'), {
    idempotencyKey: `slack:${CHANNEL}:1786500000.123:${suffix}`,
    triggerType: 'slack_receipt_hook', triggerRef: '1786500000.123',
    channelId: CHANNEL, actorUserId: ACTOR,
    input: { slackMessageId: '1786500000.123' },
  }, services);
}

test('registry exposes only the guarded owner-expense workflow family', () => {
  const definitions = new Map(listDefinitions().map(item => [item.name, item]));
  assert.equal(definitions.get('receipt.owner_expense.ingest').capability, 'qbo.owner_expense.write');
  assert.deepEqual(definitions.get('receipt.owner_expense.process').allowed_triggers, ['workflow']);
  assert.deepEqual(definitions.get('receipt.owner_expense.confirm').allowed_triggers, ['slack_receipt_confirm_command']);
  assert.deepEqual(definitions.get('receipt.owner_expense.reconcile').allowed_triggers, ['admin_reconciliation']);
});

test('high-confidence owner-paid receipt debits expense and credits owner liability after QBO readback', async () => {
  await withOwnerDb(async db => {
    const commands = [];
    const services = {
      fetchSlackReceipt: async () => source(),
      extractOwnerExpense: async () => extraction(),
      runCommand: async command => {
        commands.push(command);
        if (command.args.includes('--verify-only')) {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            status: 'VERIFIED', verified_by_readback: true, qbo_id: 'JE-9001',
            qbo_entity_type: 'JournalEntry', request_id: 'ss-oe-test', amount_usd: 252.69,
            fx_rate: 18.6, expense_account_id: '5100', liability_account_id: '2100',
          }) };
        }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({
          status: 'PUSHED', verified_by_readback: true, qbo_id: 'JE-9001',
          qbo_entity_type: 'JournalEntry', request_id: 'ss-oe-test', amount_usd: 252.69, fx_rate: 18.6,
        }) };
      },
    };
    const ingestRun = await ingest(db, services);
    assert.equal(ingestRun.status, 'completed', ingestRun.error_message);
    assert.equal(ingestRun.output.status, 'queued');
    const processRun = await executeGraph(db, getDefinition('receipt.owner_expense.process'), ingestRun.output.processRunId, services);
    assert.equal(processRun.status, 'completed', processRun.error_message);
    assert.equal(processRun.output.status, 'posted');
    assert.equal(processRun.output.qboId, 'JE-9001');
    assert.equal(commands.length, 2);
    assert.ok(commands[0].args.includes('5100'));
    assert.ok(commands[0].args.includes('2100'));
    assert.ok(commands[0].args.includes('--live'));
    assert.ok(commands[1].args.includes('--verify-only'));
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${ingestRun.output.receiptId}`);
    assert.equal(receipt.status, 'posted');
    assert.equal(receipt.category_name, 'Maintenance');
    assert.equal(receipt.qbo_entity_type, 'JournalEntry');
    assert.equal(receipt.qbo_entity_id, 'JE-9001');
    assert.equal(Number(receipt.amount_usd), 252.69);
    const outboxes = await db.query(sql`SELECT payload_json FROM workflow_outbox ORDER BY created_at, id`);
    assert.equal(outboxes.length, 2);
    const messages = outboxes.map(row => JSON.parse(row.payload_json).message).join('\n');
    assert.match(messages, /Receipt received/);
    assert.match(messages, /Debit: Maintenance/);
    assert.match(messages, /Credit: Due to Test Owner \(Net\)/);
    assert.match(messages, /QBO JournalEntry: JE-9001/);
  });
});

test('contradictory payment provenance requires review and never calls QBO', async () => {
  await withOwnerDb(async db => {
    let commandCalls = 0;
    const services = {
      fetchSlackReceipt: async () => source({ messageText: 'The business paid this expense for the owner: 4,700 MXN' }),
      extractOwnerExpense: async () => extraction({ paid_by_owner: false, review_reason: 'Business paid for owner' }),
      runCommand: async () => { commandCalls += 1; throw new Error('QBO must not be called'); },
    };
    const ingestRun = await ingest(db, services, 'contradiction');
    const processRun = await executeGraph(db, getDefinition('receipt.owner_expense.process'), ingestRun.output.processRunId, services);
    assert.equal(processRun.status, 'completed', processRun.error_message);
    assert.equal(processRun.output.status, 'needs_review');
    assert.equal(commandCalls, 0);
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${ingestRun.output.receiptId}`);
    assert.equal(receipt.status, 'needs_review');
    assert.match(receipt.review_reason, /does not clearly establish that Test Owner paid personally/);
    const rows = await db.query(sql`SELECT payload_json FROM workflow_outbox`);
    const message = rows.map(row => JSON.parse(row.payload_json).message).find(value => value.includes('!receipt confirm'));
    assert.match(message, new RegExp(`!receipt confirm expense ${receipt.id}`));
    assert.match(message, /nothing was posted to QuickBooks/i);
  });
});

test('explicit receipt confirmation updates the same receipt and queues one posting run', async () => {
  await withOwnerDb(async db => {
    const initialServices = {
      fetchSlackReceipt: async () => source(),
      extractOwnerExpense: async () => extraction({ category_key: null, confidence: 0.7, review_reason: 'Category unclear' }),
      runCommand: async () => { throw new Error('must not post before confirmation'); },
    };
    const ingestRun = await ingest(db, initialServices, 'confirm');
    await executeGraph(db, getDefinition('receipt.owner_expense.process'), ingestRun.output.processRunId, initialServices);
    const confirmRun = await startGraph(db, getDefinition('receipt.owner_expense.confirm'), {
      idempotencyKey: 'slack:confirm:1', triggerType: 'slack_receipt_confirm_command', triggerRef: '1786500001.100',
      channelId: CHANNEL, actorUserId: 'U-JASON',
      input: {
        transactionKind: 'owner_paid_expense',
        receiptId: ingestRun.output.receiptId, transactionDate: '2026-08-06', currency: 'MXN', amount: 4700,
        categoryKey: 'maintenance', vendor: 'AC Ignacio Rubio', description: 'Compressor work',
      },
    });
    assert.equal(confirmRun.status, 'completed', confirmRun.error_message);
    assert.equal(confirmRun.output.status, 'queued');
    const commands = [];
    const postingServices = {
      runCommand: async command => {
        commands.push(command);
        const status = command.args.includes('--verify-only') ? 'VERIFIED' : 'PUSHED';
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({
          status, verified_by_readback: true, qbo_id: 'JE-9002', qbo_entity_type: 'JournalEntry',
          request_id: 'ss-oe-confirm', amount_usd: 252.69, fx_rate: 18.6,
        }) };
      },
    };
    const posted = await executeGraph(db, getDefinition('receipt.owner_expense.process'), confirmRun.output.processRunId, postingServices);
    assert.equal(posted.output.status, 'posted');
    assert.equal(commands.length, 2);
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${ingestRun.output.receiptId}`);
    assert.equal(receipt.status, 'posted');
    assert.equal(receipt.qbo_entity_id, 'JE-9002');
  });
});

test('admin reconciliation adopts one verified existing QBO journal without creating another', async () => {
  await withOwnerDb(async db => {
    const initialServices = {
      fetchSlackReceipt: async () => source(),
      extractOwnerExpense: async () => extraction({
        category_key: null, confidence: 0.7, review_reason: 'Category unclear',
      }),
      runCommand: async () => { throw new Error('must not post before reconciliation'); },
    };
    const ingestRun = await ingest(db, initialServices, 'reconcile-existing');
    await executeGraph(db, getDefinition('receipt.owner_expense.process'), ingestRun.output.processRunId, initialServices);
    const commands = [];
    const reconcileRun = await startGraph(db, getDefinition('receipt.owner_expense.reconcile'), {
      idempotencyKey: 'admin:receipt:reconcile-existing:JE-2472',
      triggerType: 'admin_reconciliation', triggerRef: 'qbo:JE-2472',
      channelId: CHANNEL, actorUserId: null,
      input: {
        receiptId: ingestRun.output.receiptId,
        qboId: 'JE-2472', transactionKind: 'owner_paid_expense',
        transactionDate: '2026-08-06', currency: 'MXN', amount: 4400,
        amountUsd: 255.37, fxRate: 17.23, categoryKey: 'maintenance',
        vendor: 'Fidencio Lopez', description: 'Maintenance labor - 4 days',
        sourceReference: '0670449961',
      },
    }, {
      runCommand: async command => {
        commands.push(command);
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({
          status: 'VERIFIED', verified_by_readback: true,
          qbo_id: 'JE-2472', qbo_entity_type: 'JournalEntry', amount_usd: 255.37,
          fx_rate: 17.23, expense_account_id: '5100', liability_account_id: '2100',
          receipt_marker_verified: false, source_reference_verified: true,
        }) };
      },
    });
    assert.equal(reconcileRun.status, 'completed', reconcileRun.error_message);
    assert.equal(reconcileRun.output.status, 'posted');
    assert.equal(reconcileRun.output.reconciledExisting, true);
    assert.equal(commands.length, 1);
    assert.ok(commands[0].args.includes('--verify-only'));
    assert.ok(commands[0].args.includes('--reconcile-existing'));
    assert.ok(commands[0].args.includes('--expected-source-reference'));
    assert.equal(commands[0].args.includes('--live'), false);

    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${ingestRun.output.receiptId}`);
    assert.equal(receipt.status, 'posted');
    assert.equal(receipt.qbo_entity_type, 'JournalEntry');
    assert.equal(receipt.qbo_entity_id, 'JE-2472');
    assert.equal(receipt.category_key, 'maintenance');
    assert.equal(receipt.category_name, 'Maintenance');
    assert.equal(receipt.amount_usd, 255.37);
    assert.equal(receipt.fx_rate, 17.23);
    assert.equal(receipt.workflow_run_id, reconcileRun.id);
    const reconciliation = JSON.parse(receipt.extraction_json).reconciliation;
    assert.equal(reconciliation.qboId, 'JE-2472');
    assert.equal(reconciliation.sourceReference, '0670449961');

    const [effect] = await db.query(sql`SELECT * FROM workflow_effects WHERE run_id=${reconcileRun.id}`);
    assert.equal(effect.status, 'verified_by_readback');
    assert.equal(effect.provider_ref, 'JE-2472');
    assert.match(effect.operation, /reconcile_existing_journal_entry/);
    const [evidence] = await db.query(sql`SELECT * FROM workflow_evidence WHERE run_id=${reconcileRun.id}`);
    assert.match(evidence.source, /reconciliation_readback/);
    assert.equal(evidence.source_ref, 'JE-2472');
    const [outbox] = await db.query(sql`SELECT payload_json FROM workflow_outbox WHERE run_id=${reconcileRun.id}`);
    assert.match(JSON.parse(outbox.payload_json).message, /no new QBO transaction was created/);
  });
});

test('owner repayment requires confirmation then debits liability and credits the configured bank', async () => {
  await withOwnerDb(async db => {
    const reviewServices = {
      fetchSlackReceipt: async () => source({
        messageText: 'The business paid 4,700 MXN to Mr. Rubio for the owner; apply it against the owner liability.',
      }),
      extractOwnerExpense: async () => extraction({
        transaction_kind: 'owner_repayment', category_key: null,
        paid_by_owner: false, is_business_expense: null,
        review_reason: 'Business paid a third party on the owner’s behalf.',
      }),
      runCommand: async () => { throw new Error('repayment must not post before confirmation'); },
    };
    const ingestRun = await ingest(db, reviewServices, 'repayment');
    const reviewed = await executeGraph(
      db, getDefinition('receipt.owner_expense.process'), ingestRun.output.processRunId, reviewServices,
    );
    assert.equal(reviewed.output.status, 'needs_review');
    const [candidate] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${ingestRun.output.receiptId}`);
    assert.equal(candidate.transaction_kind, 'owner_repayment');
    assert.equal(candidate.category_key, null);
    const messages = (await db.query(sql`SELECT payload_json FROM workflow_outbox`))
      .map(row => JSON.parse(row.payload_json).message).join('\n');
    assert.match(messages, new RegExp(`!receipt confirm repayment ${candidate.id}`));

    const confirmRun = await startGraph(db, getDefinition('receipt.owner_expense.confirm'), {
      idempotencyKey: 'slack:confirm:repayment', triggerType: 'slack_receipt_confirm_command',
      triggerRef: '1786500002.100', channelId: CHANNEL, actorUserId: 'U-JASON',
      input: {
        transactionKind: 'owner_repayment', receiptId: candidate.id,
        transactionDate: '2026-08-06', currency: 'MXN', amount: 4700,
        categoryKey: null, vendor: 'AC Ignacio Rubio',
        description: 'Indirect repayment for compressor work on the owner’s behalf',
      },
    });
    assert.equal(confirmRun.output.status, 'queued');
    const commands = [];
    const postingServices = {
      runCommand: async command => {
        commands.push(command);
        const status = command.args.includes('--verify-only') ? 'VERIFIED' : 'PUSHED';
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({
          status, verified_by_readback: true, qbo_id: 'PUR-9003', qbo_entity_type: 'Purchase',
          request_id: 'ss-or-confirm', amount_usd: 272.78, fx_rate: 17.23,
        }) };
      },
    };
    const posted = await executeGraph(
      db, getDefinition('receipt.owner_expense.process'), confirmRun.output.processRunId, postingServices,
    );
    assert.equal(posted.output.status, 'posted');
    assert.equal(posted.output.qboEntityType, 'Purchase');
    assert.ok(commands[0].args.includes('--transaction-kind'));
    assert.ok(commands[0].args.includes('owner_repayment'));
    assert.ok(commands[0].args.includes('--bank-account-id'));
    assert.ok(commands[0].args.includes('1100'));
    assert.equal(commands[0].args.includes('--expense-account-id'), false);
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${candidate.id}`);
    assert.equal(receipt.qbo_entity_type, 'Purchase');
    assert.equal(receipt.qbo_entity_id, 'PUR-9003');
    const finalMessages = (await db.query(sql`SELECT payload_json FROM workflow_outbox`))
      .map(row => JSON.parse(row.payload_json).message).join('\n');
    assert.match(finalMessages, /Debit: Due to Test Owner \(Net\) · Credit: Operating Bank/);
  });
});

test('owner ingest safely refreshes an unposted legacy receipt stub from exact Slack readback', async () => {
  await withOwnerDb(async db => {
    const legacyId = '0d0522a0-9833-4d6f-8a8c-84fd0b49dc5a';
    await db.query(sql`INSERT INTO accounting_receipts (
      id, slack_channel_id, slack_message_id, submitted_by, submitted_at,
      message_text, file_refs_json, source_hash, status
    ) VALUES (
      ${legacyId}, ${CHANNEL}, '1786500000.123', ${ACTOR}, '2026-08-06T12:00:00.000Z',
      'legacy event text', '[]', 'legacy-hash', 'received'
    )`);
    const services = {
      fetchSlackReceipt: async () => source({
        messageText: 'Business paid 4,700 MXN for the owner; reduce the owner liability.',
        files: [{ id: 'F1', name: 'payment.pdf', mimetype: 'application/pdf', size: 10,
          sha256: 'a'.repeat(64), localPath: '/runtime/payment.pdf' }],
      }),
    };
    const run = await ingest(db, services, 'legacy-refresh');
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.receiptId, legacyId);
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${legacyId}`);
    assert.notEqual(receipt.source_hash, 'legacy-hash');
    assert.match(receipt.message_text, /reduce the owner liability/);
    assert.equal(JSON.parse(receipt.file_refs_json)[0].sha256, 'a'.repeat(64));
  });
});

test('Responses extraction sends PDFs as file inputs with a strict accounting schema', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-extraction-'));
  const receiptPath = path.join(directory, 'receipt.pdf');
  fs.writeFileSync(receiptPath, Buffer.from('%PDF-1.4\ntest'));
  let request;
  try {
    const result = await extractOwnerExpense({
      messageText: 'The owner paid this invoice',
      files: [{ name: 'receipt.pdf', mimetype: 'application/pdf', localPath: receiptPath }],
      profile: { owner_name: 'Test Owner', liability_account: { name: 'Due to Test Owner' } },
    }, {
      apiKey: 'test-key',
      accounts: [{ key: 'maintenance', id: '10', name: 'Maintenance' }],
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return {
          ok: true, status: 200,
          json: async () => ({
            id: 'resp_1', model: 'gpt-4.1', output: [{ content: [{ type: 'output_text', text: JSON.stringify(extraction().extracted) }] }],
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(request.store, false);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.equal(request.input[0].content[1].type, 'input_file');
    assert.match(request.input[0].content[1].file_data, /^data:application\/pdf;base64,/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Slack receipt source refetches exact message and downloads private files without persisting URLs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-slack-source-'));
  const calls = [];
  try {
    const result = await fetchSlackReceiptSource({ channelId: CHANNEL, messageId: '1786500000.123' }, {
      credential: { accountId: 'test', token: 'xoxb-secret' },
      receiptFilesDir: directory,
      fetchImpl: async url => {
        calls.push(String(url));
        if (String(url).startsWith('https://slack.com/api/')) {
          return { ok: true, json: async () => ({
            ok: true,
            messages: [{
              ts: '1786500000.123', text: '', files: [{
                id: 'F1', name: 'invoice.pdf', mimetype: 'application/pdf', size: 4,
                url_private_download: 'https://files.slack.com/private/F1',
              }],
            }],
          }) };
        }
        return { ok: true, arrayBuffer: async () => Buffer.from('test') };
      },
    });
    assert.equal(result.shouldProcess, true);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].size, 4);
    assert.equal(Object.hasOwn(result.files[0], 'url_private_download'), false);
    assert.equal(fs.readFileSync(result.files[0].localPath, 'utf8'), 'test');
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
