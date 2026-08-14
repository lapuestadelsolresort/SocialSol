'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { getOpenAIKey } = require('./openai-key');
const { expenseAccountChoices } = require('./accounting-config');

const ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4.1';
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_RECEIPT_DATE_DISTANCE_DAYS = 370;

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
      'description', 'category_key', 'confidence', 'review_reason',
    ],
    properties: {
      document_type: { type: 'string', enum: ['receipt', 'invoice', 'payment_confirmation', 'other'] },
      vendor: { type: ['string', 'null'] },
      transaction_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      currency: { type: ['string', 'null'], enum: ['MXN', 'USD', null] },
      amount: { type: ['number', 'null'] },
      description: { type: ['string', 'null'] },
      category_key: { type: ['string', 'null'], enum: [...categoryKeys, null] },
      confidence: {
        type: 'number', minimum: 0, maximum: 1,
        description: 'Confidence in the extracted document facts and expense category only. Do not include payment-provenance confidence because the channel establishes the payer.',
      },
      review_reason: {
        type: ['string', 'null'],
        description: 'Explain only a missing, conflicting, unreadable, or ambiguous document fact or expense category. Never request proof of who paid.',
      },
    },
  };
}

function buildInstructions({ ownerName, liabilityAccountName, accounts }) {
  const choices = accounts.map(account => `${account.key}: ${account.name}`).join('\n');
  return [
    'Classify and extract one owner-paid resort business expense from the Slack text and attached receipt, invoice, or payment confirmation.',
    `Channel membership is conclusive provenance: every top-level post is a resort business expense paid personally by ${ownerName}.`,
    `Do not re-evaluate who paid based on an empty Slack caption, the bank or app brand shown in an attachment, or a payment-confirmation source-account label. Those details cannot override the channel contract.`,
    `The resulting accounting entry will credit ${liabilityAccountName}, increasing what the business owes ${ownerName}. Your job is only to extract the document facts and choose the expense category.`,
    'The amount must be the transaction total in the original currency, never a bank balance or running total.',
    'Use the transaction/receipt date, not the upload date, and use YYYY-MM-DD.',
    'Choose the narrowest supported category. If classification is genuinely ambiguous, use null and explain why.',
    'Do not invent missing document fields. Lower confidence when the document is unreadable, fields conflict, or the expense category is unclear. Do not lower confidence because payment provenance is absent from the attachment or Slack text; the channel already establishes it.',
    '',
    'Allowed expense categories:',
    choices,
  ].join('\n');
}

function reimbursementContextLines(context = {}) {
  const channelName = String(context.channelName || '').trim().slice(0, 160);
  const channelScope = String(context.channelScope || '').trim().slice(0, 160);
  const submittedDate = String(context.submittedDate || '').trim();
  const lines = [];
  if (channelName) lines.push(`Receipt channel: ${channelName}`);
  if (channelScope) lines.push(`Configured channel scope: ${channelScope}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(submittedDate)) {
    lines.push(`Slack submission date in the resort time zone: ${submittedDate}`);
  }
  if (lines.length) {
    lines.push('Channel name/scope may establish vendor, payee, or purpose when the Slack text is abbreviated. Never derive or alter an amount from channel metadata.');
  }
  return lines;
}

function buildReimbursementInstructions({ accounts, fileIds, context = {} }) {
  const choices = accounts.map(account => `${account.key}: ${account.name}`).join('\n');
  return [
    'Extract a reimbursement bundle posted in a dedicated resort receipt channel.',
    'Channel membership is conclusive intent: every top-level post is a business transaction paid by the human submitter and must be logged for reimbursement.',
    'A quotation or estimate posted here is also a reimbursable transaction. Extract it normally; do not reject it merely because it says cotización, quote, or estimate.',
    fileIds.length
      ? `Return exactly one item for each attached source file (${fileIds.length} total), using each supplied file_ref_id exactly once.`
      : 'There is no attachment. Return exactly one item extracted from the Slack text with file_ref_id null.',
    'Each item amount is that document’s total in its original currency. Never use a balance, subtotal when a total exists, or unit price when an extended total exists.',
    'Read every handwritten and printed amount field. When an amount is repeated, cross-check the repetitions before answering. A handwritten "$1000" means one thousand; never invent a leading digit.',
    'Use the document transaction date, not the Slack upload date, and format it YYYY-MM-DD. Interpret two-digit years relative to the Slack submission date: for example, 13/08/26 on a 2026 post is 2026-08-13, not 2023-08-13.',
    'For a petty-cash voucher, the named worker, service provider, recipient, or person identified in the Slack message is the vendor. A missing store header or blank "recibido por" box does not make the vendor unknown when the worker is identified elsewhere.',
    'Choose the narrowest supported expense category. Quotations for repair parts, plumbing, filters, hardware, or installed equipment are normally maintenance unless the document clearly supports another category.',
    'Do not combine files, omit a file, or invent missing fields. If a document is unreadable, return null for the missing field and explain it in review_reason.',
    'All items in one reimbursement must use the same currency. Report the document faithfully if they differ; the workflow will hold the bundle for review.',
    ...reimbursementContextLines(context),
    '',
    'Allowed expense categories:',
    choices,
  ].join('\n');
}

function validIsoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text;
}

function reimbursementExtractionIssues(extracted, context = {}) {
  const issues = [];
  const items = Array.isArray(extracted?.items) ? extracted.items : [];
  if (!items.length) return ['no reimbursement items were extracted'];
  const submittedDate = validIsoDate(context.submittedDate) ? context.submittedDate : null;
  const currencies = new Set();
  items.forEach((item, offset) => {
    const label = `item ${offset + 1}`;
    if (!String(item.vendor || '').trim()) issues.push(`${label} vendor is missing`);
    if (!validIsoDate(item.transaction_date)) {
      issues.push(`${label} date is missing or invalid`);
    } else if (submittedDate) {
      const distance = Math.abs((new Date(`${item.transaction_date}T00:00:00.000Z`)
        - new Date(`${submittedDate}T00:00:00.000Z`)) / 86_400_000);
      if (distance > MAX_RECEIPT_DATE_DISTANCE_DAYS) {
        issues.push(`${label} date is implausibly far from the Slack submission date`);
      }
    }
    if (!['MXN', 'USD'].includes(item.currency)) issues.push(`${label} currency is missing`);
    else currencies.add(item.currency);
    if (!Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) issues.push(`${label} amount is missing`);
    if (!String(item.description || '').trim()) issues.push(`${label} description is missing`);
    if (!String(item.category_key || '').trim()) issues.push(`${label} expense category is missing`);
    if (Number(item.confidence) < 0.8) {
      issues.push(`${label} confidence ${Number(item.confidence || 0).toFixed(2)} is below 0.80`);
    }
  });
  if (currencies.size > 1) issues.push('items use different currencies');
  if (Number(extracted?.confidence) < 0.8) {
    issues.push(`bundle confidence ${Number(extracted?.confidence || 0).toFixed(2)} is below 0.80`);
  }
  return [...new Set(issues)];
}

function extractionIsBetter(candidate, current, context) {
  const candidateIssues = reimbursementExtractionIssues(candidate, context);
  const currentIssues = reimbursementExtractionIssues(current, context);
  if (candidateIssues.length !== currentIssues.length) return candidateIssues.length < currentIssues.length;
  return Number(candidate?.confidence || 0) > Number(current?.confidence || 0);
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

async function extractReimbursementReceipt({ messageText, files, context = {} }, options = {}) {
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
  const instructionText = [
    buildReimbursementInstructions({ accounts, fileIds, context }),
    '',
    'Slack message:',
    String(messageText || '').slice(0, 12_000) || '(no accompanying text)',
    '',
    `Source file ids in attachment order: ${fileIds.join(', ') || '(none)'}`,
  ].join('\n');
  const attachmentBlocks = [];
  const content = [{
    type: 'input_text',
    text: instructionText,
  }];
  let totalBytes = 0;
  for (const file of selectedFiles) {
    const item = fileContentBlock(file);
    totalBytes += item.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, confidence: 0, reviewReason: `receipt attachments exceed ${MAX_TOTAL_BYTES} bytes` };
    }
    attachmentBlocks.push(item.block);
    content.push(item.block);
  }
  const firstResponse = await requestStructuredExtraction({
    content,
    schema,
    schemaName: 'reimbursement_receipt_bundle',
    maxOutputTokens: Math.min(6000, 800 + (selectedFiles.length || 1) * 500),
  }, options);
  if (!firstResponse.payload) return firstResponse;
  try {
    const raw = responseText(firstResponse.payload);
    if (!raw) throw new Error('no structured output text');
    let extracted = validateReimbursementExtraction(JSON.parse(raw), categoryKeys, fileIds);
    let selectedResponse = firstResponse;
    const initialIssues = reimbursementExtractionIssues(extracted, context);
    let verificationAttempted = false;
    let verificationResponseId = null;
    if (initialIssues.length) {
      verificationAttempted = true;
      const verificationContent = [{
        type: 'input_text',
        text: [
          instructionText,
          '',
          'QUALITY-CONTROL RECHECK:',
          'The first pass below has missing, low-confidence, or implausible fields. Independently reread every original attachment at high detail before returning a corrected bundle.',
          'Pay special attention to handwritten vendor/purpose text, every repeated amount field, and two-digit dates. Do not preserve a first-pass value merely because it was previously returned.',
          `First-pass issues: ${initialIssues.join('; ')}`,
          `First-pass output: ${JSON.stringify(extracted)}`,
        ].join('\n'),
      }, ...attachmentBlocks];
      const verificationResponse = await requestStructuredExtraction({
        content: verificationContent,
        schema,
        schemaName: 'reimbursement_receipt_bundle_verification',
        maxOutputTokens: Math.min(6000, 1000 + (selectedFiles.length || 1) * 550),
      }, options);
      verificationResponseId = verificationResponse.payload?.id || null;
      if (verificationResponse.payload) {
        const verificationRaw = responseText(verificationResponse.payload);
        if (verificationRaw) {
          try {
            const verified = validateReimbursementExtraction(JSON.parse(verificationRaw), categoryKeys, fileIds);
            if (extractionIsBetter(verified, extracted, context)) {
              extracted = verified;
              selectedResponse = verificationResponse;
            }
          } catch {
            // Keep the valid first-pass extraction and its review issues if the
            // quality-control response itself is malformed.
          }
        }
      }
    }
    const validationIssues = reimbursementExtractionIssues(extracted, context);
    return {
      ok: true,
      extracted,
      confidence: extracted.confidence,
      responseId: selectedResponse.payload.id || null,
      verificationResponseId,
      verificationAttempted,
      validationIssues,
      model: selectedResponse.payload.model || selectedResponse.model,
      usage: selectedResponse.payload.usage || null,
      requestHash: crypto.createHash('sha256')
        .update(JSON.stringify({ model: selectedResponse.model, schema, instructionText, verificationAttempted }))
        .digest('hex'),
    };
  } catch (error) {
    return {
      ok: false,
      confidence: 0,
      responseId: firstResponse.payload.id || null,
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
  MAX_RECEIPT_DATE_DISTANCE_DAYS,
  MAX_TOTAL_BYTES,
  buildInstructions,
  buildReimbursementInstructions,
  extractOwnerExpense,
  extractReimbursementReceipt,
  extractionIsBetter,
  extractionSchema,
  reimbursementExtractionSchema,
  fileContentBlock,
  responseText,
  reimbursementContextLines,
  reimbursementExtractionIssues,
  validateExtraction,
  validateReimbursementExtraction,
};
