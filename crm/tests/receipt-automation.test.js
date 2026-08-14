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
const { getDefinition } = require('../workflows/registry');
const { extractReimbursementReceipt } = require('../lib/receipt-extraction');

const CHANNEL = 'C123RECEIPT';
const ACTOR = 'U123SERGIO';

async function withReceiptDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-automation-'));
  const db = createDB(path.join(directory, 'crm.db'));
  const priorAccounting = process.env.ACCOUNTING_CONFIG_PATH;
  const priorPolicy = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const accountingPath = path.join(directory, 'accounting.json');
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(accountingPath, JSON.stringify({
    qbo_accounts: { expenses: {
      maintenance: { id: '5100', name: 'Maintenance' },
      cleaning_services: { id: '5200', name: 'Cleaning Services' },
      contract_labor: { id: '5300', name: 'Contract Labor' },
    } },
    receipt_channels: { [CHANNEL]: { name: '#receipts-temo', scope: 'temo' } },
    receipt_payment: { approver_user_ids: ['U123MAYELA'] },
  }));
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1, shadow_mode: false,
    live_workflows: ['receipt.ingest', 'receipt.process', 'receipt.annotate', 'receipt.reconcile'],
    autonomous_workflows: [], always_on_effects: [],
    channels: { [CHANNEL]: { name: 'receipts-pettycash', capabilities: [
      'receipts.submit', 'receipts.write', 'accounting.read_scoped',
    ] } },
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

function slackSource(messageId, files, messageText = 'Fue una para base para filtro villa2') {
  return {
    channelId: CHANNEL,
    messageId,
    messageText,
    submittedAt: '2026-08-13T21:08:00.000Z',
    shouldProcess: true,
    files: files.map(file => ({
      id: file.id,
      name: file.name || `${file.id}.jpg`,
      mimetype: 'image/jpeg',
      size: 100,
      sha256: String(file.id).padEnd(64, 'a').slice(0, 64),
      localPath: `/runtime/${file.id}.jpg`,
    })),
  };
}

function extractedItem(fileId, overrides = {}) {
  return {
    file_ref_id: fileId,
    document_type: 'receipt',
    vendor: 'Test Vendor',
    transaction_date: '2026-08-12',
    currency: 'MXN',
    amount: 100,
    description: 'Resort maintenance supplies',
    category_key: 'maintenance',
    confidence: 0.98,
    review_reason: null,
    ...overrides,
  };
}

async function runAutomaticReceipt(db, { messageId, files, extraction, onExtract = null }) {
  const ingest = await startGraph(db, getDefinition('receipt.ingest'), {
    idempotencyKey: `slack:${CHANNEL}:${messageId}:receipt.ingest`,
    triggerType: 'slack_receipt_hook',
    triggerRef: messageId,
    channelId: CHANNEL,
    actorUserId: ACTOR,
    input: { slackMessageId: messageId },
  }, { fetchSlackReceipt: async () => slackSource(messageId, files) });
  assert.equal(ingest.status, 'completed', ingest.error_message);
  assert.equal(ingest.output.status, 'queued');

  const process = await executeGraph(db, getDefinition('receipt.process'), ingest.output.processRunId, {
    extractReimbursementReceipt: async request => {
      if (onExtract) onExtract(request);
      return extraction;
    },
  });
  assert.equal(process.status, 'completed', process.error_message);
  assert.equal(process.output.status, 'queued');

  const annotation = await executeGraph(db, getDefinition('receipt.annotate'), process.output.annotationRunId);
  assert.equal(annotation.status, 'completed', annotation.error_message);
  return { ingest, process, annotation };
}

test('a receipt-channel quotation is automatically logged as Sergio reimbursement intent', async () => {
  await withReceiptDb(async db => {
    const messageId = '1786660382.599739';
    const file = { id: 'F0BPPK65YEB', name: 'PHOTO-2026-08-13-14-55-19.jpg' };
    const extraction = {
      ok: true,
      responseId: 'resp_quote_790',
      model: 'gpt-4.1',
      requestHash: 'quote-request-hash',
      extracted: {
        items: [extractedItem(file.id, {
          document_type: 'quotation',
          vendor: 'IRVING FLORES GOMEZ',
          amount: 800,
          description: 'Portacartucho azul 20 Big Blue para filtro de Villa 2',
          review_reason: 'The document title says cotización',
        })],
        confidence: 0.98,
        review_reason: 'The document title says cotización',
      },
    };
    let extractionRequest;
    const { annotation } = await runAutomaticReceipt(db, {
      messageId, files: [file], extraction, onExtract: request => { extractionRequest = request; },
    });
    assert.deepEqual(extractionRequest.context, {
      channelName: '#receipts-temo', channelScope: 'temo', submittedDate: '2026-08-13',
    });
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts
      WHERE slack_channel_id=${CHANNEL} AND slack_message_id=${messageId}`);
    assert.equal(receipt.status, 'extracted');
    assert.equal(receipt.submitted_by, ACTOR);
    assert.equal(receipt.reimbursement_recipient_user_id, ACTOR);
    assert.equal(receipt.vendor, 'IRVING FLORES GOMEZ');
    assert.equal(receipt.transaction_date, '2026-08-12');
    assert.equal(receipt.currency, 'MXN');
    assert.equal(receipt.amount, 800);
    assert.equal(receipt.category_key, 'maintenance');
    assert.match(receipt.payment_reference, /^LPDSR[A-F0-9]{16}$/);
    const extractionRecord = JSON.parse(receipt.extraction_json);
    assert.equal(extractionRecord.channelIntent, 'submitter_reimbursement');
    assert.equal(extractionRecord.extracted.items[0].document_type, 'quotation');
    assert.equal(extractionRecord.annotation.source, 'automatic_receipt_process');
    assert.equal(annotation.output.itemCount, 1);
    const [item] = await db.query(sql`SELECT extraction_confidence FROM accounting_receipt_items
      WHERE receipt_id=${receipt.id}`);
    assert.equal(item.extraction_confidence, 0.98);
    const [outbox] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${annotation.output.outboxId}`);
    const message = JSON.parse(outbox.payload_json).message;
    assert.match(message, /<@U123SERGIO>, please confirm/);
    assert.match(message, /<@U123MAYELA> \*Kapital payment instruction\*/);
    assert.match(message, /MXN \$800\.00 · Maintenance · IRVING FLORES GOMEZ/);
    assert.match(message, new RegExp(receipt.payment_reference));
  });
});

test('one seven-image Slack post creates seven receipt items and one reimbursement total', async () => {
  await withReceiptDb(async db => {
    const messageId = '1786660400.000007';
    const files = Array.from({ length: 7 }, (_, index) => ({ id: `F-SEVEN-${index + 1}` }));
    const amounts = [340, 30, 220, 815, 700, 481, 500];
    const extraction = {
      ok: true,
      responseId: 'resp_seven', model: 'gpt-4.1', requestHash: 'seven-request-hash',
      extracted: {
        items: files.map((file, index) => extractedItem(file.id, {
          amount: amounts[index],
          description: `Receipt ${index + 1}`,
          category_key: index === 6 ? 'cleaning_services' : 'maintenance',
        })),
        confidence: 0.97,
        review_reason: null,
      },
    };
    const { annotation } = await runAutomaticReceipt(db, { messageId, files, extraction });
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE slack_message_id=${messageId}`);
    assert.equal(receipt.amount, 3086);
    assert.equal(receipt.category_key, null);
    assert.equal(annotation.output.itemCount, 7);
    const items = await db.query(sql`SELECT item_index, file_ref_id, amount FROM accounting_receipt_items
      WHERE receipt_id=${receipt.id} ORDER BY item_index`);
    assert.equal(items.length, 7);
    assert.deepEqual(items.map(item => item.file_ref_id), files.map(file => file.id));
    assert.equal(items.reduce((sum, item) => sum + Number(item.amount), 0), 3086);
  });
});

test('structured reimbursement extraction requires one output item per source file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-structured-extraction-'));
  const imagePath = path.join(directory, 'quote.jpg');
  fs.writeFileSync(imagePath, Buffer.from('test-image'));
  let request;
  try {
    const extracted = {
      items: [extractedItem('F-QUOTE', { document_type: 'quotation', amount: 800 })],
      confidence: 0.98,
      review_reason: null,
    };
    const result = await extractReimbursementReceipt({
      messageText: 'base para filtro villa2',
      files: [{ id: 'F-QUOTE', name: 'quote.jpg', mimetype: 'image/jpeg', localPath: imagePath }],
      context: { channelName: '#receipts-temo', channelScope: 'temo', submittedDate: '2026-08-13' },
    }, {
      apiKey: 'test-key',
      accounts: [{ key: 'maintenance', id: '5100', name: 'Maintenance' }],
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'resp_quote', model: 'gpt-4.1',
            output: [{ content: [{ type: 'output_text', text: JSON.stringify(extracted) }] }],
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(request.text.format.schema.properties.items.minItems, 1);
    assert.equal(request.text.format.schema.properties.items.maxItems, 1);
    assert.match(request.input[0].content[0].text, /quotation or estimate.*reimbursable/i);
    assert.match(request.input[0].content[0].text, /Configured channel scope: temo/);
    assert.match(request.input[0].content[0].text, /13\/08\/26.*2026-08-13/);
    assert.equal(request.input[0].content[1].type, 'input_image');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('quality-control recheck corrects the Temo handwritten amount, vendor, and two-digit date', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-temo-recheck-'));
  const imagePath = path.join(directory, 'temo.jpg');
  fs.writeFileSync(imagePath, Buffer.from('test-image'));
  const responses = [
    {
      items: [extractedItem('F-TEMO', {
        vendor: null,
        transaction_date: '2023-08-13',
        amount: 4000,
        description: 'Weekly labor payment',
        category_key: 'contract_labor',
        confidence: 0.85,
      })],
      confidence: 0.85,
      review_reason: 'Vendor was not visible',
    },
    {
      items: [extractedItem('F-TEMO', {
        vendor: 'Temo',
        transaction_date: '2026-08-13',
        amount: 1000,
        description: 'Weekly labor payment for Temo',
        category_key: 'contract_labor',
        confidence: 0.99,
      })],
      confidence: 0.99,
      review_reason: null,
    },
  ];
  const requests = [];
  try {
    const result = await extractReimbursementReceipt({
      messageText: 'Pago temo por semana',
      files: [{ id: 'F-TEMO', name: 'temo.jpg', mimetype: 'image/jpeg', localPath: imagePath }],
      context: { channelName: '#receipts-temo', channelScope: 'temo', submittedDate: '2026-08-13' },
    }, {
      apiKey: 'test-key',
      accounts: [{ key: 'contract_labor', id: '5300', name: 'Contract Labor' }],
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push(request);
        const extracted = responses[requests.length - 1];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `resp_temo_${requests.length}`,
            model: 'gpt-4.1',
            output: [{ content: [{ type: 'output_text', text: JSON.stringify(extracted) }] }],
          }),
        };
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(result.ok, true);
    assert.equal(result.verificationAttempted, true);
    assert.equal(result.verificationResponseId, 'resp_temo_2');
    assert.deepEqual(result.validationIssues, []);
    assert.equal(result.extracted.items[0].vendor, 'Temo');
    assert.equal(result.extracted.items[0].transaction_date, '2026-08-13');
    assert.equal(result.extracted.items[0].amount, 1000);
    assert.match(requests[1].input[0].content[0].text, /date is implausibly far/);
    assert.match(requests[1].input[0].content[0].text, /Independently reread every original attachment/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a receipt review reply directs annotation without requesting banking details', async () => {
  await withReceiptDb(async db => {
    const messageId = '1786668169.036269';
    const file = { id: 'F-TEMO-REVIEW', name: 'IMG_4859.jpg' };
    const ingest = await startGraph(db, getDefinition('receipt.ingest'), {
      idempotencyKey: `slack:${CHANNEL}:${messageId}:receipt.ingest:review`,
      triggerType: 'slack_receipt_hook',
      triggerRef: messageId,
      channelId: CHANNEL,
      actorUserId: ACTOR,
      input: { slackMessageId: messageId },
    }, { fetchSlackReceipt: async () => slackSource(messageId, [file], 'Pago temo por semana') });
    const extraction = {
      ok: true,
      responseId: 'resp_temo_review',
      model: 'gpt-4.1',
      requestHash: 'temo-review-hash',
      validationIssues: ['item 1 vendor is missing', 'item 1 date is missing or invalid'],
      extracted: {
        items: [extractedItem(file.id, {
          vendor: null,
          transaction_date: null,
          amount: 4000,
          category_key: 'contract_labor',
          confidence: 0.85,
        })],
        confidence: 0.85,
        review_reason: 'Vendor and date were unreadable',
      },
    };
    const process = await executeGraph(db, getDefinition('receipt.process'), ingest.output.processRunId, {
      extractReimbursementReceipt: async () => extraction,
    });
    assert.equal(process.status, 'completed', process.error_message);
    assert.equal(process.output.status, 'needs_review');
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${process.output.outboxId}`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, new RegExp(ingest.output.receiptId));
    assert.match(message, /use receipt\.annotate with that receipt id/);
    assert.match(message, /Do not ask for or include a CLABE/);
    assert.match(message, /never required for receipt annotation or code generation/);
  });
});

test('an already-completed reimbursement is documented without a code or duplicate payment instruction', async () => {
  await withReceiptDb(async db => {
    const messageId = '1786668169.036269';
    const file = { id: 'F-TEMO-1000', name: 'IMG_4859.jpg' };
    const ingest = await startGraph(db, getDefinition('receipt.ingest'), {
      idempotencyKey: `slack:${CHANNEL}:${messageId}:receipt.ingest`,
      triggerType: 'slack_receipt_hook',
      triggerRef: messageId,
      channelId: CHANNEL,
      actorUserId: ACTOR,
      input: { slackMessageId: messageId },
    }, { fetchSlackReceipt: async () => slackSource(messageId, [file], 'Pago temo por semana') });
    assert.equal(ingest.status, 'completed', ingest.error_message);

    const annotation = await startGraph(db, getDefinition('receipt.annotate'), {
      idempotencyKey: `slack:${CHANNEL}:${messageId}:receipt.annotate:already-paid`,
      triggerType: 'slack',
      triggerRef: messageId,
      channelId: CHANNEL,
      actorUserId: 'U123MAYELA',
      input: {
        receiptId: ingest.output.receiptId,
        vendor: 'Temo',
        transactionDate: '2026-08-13',
        currency: 'MXN',
        amount: 1000,
        description: 'Weekly labor payment for Temo',
        categoryKey: 'contract_labor',
        categoryName: 'Contract Labor',
        reimbursementRecipientUserId: ACTOR,
        paymentAlreadyCompleted: true,
        paymentConfirmationReference: '0673602901',
        actualPaymentDescription: 'TEMO PAYMENT',
        items: [{
          fileRefId: file.id,
          vendor: 'Temo',
          transactionDate: '2026-08-13',
          currency: 'MXN',
          amount: 1000,
          description: 'Weekly labor payment for Temo',
          categoryKey: 'contract_labor',
          categoryName: 'Contract Labor',
          extractionConfidence: 1,
        }],
      },
    });
    assert.equal(annotation.status, 'completed', annotation.error_message);
    assert.equal(annotation.output.paymentReference, null);
    assert.equal(annotation.output.instructionStatus, null);
    assert.equal(annotation.output.documentationStatus, 'pending');

    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${ingest.output.receiptId}`);
    assert.equal(receipt.status, 'extracted');
    assert.equal(receipt.amount, 1000);
    assert.equal(receipt.payment_reference, null);
    assert.equal(receipt.payment_instruction_queued_at, null);
    const extractionRecord = JSON.parse(receipt.extraction_json);
    assert.equal(extractionRecord.annotation.payment.status, 'completed_before_workflow_reference');
    assert.equal(extractionRecord.annotation.payment.confirmationReference, '0673602901');
    assert.equal(extractionRecord.annotation.payment.actualPaymentDescription, 'TEMO PAYMENT');

    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${annotation.output.outboxId}`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, /Payment already completed and receipt documented/);
    assert.match(message, /no new transfer is needed/i);
    assert.match(message, /TEMO PAYMENT/);
    assert.match(message, /0673602901/);
    assert.match(message, /No CLABE, bank-account number/);
    assert.doesNotMatch(message, /LPDSR[A-F0-9]{16}/);

    await db.query(sql`INSERT INTO accounting_bank_transactions (
      id, source_key, transaction_date, description, currency, amount,
      classification_tier, source_file_hash
    ) VALUES ('bank-temo-1000', 'bank-temo-1000', '2026-08-13', 'TEMO PAYMENT', 'MXN', 1000,
      'unknown', 'statement-hash')`);
    const reconciliation = await startGraph(db, getDefinition('receipt.reconcile'), {
      idempotencyKey: 'receipt-reconcile-temo-already-paid',
      triggerType: 'system',
      input: {},
    });
    assert.equal(reconciliation.status, 'completed', reconciliation.error_message);
    assert.equal(reconciliation.output.legacyMatched, 1);
    assert.equal(reconciliation.output.referenceMatched, 0);
  });
});
