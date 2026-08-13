'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { getOpenAIKey } = require('./openai-key');
const { expenseAccountChoices } = require('./accounting-config');

const ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4.1';
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function reimbursementExtractionSchema(categoryKeys, fileIds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'confidence', 'review_reason'],
    properties: {
      items: {
        type: 'array',
        minItems: fileIds.length || 1,
        maxItems: fileIds.length || 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'file_ref_id', 'document_type', 'vendor', 'transaction_date', 'currency',
            'amount', 'description', 'category_key', 'confidence', 'review_reason',
          ],
          properties: {
            file_ref_id: fileIds.length
              ? { type: 'string', enum: fileIds }
              : { type: 'null' },
            document_type: {
              type: 'string',
              enum: ['receipt', 'invoice', 'quotation', 'payment_confirmation', 'other'],
            },
            vendor: { type: ['string', 'null'] },
            transaction_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
            currency: { type: ['string', 'null'], enum: ['MXN', 'USD', null] },
            amount: { type: ['number', 'null'] },
            description: { type: ['string', 'null'] },
            category_key: { type: ['string', 'null'], enum: [...categoryKeys, null] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            review_reason: { type: ['string', 'null'] },
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      review_reason: { type: ['string', 'null'] },
    },
  };
}

function extractionSchema(categoryKeys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'document_type', 'vendor', 'transaction_date', 'currency', 'amount',
      'description', 'transaction_kind', 'category_key', 'is_business_expense', 'paid_by_owner',
      'confidence', 'review_reason',
    ],
    properties: {
      document_type: { type: 'string', enum: ['receipt', 'invoice', 'payment_confirmation', 'other'] },
      vendor: { type: ['string', 'null'] },
      transaction_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      currency: { type: ['string', 'null'], enum: ['MXN', 'USD', null] },
      amount: { type: ['number', 'null'] },
      description: { type: ['string', 'null'] },
      transaction_kind: { type: 'string', enum: ['owner_paid_expense', 'owner_repayment', 'unclear'] },
      category_key: { type: ['string', 'null'], enum: [...categoryKeys, null] },
      is_business_expense: { type: ['boolean', 'null'] },
      paid_by_owner: { type: ['boolean', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      review_reason: { type: ['string', 'null'] },
    },
  };
}

function buildInstructions({ ownerName, liabilityAccountName, accounts }) {
  const choices = accounts.map(account => `${account.key}: ${account.name}`).join('\n');
  return [
    'Classify and extract one owner-ledger transaction from the Slack text and attached receipt, invoice, or payment confirmation.',
    `The normal case is owner_paid_expense: ${ownerName} paid a resort business expense personally, which increases what the business owes the owner.`,
    `Use owner_repayment only when the Slack message explicitly says the business paid ${ownerName}, reimbursed ${ownerName}, or paid a third party on ${ownerName}'s personal behalf and the amount should reduce the owner's balance.`,
    'Use unclear whenever payment direction is not explicit. A bank transfer from a business account alone does not prove an owner repayment.',
    'For owner_paid_expense, set paid_by_owner=true, is_business_expense=true, and choose an expense category.',
    'For owner_repayment, set paid_by_owner=false and category_key=null because the debit is the owner liability account, not an expense.',
    'Set is_business_expense=false only for a personal purchase. Use null when that fact is not relevant or cannot be determined.',
    'The amount must be the transaction total in the original currency, never a bank balance or running total.',
    'Use the transaction/receipt date, not the upload date, and use YYYY-MM-DD.',
    `The owner ledger account is ${liabilityAccountName}. For owner_paid_expense choose only the debit expense category below.`,
    'Choose the narrowest supported category. If classification is genuinely ambiguous, use null and explain why.',
    'Do not invent missing fields. Lower confidence when the document is unreadable, fields conflict, or payment provenance is unclear.',
    '',
    'Allowed expense categories:',
    choices,
  ].join('\n');
}

function buildReimbursementInstructions({ accounts, fileIds }) {
  const choices = accounts.map(account => `${account.key}: ${account.name}`).join('\n');
  return [
    'Extract a reimbursement bundle posted in a dedicated resort receipt channel.',
    'Channel membership is conclusive intent: every top-level post is a business transaction paid by the human submitter and must be logged for reimbursement.',
    'A quotation or estimate posted here is also a reimbursable transaction. Extract it normally; do not reject it merely because it says cotización, quote, or estimate.',
    fileIds.length
      ? `Return exactly one item for each attached source file (${fileIds.length} total), using each supplied file_ref_id exactly once.`
      : 'There is no attachment. Return exactly one item extracted from the Slack text with file_ref_id null.',
    'Each item amount is that document’s total in its original currency. Never use a balance, subtotal when a total exists, or unit price when an extended total exists.',
    'Use the document transaction date, not the Slack upload date, and format it YYYY-MM-DD.',
    'Choose the narrowest supported expense category. Quotations for repair parts, plumbing, filters, hardware, or installed equipment are normally maintenance unless the document clearly supports another category.',
    'Do not combine files, omit a file, or invent missing fields. If a document is unreadable, return null for the missing field and explain it in review_reason.',
    'All items in one reimbursement must use the same currency. Report the document faithfully if they differ; the workflow will hold the bundle for review.',
    '',
    'Allowed expense categories:',
    choices,
  ].join('\n');
}

function fileContentBlock(file) {
  const buffer = fs.readFileSync(file.localPath);
  const mimetype = String(file.mimetype || 'application/octet-stream').toLowerCase();
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
  if (mimetype.startsWith('image/')) {
    return { bytes: buffer.length, block: { type: 'input_image', image_url: dataUrl, detail: 'high' } };
  }
  return {
    bytes: buffer.length,
    block: {
      type: 'input_file',
      filename: String(file.name || 'receipt.pdf').slice(0, 240),
      file_data: dataUrl,
    },
  };
}

function responseText(payload) {
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return null;
}

function validateExtraction(value, categoryKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt extraction was not an object');
  if (!['receipt', 'invoice', 'payment_confirmation', 'other'].includes(value.document_type)) {
    throw new Error('receipt extraction returned an invalid document type');
  }
  if (!['owner_paid_expense', 'owner_repayment', 'unclear'].includes(value.transaction_kind)) {
    throw new Error('receipt extraction returned an invalid transaction kind');
  }
  if (value.transaction_kind === 'owner_repayment' && value.category_key !== null) {
    throw new Error('owner repayment extraction must not select an expense category');
  }
  if (value.category_key !== null && !categoryKeys.includes(value.category_key)) {
    throw new Error('receipt extraction returned an unknown expense category');
  }
  if (value.transaction_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value.transaction_date)) {
    throw new Error('receipt extraction returned an invalid date');
  }
  if (value.currency !== null && !['MXN', 'USD'].includes(value.currency)) {
    throw new Error('receipt extraction returned an invalid currency');
  }
  if (value.amount !== null && (!Number.isFinite(value.amount) || value.amount <= 0)) {
    throw new Error('receipt extraction returned an invalid amount');
  }
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error('receipt extraction returned invalid confidence');
  }
  return value;
}

function validateReimbursementExtraction(value, categoryKeys, fileIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('reimbursement extraction was not an object');
  }
  if (!Array.isArray(value.items) || value.items.length !== (fileIds.length || 1)) {
    throw new Error('reimbursement extraction did not return one item per source document');
  }
  const seen = new Set();
  for (const item of value.items) {
    if (!['receipt', 'invoice', 'quotation', 'payment_confirmation', 'other'].includes(item.document_type)) {
      throw new Error('reimbursement extraction returned an invalid document type');
    }
    if (fileIds.length) {
      if (!fileIds.includes(item.file_ref_id) || seen.has(item.file_ref_id)) {
        throw new Error('reimbursement extraction did not bind each source file exactly once');
      }
      seen.add(item.file_ref_id);
    } else if (item.file_ref_id !== null) {
      throw new Error('text-only reimbursement extraction returned a file reference');
    }
    if (item.transaction_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(item.transaction_date)) {
      throw new Error('reimbursement extraction returned an invalid date');
    }
    if (item.currency !== null && !['MXN', 'USD'].includes(item.currency)) {
      throw new Error('reimbursement extraction returned an invalid currency');
    }
    if (item.amount !== null && (!Number.isFinite(item.amount) || item.amount <= 0)) {
      throw new Error('reimbursement extraction returned an invalid amount');
    }
    if (item.category_key !== null && !categoryKeys.includes(item.category_key)) {
      throw new Error('reimbursement extraction returned an unknown expense category');
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error('reimbursement extraction returned invalid item confidence');
    }
  }
  if (fileIds.length && seen.size !== fileIds.length) {
    throw new Error('reimbursement extraction omitted a source file');
  }
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error('reimbursement extraction returned invalid confidence');
  }
  return value;
}

async function requestStructuredExtraction({ content, schema, schemaName, maxOutputTokens }, options = {}) {
  const model = process.env.RECEIPT_EXTRACTION_MODEL || DEFAULT_MODEL;
  const request = {
    model,
    store: false,
    max_output_tokens: maxOutputTokens,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
  };
  const apiKey = options.apiKey || getOpenAIKey();
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    return { ok: false, confidence: 0, reviewReason: `OpenAI extraction request failed: ${error.message}` };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === 'failed' || payload.status === 'incomplete') {
    const detail = payload.error?.message || payload.incomplete_details?.reason || `HTTP ${response.status}`;
    return { ok: false, confidence: 0, reviewReason: `OpenAI extraction unavailable: ${String(detail).slice(0, 240)}` };
  }
  return { payload, model, request };
}

async function extractReimbursementReceipt({ messageText, files }, options = {}) {
  const accounts = options.accounts || expenseAccountChoices();
  const categoryKeys = accounts.map(account => account.key);
  const selectedFiles = (Array.isArray(files) ? files : []).slice(0, MAX_FILES);
  if (Array.isArray(files) && files.length > MAX_FILES) {
    return { ok: false, confidence: 0, reviewReason: `receipt bundle exceeds ${MAX_FILES} files` };
  }
  const fileIds = selectedFiles.map(file => String(file.id || '')).filter(Boolean);
  if (fileIds.length !== selectedFiles.length || new Set(fileIds).size !== fileIds.length) {
    return { ok: false, confidence: 0, reviewReason: 'receipt source files do not have unique Slack file ids' };
  }
  const schema = reimbursementExtractionSchema(categoryKeys, fileIds);
  const content = [{
    type: 'input_text',
    text: [
      buildReimbursementInstructions({ accounts, fileIds }),
      '',
      'Slack message:',
      String(messageText || '').slice(0, 12_000) || '(no accompanying text)',
      '',
      `Source file ids in attachment order: ${fileIds.join(', ') || '(none)'}`,
    ].join('\n'),
  }];
  let totalBytes = 0;
  for (const file of selectedFiles) {
    const item = fileContentBlock(file);
    totalBytes += item.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, confidence: 0, reviewReason: `receipt attachments exceed ${MAX_TOTAL_BYTES} bytes` };
    }
    content.push(item.block);
  }
  const response = await requestStructuredExtraction({
    content,
    schema,
    schemaName: 'reimbursement_receipt_bundle',
    maxOutputTokens: Math.min(6000, 800 + (selectedFiles.length || 1) * 500),
  }, options);
  if (!response.payload) return response;
  try {
    const raw = responseText(response.payload);
    if (!raw) throw new Error('no structured output text');
    const extracted = validateReimbursementExtraction(JSON.parse(raw), categoryKeys, fileIds);
    return {
      ok: true,
      extracted,
      confidence: extracted.confidence,
      responseId: response.payload.id || null,
      model: response.payload.model || response.model,
      usage: response.payload.usage || null,
      requestHash: crypto.createHash('sha256')
        .update(JSON.stringify({ model: response.model, schema }))
        .digest('hex'),
    };
  } catch (error) {
    return {
      ok: false,
      confidence: 0,
      responseId: response.payload.id || null,
      reviewReason: `OpenAI extraction parse failed: ${error.message}`,
    };
  }
}

async function extractOwnerExpense({ messageText, files, profile }, options = {}) {
  const accounts = options.accounts || expenseAccountChoices();
  const categoryKeys = accounts.map(account => account.key);
  const selectedFiles = (Array.isArray(files) ? files : []).slice(0, MAX_FILES);
  const content = [{
    type: 'input_text',
    text: [
      buildInstructions({
        ownerName: profile.owner_name,
        liabilityAccountName: profile.liability_account.name,
        accounts,
      }),
      '',
      'Slack message:',
      String(messageText || '').slice(0, 12_000) || '(no accompanying text)',
    ].join('\n'),
  }];
  let totalBytes = 0;
  for (const file of selectedFiles) {
    const item = fileContentBlock(file);
    totalBytes += item.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`receipt attachments exceed ${MAX_TOTAL_BYTES} bytes`);
    content.push(item.block);
  }

  const model = process.env.RECEIPT_EXTRACTION_MODEL || DEFAULT_MODEL;
  const request = {
    model,
    store: false,
    max_output_tokens: 1200,
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: 'owner_expense_receipt',
        strict: true,
        schema: extractionSchema(categoryKeys),
      },
    },
  };
  const apiKey = options.apiKey || getOpenAIKey();
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    return { ok: false, confidence: 0, reviewReason: `OpenAI extraction request failed: ${error.message}` };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === 'failed' || payload.status === 'incomplete') {
    const detail = payload.error?.message || payload.incomplete_details?.reason || `HTTP ${response.status}`;
    return { ok: false, confidence: 0, reviewReason: `OpenAI extraction unavailable: ${String(detail).slice(0, 240)}` };
  }
  try {
    const raw = responseText(payload);
    if (!raw) throw new Error('no structured output text');
    const extracted = validateExtraction(JSON.parse(raw), categoryKeys);
    return {
      ok: true,
      extracted,
      confidence: extracted.confidence,
      responseId: payload.id || null,
      model: payload.model || model,
      usage: payload.usage || null,
      requestHash: crypto.createHash('sha256').update(JSON.stringify({ model, schema: request.text.format.schema })).digest('hex'),
    };
  } catch (error) {
    return { ok: false, confidence: 0, responseId: payload.id || null, reviewReason: `OpenAI extraction parse failed: ${error.message}` };
  }
}

module.exports = {
  DEFAULT_MODEL,
  ENDPOINT,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  buildInstructions,
  buildReimbursementInstructions,
  extractOwnerExpense,
  extractReimbursementReceipt,
  extractionSchema,
  reimbursementExtractionSchema,
  fileContentBlock,
  responseText,
  validateExtraction,
  validateReimbursementExtraction,
};
