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
      supplies: { id: '5400', name: 'Supplies' },
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
    assert.match(message, /Reembolso clasificado y listo para validación/);
    assert.match(message, /<@U123MAYELA> por favor confirma que el gasto y la clasificación son válidos/);
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
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${annotation.output.outboxId}`);
    const message = JSON.parse(notification.payload_json).message;
    assert.equal((message.match(/LPDSR[A-F0-9]{16}/g) || []).length, 1);
    assert.doesNotMatch(message, /separate top-level|mensaje nuevo para cada/i);
  });
});

test('one two-receipt post is classified as one bundle even when the service voucher has no vendor field', async () => {
  await withReceiptDb(async db => {
    const messageId = '1786671381.027229';
    const files = [
      { id: 'F-MI-POLLO', name: 'IMG-20260813-WA0043.jpg' },
      { id: 'F-SUSY-VOUCHER', name: 'IMG-20260813-WA0044.jpg' },
    ];
    const extraction = {
      ok: true,
      responseId: 'resp_susy_bundle',
      model: 'gpt-4.1',
      requestHash: 'susy-bundle-hash',
      validationIssues: ['item 2 vendor is missing'],
      extracted: {
        items: [
          extractedItem(files[0].id, {
            vendor: 'Miscelanea Mi Pollo',
            transaction_date: '2026-08-12',
            amount: 87.09,
            description: 'Cleaning and household supplies including bathroom sandpaper',
            category_key: 'supplies',
          }),
          extractedItem(files[1].id, {
            vendor: null,
            transaction_date: '2026-08-14',
            amount: 1000,
            description: 'Pago de limpieza por dos días para Susy',
            category_key: 'cleaning_services',
          }),
        ],
        confidence: 0.96,
        review_reason: null,
      },
    };
    const { annotation } = await runAutomaticReceipt(db, { messageId, files, extraction });
    const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE slack_message_id=${messageId}`);
    assert.equal(receipt.status, 'extracted');
    assert.equal(receipt.amount, 1087.09);
    assert.equal(receipt.payment_reference?.startsWith('LPDSR'), true);
    const items = await db.query(sql`SELECT item_index, vendor, amount, category_key
      FROM accounting_receipt_items WHERE receipt_id=${receipt.id} ORDER BY item_index`);
    assert.deepEqual(items, [
      { item_index: 1, vendor: 'Miscelanea Mi Pollo', amount: 87.09, category_key: 'supplies' },
      { item_index: 2, vendor: null, amount: 1000, category_key: 'cleaning_services' },
    ]);
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${annotation.output.outboxId}`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, /1\. MXN \$87\.09 · Supplies · Miscelanea Mi Pollo/);
    assert.match(message, /2\. MXN \$1,000\.00 · Cleaning Services/);
    assert.match(message, /\*Total: MXN \$1,087\.09\*/);
    assert.match(message, /por favor confirma que el gasto y la clasificación son válidos/);
    assert.doesNotMatch(message, /top-level|vuelve a publicar|separa/i);
  });
});

test('a top-level payment confirmation is held as proof instead of becoming another payable receipt', async () => {
  await withReceiptDb(async db => {
    const messageId = '1786672535.030389';
    const file = { id: 'F-SUSY-PAYMENT', name: 'comprobante SPEI 0673606335.pdf' };
    const ingest = await startGraph(db, getDefinition('receipt.ingest'), {
      idempotencyKey: `slack:${CHANNEL}:${messageId}:receipt.ingest:proof`,
      triggerType: 'slack_receipt_hook', triggerRef: messageId, channelId: CHANNEL,
      actorUserId: 'U123MAYELA', input: { slackMessageId: messageId },
    }, { fetchSlackReceipt: async () => slackSource(messageId, [file], '') });
    const extraction = {
      ok: true, responseId: 'resp_susy_payment', model: 'gpt-4.1', requestHash: 'susy-payment-hash',
      extracted: {
        items: [extractedItem(file.id, {
          document_type: 'payment_confirmation', vendor: 'SUSY', transaction_date: '2026-08-13',
          amount: 1088, description: 'WEEKLY PAYMENT COMMON AREAS', category_key: 'cleaning_services',
        })],
        confidence: 0.98, review_reason: null,
      },
    };
    const process = await executeGraph(db, getDefinition('receipt.process'), ingest.output.processRunId, {
      extractReimbursementReceipt: async () => extraction,
    });
    assert.equal(process.status, 'completed', process.error_message);
    assert.equal(process.output.status, 'needs_review');
    const [receipt] = await db.query(sql`SELECT status, payment_reference, review_reason
      FROM accounting_receipts WHERE id=${ingest.output.receiptId}`);
    assert.equal(receipt.status, 'needs_review');
    assert.equal(receipt.payment_reference, null);
    assert.match(receipt.review_reason, /payment proof must be linked to the original reimbursement/);
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${process.output.outboxId}`);
    const message = JSON.parse(notification.payload_json).message;
    assert.match(message, /el comprobante de pago debe vincularse al reembolso original/);
    assert.doesNotMatch(message, /payment proof must be linked/);
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
    assert.match(message, /usa receipt\.annotate con ese identificador/);
    assert.match(message, /concepto 1: falta la fecha o no es válida/);
    assert.doesNotMatch(message, /date is missing or invalid/);
    assert.match(message, /No vuelvas a publicar ni separes los comprobantes/);
    assert.match(message, /No pidas ni incluyas CLABE/);
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
    assert.match(message, /Pago realizado y comprobantes documentados/);
    assert.match(message, /no es necesario hacer otra transferencia/i);
    assert.match(message, /TEMO PAYMENT/);
    assert.match(message, /0673602901/);
    assert.match(message, /no necesita ni guarda CLABE/i);
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

test('an MXN 1088 payment closes the MXN 1087.09 bundle and its mistakenly ingested proof', async () => {
  await withReceiptDb(async db => {
    const originalMessageId = '1786671381.027229';
    const originalFiles = [
      { id: 'F-MI-POLLO-PAID', name: 'IMG-20260813-WA0043.jpg' },
      { id: 'F-SUSY-PAID', name: 'IMG-20260813-WA0044.jpg' },
    ];
    const original = await startGraph(db, getDefinition('receipt.ingest'), {
      idempotencyKey: `slack:${CHANNEL}:${originalMessageId}:receipt.ingest:paid-bundle`,
      triggerType: 'slack_receipt_hook', triggerRef: originalMessageId, channelId: CHANNEL,
      actorUserId: 'U123MAYELA', input: { slackMessageId: originalMessageId },
    }, { fetchSlackReceipt: async () => slackSource(originalMessageId, originalFiles, 'Susy weekly payment and reimbursement') });
    const paid = await startGraph(db, getDefinition('receipt.annotate'), {
      idempotencyKey: `slack:${CHANNEL}:${originalMessageId}:receipt.annotate:paid-bundle`,
      triggerType: 'slack', triggerRef: originalMessageId, channelId: CHANNEL,
      actorUserId: 'U123MAYELA',
      input: {
        receiptId: original.output.receiptId,
        vendor: 'Multiple vendors', transactionDate: '2026-08-14', currency: 'MXN', amount: 1087.09,
        description: 'Susy cleaning payment and household supplies reimbursement',
        reimbursementRecipientUserId: 'U123MAYELA',
        paymentAlreadyCompleted: true,
        paymentConfirmationReference: '0673606335',
        actualPaymentDescription: 'WEEKLY PAYMENT COMMON AREAS',
        actualPaymentAmount: 1088,
        items: [
          {
            fileRefId: originalFiles[0].id, vendor: 'Miscelanea Mi Pollo',
            transactionDate: '2026-08-12', currency: 'MXN', amount: 87.09,
            description: 'Cleaning and household supplies including bathroom sandpaper',
            categoryKey: 'supplies', categoryName: 'Supplies', extractionConfidence: 1,
          },
          {
            fileRefId: originalFiles[1].id, vendor: 'Susy',
            transactionDate: '2026-08-14', currency: 'MXN', amount: 1000,
            description: 'Pago de limpieza por dos días',
            categoryKey: 'cleaning_services', categoryName: 'Cleaning Services', extractionConfidence: 1,
          },
        ],
      },
    });
    assert.equal(paid.status, 'completed', paid.error_message);
    assert.equal(paid.output.paymentReference, null);
    const [paidNotice] = await db.query(sql`SELECT payload_json FROM workflow_outbox WHERE id=${paid.output.outboxId}`);
    const paidMessage = JSON.parse(paidNotice.payload_json).message;
    assert.match(paidMessage, /Total de los comprobantes: MXN \$1,087\.09/);
    assert.match(paidMessage, /Transferencia realizada: MXN \$1,088\.00/);
    assert.match(paidMessage, /0673606335/);

    const proofMessageId = '1786672535.030389';
    const proofFile = { id: 'F-SUSY-PROOF-DUPLICATE', name: 'comprobante SPEI 0673606335.pdf' };
    const proof = await startGraph(db, getDefinition('receipt.ingest'), {
      idempotencyKey: `slack:${CHANNEL}:${proofMessageId}:receipt.ingest:legacy-duplicate`,
      triggerType: 'slack_receipt_hook', triggerRef: proofMessageId, channelId: CHANNEL,
      actorUserId: 'U123MAYELA', input: { slackMessageId: proofMessageId },
    }, { fetchSlackReceipt: async () => slackSource(proofMessageId, [proofFile], '') });
    const mistaken = await startGraph(db, getDefinition('receipt.annotate'), {
      idempotencyKey: `slack:${CHANNEL}:${proofMessageId}:receipt.annotate:mistaken`,
      triggerType: 'slack', triggerRef: proofMessageId, channelId: CHANNEL,
      actorUserId: 'U123MAYELA',
      input: {
        receiptId: proof.output.receiptId, vendor: 'SUSY', transactionDate: '2026-08-13',
        currency: 'MXN', amount: 1088, description: 'WEEKLY PAYMENT COMMON AREAS',
        categoryKey: 'cleaning_services', categoryName: 'Cleaning Services',
      },
    });
    assert.equal(mistaken.status, 'completed', mistaken.error_message);
    assert.match(mistaken.output.paymentReference, /^LPDSR/);

    const resolved = await startGraph(db, getDefinition('receipt.annotate'), {
      idempotencyKey: `slack:${CHANNEL}:${proofMessageId}:receipt.annotate:duplicate`,
      triggerType: 'slack', triggerRef: proofMessageId, channelId: CHANNEL,
      actorUserId: 'U123MAYELA',
      input: {
        receiptId: proof.output.receiptId, amount: 1088, currency: 'MXN',
        duplicateOfReceiptId: original.output.receiptId,
      },
    });
    assert.equal(resolved.status, 'completed', resolved.error_message);
    assert.equal(resolved.output.duplicateResolved, true);
    assert.equal(resolved.output.canonicalReceiptId, original.output.receiptId);
    assert.equal(resolved.output.paymentReference, null);
    const [duplicate] = await db.query(sql`SELECT status, review_reason, payment_reference,
      payment_instruction_queued_at FROM accounting_receipts WHERE id=${proof.output.receiptId}`);
    assert.deepEqual(duplicate, {
      status: 'ignored', review_reason: `duplicate_of:${original.output.receiptId}`,
      payment_reference: null, payment_instruction_queued_at: null,
    });
    const [duplicateNotice] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE id=${resolved.output.outboxId}`);
    const duplicateMessage = JSON.parse(duplicateNotice.payload_json).message;
    assert.match(duplicateMessage, /no es una nueva solicitud de reembolso/);
    assert.match(duplicateMessage, /No hagas otra transferencia/);

    await db.query(sql`INSERT INTO accounting_bank_transactions (
      id, source_key, transaction_date, description, currency, amount,
      classification_tier, source_file_hash
    ) VALUES ('bank-susy-1088', 'bank-susy-1088', '2026-08-13',
      'WEEKLY PAYMENT COMMON AREAS', 'MXN', 1088, 'unknown', 'statement-hash')`);
    const reconciliation = await startGraph(db, getDefinition('receipt.reconcile'), {
      idempotencyKey: 'receipt-reconcile-susy-rounded-payment', triggerType: 'system', input: {},
    });
    assert.equal(reconciliation.status, 'completed', reconciliation.error_message);
    assert.equal(reconciliation.output.legacyMatched, 1);
    assert.equal(reconciliation.output.referenceMatched, 0);
  });
});
