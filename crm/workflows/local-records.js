'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { callOne } = require('../lib/voice-service');
const { loadPolicy } = require('../lib/channel-policy');
const { expenseAccount, loadAccountingConfig } = require('../lib/accounting-config');
const { policySnapshot } = require('../lib/workflow-execution-policy');

const PAYMENT_REFERENCE_RE = /\b(?:LPDSR|LPDS-R-)[A-F0-9]{16}\b/g;
const KAPITAL_SAFE_PAYMENT_REFERENCE_RE = /^LPDSR[A-F0-9]{16}$/;
const LEGACY_PAYMENT_REFERENCE_RE = /^LPDS-R-[A-F0-9]{16}$/;
const RESORT_TIME_ZONE = 'America/Bahia_Banderas';

function receiptPaymentReference(receiptId) {
  const digest = crypto.createHash('sha256').update(String(receiptId)).digest('hex').slice(0, 16).toUpperCase();
  return `LPDSR${digest}`;
}

function kapitalSafePaymentReference(existingReference, receiptId) {
  const existing = String(existingReference || '').toUpperCase();
  if (!existing) return { paymentReference: receiptPaymentReference(receiptId), migrated: false };
  if (KAPITAL_SAFE_PAYMENT_REFERENCE_RE.test(existing)) {
    return { paymentReference: existing, migrated: false };
  }
  if (LEGACY_PAYMENT_REFERENCE_RE.test(existing)) {
    return { paymentReference: existing.replaceAll('-', ''), migrated: true };
  }
  const error = new Error('receipt payment reference is not Kapital-compatible');
  error.code = 'receipt_payment_reference_invalid';
  throw error;
}

function paymentReferencesIn(...values) {
  return [...new Set(values.flatMap(value => String(value || '').toUpperCase().match(PAYMENT_REFERENCE_RE) || []))];
}

function formatReceiptMoney(amount, currency) {
  return `${currency} $${Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildReceiptPaymentInstruction({
  receipt, items, approverUserIds, paymentReferenceMigrated = false,
}) {
  const currency = String(receipt.currency).toUpperCase();
  const recipient = `<@${receipt.reimbursement_recipient_user_id}>`;
  const approvers = approverUserIds.map(userId => `<@${userId}>`).join(' ');
  const lines = items.length
    ? items.map(item => {
      const category = item.category_name || item.category_key || 'Unclassified';
      const vendor = item.vendor ? ` · ${item.vendor}` : '';
      return `${item.item_index}. ${formatReceiptMoney(item.amount, item.currency)} · ${category}${vendor}`;
    })
    : [`1. ${formatReceiptMoney(receipt.amount, currency)} · ${receipt.category_name || receipt.category_key || 'Unclassified'}`];
  return [
    paymentReferenceMigrated
      ? '⚠️ *Corrected Kapital-compatible reimbursement instruction*'
      : '🧾 *Reimbursement ready for confirmation*',
    ...(paymentReferenceMigrated
      ? ['The earlier hyphenated code is not accepted by Kapital. Use the corrected letters-and-numbers-only code below.', '']
      : []),
    `${recipient}, please confirm the receipt amounts and categories below:`,
    ...lines,
    `*Total: ${formatReceiptMoney(receipt.amount, currency)}*`,
    '',
    `${approvers} *Kapital payment instruction*`,
    `• Reimburse: ${recipient}`,
    `• Send one transfer for: *${formatReceiptMoney(receipt.amount, currency)}*`,
    `• Kapital description (letters and numbers only) — copy exactly: \`${receipt.payment_reference}\``,
    'Keep that code unchanged. Reconciliation requires the exact code, amount, and currency; a missing or mismatched code will not auto-match.',
  ].join('\n');
}

function buildReceiptPaidDocumentation({ receipt, items, approverUserIds, payment }) {
  const currency = String(receipt.currency).toUpperCase();
  const recipient = `<@${receipt.reimbursement_recipient_user_id}>`;
  const approvers = approverUserIds.map(userId => `<@${userId}>`).join(' ');
  const lines = items.length
    ? items.map(item => {
      const category = item.category_name || item.category_key || 'Unclassified';
      const vendor = item.vendor ? ` · ${item.vendor}` : '';
      return `${item.item_index}. ${formatReceiptMoney(item.amount, item.currency)} · ${category}${vendor}`;
    })
    : [`1. ${formatReceiptMoney(receipt.amount, currency)} · ${receipt.category_name || receipt.category_key || 'Unclassified'}`];
  return [
    '✅ *Payment already completed and receipt documented*',
    `${approvers} no new transfer is needed for this receipt.`,
    `• Reimbursement recipient: ${recipient}`,
    ...lines,
    `*Total paid: ${formatReceiptMoney(receipt.amount, currency)}*`,
    `• Kapital description used: \`${payment.actualPaymentDescription}\``,
    `• Payment confirmation: \`${payment.confirmationReference}\``,
    '• Reconciliation: legacy unique currency + amount + ±3-day date match, because the transfer was completed before a workflow code was supplied.',
    'No CLABE, bank-account number, or other banking details are required or stored by this receipt workflow.',
  ].join('\n');
}

function resortLocalDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: RESORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateReceipt(input) {
  if (!input || typeof input !== 'object') throw new Error('receipt input is required');
  if (!/^\d+(?:\.\d+)?$/.test(String(input.slackMessageId || ''))) {
    throw new Error('trusted Slack message timestamp is required');
  }
}

const receiptIngest = {
  name: 'receipt.ingest',
  version: 2,
  capability: 'receipts.submit',
  mutates: true,
  allowedTriggers: ['slack_receipt_hook'],
  validate: validateReceipt,
  steps: [
    {
      key: 'fetch_source', effectClass: 'external_read', maxAttempts: 2,
      async run({ run, input, services }) {
        if (typeof services.fetchSlackReceipt !== 'function') {
          throw new Error('Slack receipt source service is unavailable');
        }
        return services.fetchSlackReceipt({
          channelId: run.channel_id,
          messageId: input.slackMessageId,
          threadTs: input.threadTs || null,
        });
      },
    },
    {
      key: 'persist_receipt', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, input, state, store, stepKey }) {
        const source = state.fetch_source;
        const files = (Array.isArray(source.files) ? source.files : []).map(file => ({
          id: String(file.id || '').slice(0, 160),
          name: String(file.name || '').slice(0, 300),
          mimetype: String(file.mimetype || '').slice(0, 160),
          size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
          sha256: String(file.sha256 || '').slice(0, 64),
          localPath: String(file.localPath || '').slice(0, 2000),
        }));
        const messageText = String(source.messageText || '');
        if (!messageText.trim() && files.length === 0) {
          return { ignored: true, reason: 'empty Slack receipt post' };
        }
        const sourceHash = store.sha256({
          channelId: run.channel_id,
          messageId: input.slackMessageId,
          messageText,
          files: files.map(({ id, name, mimetype, size, sha256 }) => ({ id, name, mimetype, size, sha256 })),
        });
        const id = crypto.randomUUID();
        await db.query(sql`INSERT OR IGNORE INTO accounting_receipts (
            id, slack_channel_id, slack_message_id, slack_thread_ts, submitted_by,
            submitted_at, message_text, file_refs_json, source_hash, status,
            workflow_run_id
          ) VALUES (
            ${id}, ${run.channel_id}, ${input.slackMessageId}, ${input.threadTs || input.slackMessageId},
            ${run.actor_user_id}, ${source.submittedAt || input.submittedAt || new Date().toISOString()},
            ${messageText}, ${JSON.stringify(files)}, ${sourceHash}, 'received', ${run.id}
          )`);
        let [row] = await db.query(sql`SELECT * FROM accounting_receipts
          WHERE slack_channel_id=${run.channel_id} AND slack_message_id=${input.slackMessageId}`);
        if (row && row.source_hash !== sourceHash && row.status === 'received' && !row.qbo_entity_id) {
          await db.query(sql`UPDATE accounting_receipts SET
            slack_thread_ts=${input.threadTs || input.slackMessageId}, submitted_by=${run.actor_user_id},
            submitted_at=${source.submittedAt || input.submittedAt || row.submitted_at},
            message_text=${messageText}, file_refs_json=${JSON.stringify(files)},
            source_hash=${sourceHash}, review_reason=NULL, extraction_json=NULL,
            workflow_run_id=${run.id}, updated_at=datetime('now')
            WHERE id=${row.id} AND status='received' AND qbo_entity_id IS NULL`);
          [row] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${row.id}`);
        }
        if (!row || row.source_hash !== sourceHash) {
          const error = new Error('receipt readback hash mismatch');
          error.code = 'receipt_readback_mismatch';
          throw error;
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: 'slack.message.readback',
          sourceRef: input.slackMessageId,
          payload: { receiptId: row.id, sourceHash, fileCount: files.length },
        });
        return {
          receiptId: row.id, status: row.status, sourceHash,
          evidenceId: evidence.id, ignored: false,
        };
      },
    },
    {
      key: 'queue_processing', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, state, store }) {
        if (state.persist_receipt.ignored) return { skipped: true, status: 'ignored' };
        const policy = loadPolicy({ fresh: true });
        const created = await store.createRun(db, {
          definition: receiptProcess,
          idempotencyKey: `receipt:${state.persist_receipt.receiptId}:process:v1:${state.persist_receipt.sourceHash.slice(0, 24)}`,
          triggerType: 'workflow',
          triggerRef: run.id,
          channelId: run.channel_id,
          actorUserId: run.actor_user_id,
          input: { receiptId: state.persist_receipt.receiptId },
          policySnapshot: policySnapshot(policy, receiptProcess),
        });
        return { processRunId: created.run.id, queued: created.created, status: 'queued' };
      },
    },
  ],
  output({ state }) {
    return {
      status: state.queue_processing.status,
      receiptId: state.persist_receipt.receiptId || null,
      evidenceId: state.persist_receipt.evidenceId || null,
      processRunId: state.queue_processing.processRunId || null,
    };
  },
};

function validateSocialContent(input) {
  const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  if (!caption) throw new Error('caption is required');
  if (caption.length > 10000) throw new Error('caption is too long');
  if (input.contentId && !/^[0-9a-f-]{36}$/i.test(String(input.contentId))) throw new Error('invalid contentId');
  const refs = Array.isArray(input.mediaRefs) ? input.mediaRefs : [];
  if (refs.length > 20) throw new Error('too many media references');
  if (input.status !== undefined && !['draft', 'approved'].includes(String(input.status))) {
    throw new Error('social content status must be draft or approved');
  }
}

const socialContentUpsert = {
  name: 'social.content.upsert',
  version: 1,
  capability: 'social.write',
  mutates: true,
  validate: validateSocialContent,
  steps: [
    {
      key: 'write_content', maxAttempts: 2,
      async run({ db, run, input, store, stepKey }) {
        const id = input.contentId || crypto.randomUUID();
        const mediaRefs = (Array.isArray(input.mediaRefs) ? input.mediaRefs : []).map(ref => ({
          id: String(ref.id || '').slice(0, 200),
          path: String(ref.path || '').slice(0, 2000),
          type: String(ref.type || '').slice(0, 80),
        }));
        const request = {
          id, caption: input.caption.trim(), mediaRefs,
          contentType: input.contentType || 'post', scheduledFor: input.scheduledFor || null,
          status: input.status || 'draft',
        };
        const effect = await store.createEffect(db, {
          runId: run.id,
          stepKey,
          effectType: 'local_record_write', provider: 'sqlite', operation: 'social_content.upsert',
          idempotencyKey: `${run.id}:sqlite:social_content.upsert`, request, target: { contentId: id },
        });
        const [existing] = await db.query(sql`SELECT id FROM social_content WHERE id=${id}`);
        if (existing) {
          await db.query(sql`UPDATE social_content SET
            version=version+1, caption=${request.caption}, media_refs_json=${JSON.stringify(mediaRefs)},
            content_type=${request.contentType}, scheduled_for=${request.scheduledFor},
            status=${request.status}, updated_by=${run.actor_user_id}, workflow_run_id=${run.id},
            updated_at=datetime('now') WHERE id=${id}`);
        } else {
          await db.query(sql`INSERT INTO social_content (
            id, caption, media_refs_json, content_type, scheduled_for, status,
            created_by, updated_by, workflow_run_id
          ) VALUES (
            ${id}, ${request.caption}, ${JSON.stringify(mediaRefs)}, ${request.contentType},
            ${request.scheduledFor}, ${request.status}, ${run.actor_user_id}, ${run.actor_user_id}, ${run.id}
          )`);
        }
        const [row] = await db.query(sql`SELECT id, version, status, caption, media_refs_json, scheduled_for
          FROM social_content WHERE id=${id}`);
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'sqlite.social_content', sourceRef: id, payload: row,
        });
        await store.transitionEffect(db, {
          effectId: effect.id, providerRef: id, status: 'verified_by_readback',
          providerStatus: 'row_readback_verified', response: { evidenceId: evidence.id },
        });
        return { contentId: id, version: row.version, contentStatus: row.status, effectId: effect.id, evidenceId: evidence.id };
      },
    },
  ],
  output({ state }) { return { ...state.write_content, status: 'verified_by_readback' }; },
};

function validateGuestDraft(input) {
  const inbound = typeof input.inboundText === 'string' ? input.inboundText.trim() : '';
  if (!inbound) throw new Error('inboundText is required');
  if (inbound.length > 12000) throw new Error('inboundText is too long');
}

const guestReplyDraft = {
  name: 'guest.reply.draft',
  version: 1,
  capability: 'guest_messages.draft',
  mutates: true,
  validate: validateGuestDraft,
  steps: [
    {
      key: 'draft_in_voice', maxAttempts: 2,
      async run({ db, run, input, store, stepKey }) {
        const effect = await store.createEffect(db, {
          runId: run.id, stepKey, effectType: 'ai_draft', provider: 'voice-service',
          operation: 'inbound_inquiry_response',
          idempotencyKey: `${run.id}:voice-service:inbound_inquiry_response`,
          request: { inboundHash: store.sha256(input.inboundText.trim()), draftLength: input.draftLength || 'short' },
          target: { channelId: run.channel_id, actorUserId: run.actor_user_id },
        });
        const result = await callOne({
          intent: 'inbound_inquiry_response',
          message_context: input.inboundText.trim(),
          agent_id: 'sarah-coach',
          draft_length: input.draftLength || 'short',
        });
        if (!result?.draft_text || !result.voice_drafts_log_id) throw new Error('Voice Service returned no durable draft record');
        const [readback] = await db.query(sql`SELECT id, draft_text, retrieved_example_ids, cost_usd,
          created_at FROM voice_drafts_log WHERE id=${result.voice_drafts_log_id}`);
        if (!readback || readback.draft_text !== result.draft_text) throw new Error('Voice Service draft readback mismatch');
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'crm.voice_drafts_log', sourceRef: String(readback.id), payload: readback,
        });
        await store.transitionEffect(db, {
          effectId: effect.id, providerRef: String(readback.id), status: 'verified_by_readback',
          providerStatus: 'draft_log_verified', response: { evidenceId: evidence.id },
        });
        return {
          effectId: effect.id,
          evidenceId: evidence.id,
          voiceDraftId: readback.id,
          draftText: readback.draft_text,
          model: result.model_used || null,
          voiceSpecVersion: result.voice_spec_version || null,
        };
      },
    },
  ],
  output({ state }) { return { ...state.draft_in_voice, status: 'verified_by_readback' }; },
};

function validateReceiptAnnotation(input) {
  if (!/^[0-9a-f-]{36}$/i.test(String(input.receiptId || ''))) throw new Error('valid receiptId is required');
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('positive amount is required');
  if (!['MXN', 'USD'].includes(String(input.currency || '').toUpperCase())) throw new Error('currency must be MXN or USD');
  if (input.transactionDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.transactionDate))) {
    throw new Error('transactionDate must be YYYY-MM-DD');
  }
  const description = String(input.description || '').trim();
  const categoryKey = String(input.categoryKey || '').trim();
  const categoryName = String(input.categoryName || '').trim();
  if (description.length > 2000) throw new Error('description is too long');
  if ((categoryKey || categoryName) && (!categoryKey || !categoryName)) {
    throw new Error('categoryKey and categoryName must be supplied together');
  }
  if (categoryKey && !/^[a-z0-9_]{1,80}$/.test(categoryKey)) throw new Error('invalid categoryKey');
  if (categoryName.length > 160) throw new Error('categoryName is too long');
  if (input.reimbursementRecipientUserId !== undefined
      && !/^U[A-Z0-9]+$/.test(String(input.reimbursementRecipientUserId))) {
    throw new Error('reimbursementRecipientUserId must be a Slack user id');
  }
  if (input.paymentAlreadyCompleted !== undefined && typeof input.paymentAlreadyCompleted !== 'boolean') {
    throw new Error('paymentAlreadyCompleted must be a boolean');
  }
  const paymentConfirmationReference = String(input.paymentConfirmationReference || '').trim();
  const actualPaymentDescription = String(input.actualPaymentDescription || '').trim();
  if (input.paymentAlreadyCompleted === true) {
    if (!paymentConfirmationReference || paymentConfirmationReference.length > 160) {
      throw new Error('paymentConfirmationReference is required for an already-completed payment');
    }
    if (!actualPaymentDescription || actualPaymentDescription.length > 300) {
      throw new Error('actualPaymentDescription is required for an already-completed payment');
    }
  } else if (paymentConfirmationReference || actualPaymentDescription) {
    throw new Error('payment confirmation fields require paymentAlreadyCompleted=true');
  }
  normalizeReceiptItems(input);
}

function normalizeReceiptItems(input) {
  if (input.items === undefined) return [];
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('items must be a non-empty array when supplied');
  }
  if (input.items.length > 20) throw new Error('too many receipt items');
  const parentCurrency = String(input.currency || '').toUpperCase();
  const seenFileRefs = new Set();
  const items = input.items.map((raw, offset) => {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const currency = String(item.currency || parentCurrency).toUpperCase();
    if (!['MXN', 'USD'].includes(currency)) throw new Error(`item ${offset + 1} currency must be MXN or USD`);
    if (currency !== parentCurrency) throw new Error(`item ${offset + 1} currency must match the receipt currency`);
    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`item ${offset + 1} requires a positive amount`);
    const transactionDate = item.transactionDate || input.transactionDate || null;
    if (transactionDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(transactionDate))) {
      throw new Error(`item ${offset + 1} transactionDate must be YYYY-MM-DD`);
    }
    const fileRefId = String(item.fileRefId || '').trim().slice(0, 160) || null;
    if (fileRefId && seenFileRefs.has(fileRefId)) throw new Error(`item ${offset + 1} repeats fileRefId`);
    if (fileRefId) seenFileRefs.add(fileRefId);
    const vendor = String(item.vendor || '').trim().slice(0, 300) || null;
    const description = String(item.description || '').trim();
    const itemCategoryKey = String(item.categoryKey || '').trim();
    const itemCategoryName = String(item.categoryName || '').trim();
    if (description.length > 1000) throw new Error(`item ${offset + 1} description is too long`);
    if ((itemCategoryKey || itemCategoryName) && (!itemCategoryKey || !itemCategoryName)) {
      throw new Error(`item ${offset + 1} categoryKey and categoryName must be supplied together`);
    }
    if (itemCategoryKey && !/^[a-z0-9_]{1,80}$/.test(itemCategoryKey)) {
      throw new Error(`item ${offset + 1} has invalid categoryKey`);
    }
    if (itemCategoryName.length > 160) throw new Error(`item ${offset + 1} categoryName is too long`);
    const extractionConfidence = item.extractionConfidence === undefined
      ? 1 : Number(item.extractionConfidence);
    if (!Number.isFinite(extractionConfidence) || extractionConfidence < 0 || extractionConfidence > 1) {
      throw new Error(`item ${offset + 1} extractionConfidence must be between 0 and 1`);
    }
    return {
      itemIndex: offset + 1,
      fileRefId,
      vendor,
      transactionDate,
      currency,
      amount,
      description: description || null,
      categoryKey: itemCategoryKey || null,
      categoryName: itemCategoryName || null,
      extractionConfidence,
    };
  });
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (Math.abs(total - Number(input.amount)) > 0.005) {
    throw new Error(`receipt item total ${total.toFixed(2)} does not equal receipt amount ${Number(input.amount).toFixed(2)}`);
  }
  return items;
}

const receiptAnnotate = {
  name: 'receipt.annotate',
  version: 6,
  capability: 'receipts.write',
  mutates: true,
  validate: validateReceiptAnnotation,
  steps: [{
    key: 'write_annotation', maxAttempts: 2,
    async run({ db, run, input, store, stepKey }) {
      const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${input.receiptId}`);
      if (!receipt) throw new Error('receipt not found');
      if (['matched', 'posted'].includes(receipt.status)) {
        const error = new Error('a reconciled receipt cannot be re-annotated');
        error.code = 'receipt_already_reconciled';
        throw error;
      }
      const channel = loadPolicy().channels?.[run.channel_id];
      const canSeeAll = channel?.capabilities?.includes('receipts.read');
      if (!canSeeAll && receipt.slack_channel_id !== run.channel_id) {
        const error = new Error('receipt channel may amend only its own receipts');
        error.code = 'receipt_scope_violation';
        throw error;
      }
      const request = {
        receiptId: input.receiptId,
        vendor: String(input.vendor || '').trim().slice(0, 300) || null,
        transactionDate: input.transactionDate || null,
        currency: String(input.currency).toUpperCase(),
        amount: Number(input.amount),
        description: String(input.description || '').trim() || null,
        categoryKey: String(input.categoryKey || '').trim() || null,
        categoryName: String(input.categoryName || '').trim() || null,
        reimbursementRecipientUserId: String(
          input.reimbursementRecipientUserId || receipt.submitted_by || '',
        ).trim() || null,
        paymentAlreadyCompleted: input.paymentAlreadyCompleted === true,
        paymentConfirmationReference: String(input.paymentConfirmationReference || '').trim() || null,
        actualPaymentDescription: String(input.actualPaymentDescription || '').trim() || null,
        items: normalizeReceiptItems(input),
      };
      if (!request.reimbursementRecipientUserId
          || !/^U[A-Z0-9]+$/.test(request.reimbursementRecipientUserId)) {
        throw new Error('receipt submitter cannot be resolved as the reimbursement recipient');
      }
      const previousPaymentReference = receipt.payment_reference || null;
      const normalizedReference = request.paymentAlreadyCompleted
        ? { paymentReference: null, migrated: false }
        : kapitalSafePaymentReference(previousPaymentReference, receipt.id);
      const paymentReference = normalizedReference.paymentReference;
      let priorExtraction = {};
      if (receipt.extraction_json) {
        try { priorExtraction = JSON.parse(receipt.extraction_json); } catch { priorExtraction = {}; }
      }
      const paymentRecord = request.paymentAlreadyCompleted ? {
        status: 'completed_before_workflow_reference',
        confirmationReference: request.paymentConfirmationReference,
        actualPaymentDescription: request.actualPaymentDescription,
        reconciliationRule: 'unique_amount_currency_date_window',
      } : null;
      const extractionRecord = run.trigger_type === 'workflow'
        ? {
          ...priorExtraction,
          annotation: {
            source: 'automatic_receipt_process', processRunId: run.trigger_ref,
            actorUserId: run.actor_user_id, itemCount: request.items.length,
            payment: paymentRecord,
          },
        }
        : {
          ...priorExtraction,
          annotation: {
            source: 'channel_member', actorUserId: run.actor_user_id,
            itemCount: input.items === undefined ? null : request.items.length,
            payment: paymentRecord,
          },
        };
      const attachedFileIds = new Set((() => {
        try { return JSON.parse(receipt.file_refs_json || '[]'); } catch { return []; }
      })().map(file => String(file?.id || '')).filter(Boolean));
      for (const item of request.items) {
        if (item.fileRefId && !attachedFileIds.has(item.fileRefId)) {
          throw new Error(`receipt item ${item.itemIndex} fileRefId is not attached to the source message`);
        }
      }
      const effect = await store.createEffect(db, {
        runId: run.id, stepKey, effectType: 'local_record_write', provider: 'sqlite',
        operation: 'accounting_receipt.annotate', idempotencyKey: `${run.id}:sqlite:accounting_receipt.annotate`,
        request, target: { receiptId: input.receiptId },
      });
      await db.tx(async tx => {
        await tx.query(sql`UPDATE accounting_receipts SET vendor=${request.vendor},
          transaction_date=${request.transactionDate}, currency=${request.currency}, amount=${request.amount},
          description=${request.description}, category_key=${request.categoryKey}, category_name=${request.categoryName},
          payment_reference=${paymentReference},
          payment_instruction_hash=${request.paymentAlreadyCompleted ? null : receipt.payment_instruction_hash},
          payment_instruction_queued_at=${request.paymentAlreadyCompleted ? null : receipt.payment_instruction_queued_at},
          reimbursement_recipient_user_id=${request.reimbursementRecipientUserId},
          extraction_json=${JSON.stringify(extractionRecord)},
          review_reason=NULL, status='extracted', workflow_run_id=${run.id}, updated_at=datetime('now')
          WHERE id=${input.receiptId}`);
        if (input.items !== undefined) {
          await tx.query(sql`DELETE FROM accounting_receipt_items WHERE receipt_id=${input.receiptId}`);
          for (const item of request.items) {
            await tx.query(sql`INSERT INTO accounting_receipt_items (
              id, receipt_id, item_index, file_ref_id, vendor, transaction_date, currency,
              amount, description, category_key, category_name, extraction_confidence
            ) VALUES (
              ${crypto.randomUUID()}, ${input.receiptId}, ${item.itemIndex}, ${item.fileRefId},
              ${item.vendor}, ${item.transactionDate}, ${item.currency}, ${item.amount},
              ${item.description}, ${item.categoryKey}, ${item.categoryName}, ${item.extractionConfidence}
            )`);
          }
        }
      });
      const [readback] = await db.query(sql`SELECT id, vendor, transaction_date, currency, amount,
        description, category_key, category_name, status, payment_reference,
        reimbursement_recipient_user_id, slack_channel_id, slack_message_id, slack_thread_ts
        FROM accounting_receipts WHERE id=${input.receiptId}`);
      if (!readback || Number(readback.amount) !== request.amount || readback.currency !== request.currency
        || readback.description !== request.description || readback.category_key !== request.categoryKey
        || readback.category_name !== request.categoryName
        || readback.payment_reference !== paymentReference
        || readback.reimbursement_recipient_user_id !== request.reimbursementRecipientUserId) {
        throw new Error('receipt annotation readback mismatch');
      }
      const itemReadback = await db.query(sql`SELECT item_index, file_ref_id, vendor, transaction_date,
        currency, amount, description, category_key, category_name
        FROM accounting_receipt_items WHERE receipt_id=${input.receiptId} ORDER BY item_index`);
      if (input.items !== undefined && (
        itemReadback.length !== request.items.length
        || itemReadback.some((item, index) => Number(item.amount) !== request.items[index].amount
          || item.currency !== request.items[index].currency
          || item.file_ref_id !== request.items[index].fileRefId
          || item.category_key !== request.items[index].categoryKey)
      )) throw new Error('receipt item annotation readback mismatch');
      const evidence = await store.createEvidence(db, {
        runId: run.id, stepKey, source: 'sqlite.accounting_receipts', sourceRef: input.receiptId,
        payload: { receipt: readback, items: itemReadback },
      });
      await store.transitionEffect(db, {
        effectId: effect.id, providerRef: input.receiptId, status: 'verified_by_readback',
        providerStatus: 'annotation_readback_verified', response: { evidenceId: evidence.id },
      });
      return {
        receiptId: input.receiptId, effectId: effect.id, evidenceId: evidence.id,
        receiptStatus: readback.status, itemCount: itemReadback.length,
        paymentReference: readback.payment_reference,
        previousPaymentReference,
        paymentReferenceMigrated: normalizedReference.migrated,
        paymentAlreadyCompleted: request.paymentAlreadyCompleted,
        paymentConfirmationReference: request.paymentConfirmationReference,
        actualPaymentDescription: request.actualPaymentDescription,
      };
    },
  }, {
    key: 'queue_payment_instruction', maxAttempts: 2,
    async run({ db, run, state, store }) {
      const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts
        WHERE id=${state.write_annotation.receiptId}`);
      if (!receipt) throw new Error('annotated receipt was not found');
      const items = await db.query(sql`SELECT item_index, vendor, currency, amount,
        category_key, category_name FROM accounting_receipt_items
        WHERE receipt_id=${receipt.id} ORDER BY item_index`);
      const accounting = loadAccountingConfig();
      const approverUserIds = [...new Set(accounting.receipt_payment?.approver_user_ids || [])];
      if (!approverUserIds.length) {
        const error = new Error('receipt payment approvers are not configured');
        error.code = 'receipt_payment_approver_unavailable';
        throw error;
      }
      const message = state.write_annotation.paymentAlreadyCompleted
        ? buildReceiptPaidDocumentation({
          receipt,
          items,
          approverUserIds,
          payment: {
            confirmationReference: state.write_annotation.paymentConfirmationReference,
            actualPaymentDescription: state.write_annotation.actualPaymentDescription,
          },
        })
        : buildReceiptPaymentInstruction({
          receipt,
          items,
          approverUserIds,
          paymentReferenceMigrated: state.write_annotation.paymentReferenceMigrated,
        });
      const instructionHash = store.sha256({
        receiptId: receipt.id,
        paymentReference: receipt.payment_reference,
        paymentAlreadyCompleted: state.write_annotation.paymentAlreadyCompleted,
        paymentConfirmationReference: state.write_annotation.paymentConfirmationReference,
        actualPaymentDescription: state.write_annotation.actualPaymentDescription,
        recipientUserId: receipt.reimbursement_recipient_user_id,
        approverUserIds,
        message,
      });
      const outbox = await store.enqueueOutbox(db, {
        runId: run.id,
        topic: 'slack.notification',
        idempotencyKey: state.write_annotation.paymentAlreadyCompleted
          ? `receipt:${receipt.id}:paid-documentation:${instructionHash}`
          : `receipt:${receipt.id}:payment-instruction:${instructionHash}`,
        payload: {
          channelId: receipt.slack_channel_id,
          threadTs: receipt.slack_thread_ts || receipt.slack_message_id,
          message,
        },
      });
      if (!state.write_annotation.paymentAlreadyCompleted) {
        await db.query(sql`UPDATE accounting_receipts SET
          payment_instruction_hash=${instructionHash},
          payment_instruction_queued_at=datetime('now'),
          updated_at=datetime('now') WHERE id=${receipt.id}`);
      }
      return {
        outboxId: outbox.id,
        instructionStatus: state.write_annotation.paymentAlreadyCompleted ? null : outbox.status,
        documentationStatus: state.write_annotation.paymentAlreadyCompleted ? outbox.status : null,
        paymentReference: receipt.payment_reference,
      };
    },
  }],
  output({ state }) {
    return { ...state.write_annotation, ...state.queue_payment_instruction, status: 'verified_by_readback' };
  },
};

function parseReceiptFiles(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validReceiptDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text;
}

function reimbursementReviewReasons(result) {
  if (!result?.ok) return [result?.reviewReason || 'receipt extraction was unavailable'];
  const reasons = [];
  const items = Array.isArray(result.extracted?.items) ? result.extracted.items : [];
  if (!items.length) reasons.push('no reimbursement items were extracted');
  const currencies = new Set();
  items.forEach((item, offset) => {
    const label = `item ${offset + 1}`;
    if (!String(item.vendor || '').trim()) reasons.push(`${label} vendor is missing`);
    if (!validReceiptDate(item.transaction_date)) reasons.push(`${label} date is missing or invalid`);
    if (!['MXN', 'USD'].includes(item.currency)) reasons.push(`${label} currency is missing`);
    else currencies.add(item.currency);
    if (!Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) reasons.push(`${label} amount is missing`);
    if (!String(item.description || '').trim()) reasons.push(`${label} description is missing`);
    if (!String(item.category_key || '').trim()) reasons.push(`${label} expense category is missing`);
    if (Number(item.confidence) < 0.8) {
      reasons.push(`${label} confidence ${Number(item.confidence || 0).toFixed(2)} is below 0.80`);
    }
  });
  if (currencies.size > 1) reasons.push('items use different currencies');
  if (Number(result.extracted?.confidence) < 0.8) {
    reasons.push(`bundle confidence ${Number(result.extracted?.confidence || 0).toFixed(2)} is below 0.80`);
  }
  reasons.push(...(Array.isArray(result.validationIssues) ? result.validationIssues : []));
  return [...new Set(reasons)];
}

function automaticAnnotationInput(receipt, result) {
  const sourceFiles = parseReceiptFiles(receipt.file_refs_json);
  const fileOrder = new Map(sourceFiles.map((file, index) => [String(file.id || ''), index]));
  const extracted = [...result.extracted.items].sort((left, right) => {
    if (!sourceFiles.length) return 0;
    return (fileOrder.get(String(left.file_ref_id)) ?? Number.MAX_SAFE_INTEGER)
      - (fileOrder.get(String(right.file_ref_id)) ?? Number.MAX_SAFE_INTEGER);
  });
  const items = extracted.map(item => {
    const account = expenseAccount(item.category_key, { fresh: true });
    if (!account) throw new Error(`unknown reimbursement expense category: ${item.category_key}`);
    return {
      fileRefId: item.file_ref_id,
      vendor: String(item.vendor).trim(),
      transactionDate: item.transaction_date,
      currency: item.currency,
      amount: Number(item.amount),
      description: String(item.description).trim(),
      categoryKey: item.category_key,
      categoryName: String(account.name),
      extractionConfidence: Number(item.confidence),
    };
  });
  const currencies = [...new Set(items.map(item => item.currency))];
  if (currencies.length !== 1) throw new Error('automatic reimbursement annotation requires one currency');
  const categoryKeys = [...new Set(items.map(item => item.categoryKey))];
  const vendors = [...new Set(items.map(item => item.vendor))];
  const total = Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  return {
    receiptId: receipt.id,
    reimbursementRecipientUserId: receipt.submitted_by,
    vendor: vendors.length === 1 ? vendors[0] : 'Multiple vendors',
    transactionDate: items.map(item => item.transactionDate).sort().at(-1),
    currency: currencies[0],
    amount: total,
    description: items.length === 1
      ? items[0].description
      : `Reimbursement bundle with ${items.length} source documents`,
    categoryKey: categoryKeys.length === 1 ? items[0].categoryKey : null,
    categoryName: categoryKeys.length === 1 ? items[0].categoryName : null,
    items,
  };
}

const receiptProcess = {
  name: 'receipt.process',
  version: 2,
  capability: 'receipts.write',
  mutates: true,
  allowedTriggers: ['workflow'],
  validate(input) {
    if (!/^[0-9a-f-]{36}$/i.test(String(input?.receiptId || ''))) throw new Error('valid receiptId is required');
  },
  steps: [
    {
      key: 'load_receipt', effectClass: 'read', maxAttempts: 2,
      async run({ db, run, input }) {
        const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${input.receiptId}`);
        if (!receipt) throw new Error('receipt was not found');
        if (receipt.slack_channel_id !== run.channel_id) {
          const error = new Error('receipt belongs to another channel');
          error.code = 'receipt_scope_violation';
          throw error;
        }
        return {
          receipt,
          alreadyProcessed: ['extracted', 'matched', 'posted'].includes(receipt.status)
            || Boolean(receipt.payment_reference),
        };
      },
    },
    {
      key: 'extract', effectClass: 'external_read', maxAttempts: 2,
      async run({ run, state, services }) {
        if (state.load_receipt.alreadyProcessed) return { skipped: true };
        if (typeof services.extractReimbursementReceipt !== 'function') {
          return { ok: false, confidence: 0, reviewReason: 'reimbursement extraction service is unavailable' };
        }
        try {
          const accounting = loadAccountingConfig({ fresh: true });
          const configuredChannel = accounting.receipt_channels?.[run.channel_id] || {};
          const policyChannel = loadPolicy({ fresh: true }).channels?.[run.channel_id] || {};
          return await services.extractReimbursementReceipt({
            messageText: state.load_receipt.receipt.message_text,
            files: parseReceiptFiles(state.load_receipt.receipt.file_refs_json),
            context: {
              channelName: configuredChannel.name || policyChannel.name || null,
              channelScope: configuredChannel.scope || null,
              submittedDate: resortLocalDate(state.load_receipt.receipt.submitted_at),
            },
          });
        } catch (error) {
          return {
            ok: false,
            confidence: 0,
            reviewReason: `receipt extraction failed safely: ${String(error.message || error).slice(0, 240)}`,
          };
        }
      },
    },
    {
      key: 'persist_extraction', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, state, store, stepKey }) {
        const receipt = state.load_receipt.receipt;
        if (state.load_receipt.alreadyProcessed) {
          return { receiptId: receipt.id, skipped: true, shouldAnnotate: false, reasons: [] };
        }
        const result = state.extract;
        const reasons = reimbursementReviewReasons(result);
        const annotationInput = reasons.length === 0 ? automaticAnnotationInput(receipt, result) : null;
        const reviewReason = reasons.join('; ').slice(0, 1000) || null;
        await db.query(sql`UPDATE accounting_receipts SET
          extraction_confidence=${Number(result?.extracted?.confidence || result?.confidence || 0)},
          review_reason=${reviewReason},
          extraction_json=${JSON.stringify({
            source: 'openai_responses', responseId: result?.responseId || null,
            model: result?.model || null, requestHash: result?.requestHash || null,
            verificationResponseId: result?.verificationResponseId || null,
            verificationAttempted: result?.verificationAttempted === true,
            extracted: result?.ok ? result.extracted : null,
            reviewReason: result?.reviewReason || null,
            channelIntent: 'submitter_reimbursement',
          })},
          status=${reasons.length ? 'needs_review' : 'received'},
          workflow_run_id=${run.id}, updated_at=datetime('now') WHERE id=${receipt.id}`);
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: 'openai.responses.reimbursement_extraction',
          sourceRef: result?.responseId || receipt.id,
          confidence: Number(result?.extracted?.confidence || result?.confidence || 0),
          payload: {
            receiptId: receipt.id,
            itemCount: result?.extracted?.items?.length || 0,
            shouldAnnotate: reasons.length === 0,
            reasons,
          },
        });
        return {
          receiptId: receipt.id,
          skipped: false,
          shouldAnnotate: reasons.length === 0,
          reasons,
          annotationInput,
          evidenceId: evidence.id,
        };
      },
    },
    {
      key: 'queue_annotation', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, state, store }) {
        if (!state.persist_extraction.shouldAnnotate) return { skipped: true };
        const annotationInput = state.persist_extraction.annotationInput;
        const digest = store.sha256(annotationInput).slice(0, 24);
        const policy = loadPolicy({ fresh: true });
        const created = await store.createRun(db, {
          definition: receiptAnnotate,
          idempotencyKey: `receipt:${annotationInput.receiptId}:automatic-annotation:${digest}`,
          triggerType: 'workflow',
          triggerRef: run.id,
          channelId: run.channel_id,
          actorUserId: run.actor_user_id,
          input: annotationInput,
          policySnapshot: policySnapshot(policy, receiptAnnotate),
        });
        return { annotationRunId: created.run.id, queued: created.created };
      },
    },
    {
      key: 'notify_review', effectClass: 'internal_notification', maxAttempts: 2,
      async run({ db, run, state, store }) {
        if (state.persist_extraction.skipped || state.persist_extraction.shouldAnnotate) return { skipped: true };
        const receipt = state.load_receipt.receipt;
        const message = [
          '🧾 I logged this post as a reimbursement, but automatic extraction needs review before I can issue the Kapital payment instruction.',
          `Review needed: ${state.persist_extraction.reasons.join('; ')}`,
          `Receipt: ${receipt.id} · Workflow: ${run.id}`,
          'Review the original post and use receipt.annotate with that receipt id; the workflow will generate the Kapital code.',
          'Do not ask for or include a CLABE, bank-account number, or other banking details. They are never required for receipt annotation or code generation.',
        ].join('\n');
        const outbox = await store.enqueueOutbox(db, {
          runId: run.id,
          topic: 'slack.notification',
          idempotencyKey: `receipt:${receipt.id}:automatic-extraction-review`,
          payload: {
            channelId: receipt.slack_channel_id,
            threadTs: receipt.slack_thread_ts || receipt.slack_message_id,
            message,
          },
        });
        return { outboxId: outbox.id, status: outbox.status };
      },
    },
  ],
  output({ state }) {
    if (state.persist_extraction.skipped) {
      return { status: 'already_processed', receiptId: state.persist_extraction.receiptId };
    }
    if (!state.persist_extraction.shouldAnnotate) {
      return {
        status: 'needs_review', receiptId: state.persist_extraction.receiptId,
        evidenceId: state.persist_extraction.evidenceId,
        outboxId: state.notify_review.outboxId || null,
      };
    }
    return {
      status: 'queued', receiptId: state.persist_extraction.receiptId,
      evidenceId: state.persist_extraction.evidenceId,
      annotationRunId: state.queue_annotation.annotationRunId,
    };
  },
};

const receiptReconcile = {
  name: 'receipt.reconcile',
  version: 3,
  capability: 'accounting.write',
  mutates: true,
  autonomous: true,
  validate() {},
  steps: [{
    key: 'match_unique_transactions', maxAttempts: 2,
    async run({ db, run, store, stepKey }) {
      const receipts = await db.query(sql`SELECT r.* FROM accounting_receipts r
        WHERE r.status='extracted' AND r.amount IS NOT NULL AND r.transaction_date IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM accounting_reconciliations x
            WHERE x.receipt_id=r.id AND x.status='matched')`);
      const summary = {
        examined: receipts.length,
        matched: 0,
        ambiguous: 0,
        unmatched: 0,
        referenceMatched: 0,
        legacyMatched: 0,
        outcomes: [],
      };
      for (const receipt of receipts) {
        const tolerance = receipt.currency === 'MXN' ? 1 : 0.01;
        let candidates;
        let matchRule;
        let referenceCandidates = [];
        if (receipt.payment_reference) {
          const possibleReferenceCandidates = await db.query(sql`SELECT id, source_key, transaction_date,
            description, reference, currency, amount, category_key, classification_tier
            FROM accounting_bank_transactions
            WHERE instr(upper(COALESCE(description,'') || ' ' || COALESCE(reference,'')),
              upper(${receipt.payment_reference})) > 0
            ORDER BY transaction_date, id`);
          referenceCandidates = possibleReferenceCandidates.filter(candidate =>
            paymentReferencesIn(candidate.description, candidate.reference).includes(receipt.payment_reference));
          candidates = referenceCandidates.filter(candidate => candidate.currency === receipt.currency
            && Math.abs(Number(candidate.amount) - Number(receipt.amount)) <= tolerance);
          matchRule = 'exact_payment_reference_amount_currency';
        } else {
          candidates = await db.query(sql`SELECT id, source_key, transaction_date, currency, amount,
            category_key, classification_tier FROM accounting_bank_transactions
            WHERE currency=${receipt.currency}
              AND ABS(amount-${Number(receipt.amount)}) <= ${tolerance}
              AND ABS(julianday(transaction_date)-julianday(${receipt.transaction_date})) <= 3
            ORDER BY transaction_date, id`);
          matchRule = 'unique_amount_currency_date_window';
        }
        if (candidates.length === 1) {
          const candidate = candidates[0];
          const reconciliationId = crypto.randomUUID();
          await db.query(sql`INSERT INTO accounting_reconciliations (
              id, receipt_id, bank_reference, status, confidence, evidence_json, workflow_run_id
            ) VALUES (
              ${reconciliationId}, ${receipt.id}, ${candidate.source_key}, 'matched', 1,
              ${JSON.stringify({
                rule: matchRule,
                paymentReference: receipt.payment_reference || null,
                bankTransactionId: candidate.id,
              })}, ${run.id}
            ) ON CONFLICT(receipt_id, bank_provider, bank_reference) DO UPDATE SET
              status='matched', confidence=1, evidence_json=excluded.evidence_json,
              workflow_run_id=excluded.workflow_run_id, updated_at=datetime('now')`);
          await db.query(sql`UPDATE accounting_receipts SET status='matched', review_reason=NULL,
            updated_at=datetime('now') WHERE id=${receipt.id}`);
          summary.matched += 1;
          if (receipt.payment_reference) summary.referenceMatched += 1;
          else summary.legacyMatched += 1;
          summary.outcomes.push({ receiptId: receipt.id, status: 'matched', rule: matchRule, bankTransactionId: candidate.id });
        } else if (candidates.length > 1) {
          const reason = receipt.payment_reference
            ? 'payment_reference_matches_multiple_bank_transactions'
            : 'amount_currency_date_matches_multiple_bank_transactions';
          await db.query(sql`UPDATE accounting_receipts SET status='needs_review', review_reason=${reason},
            updated_at=datetime('now') WHERE id=${receipt.id}`);
          summary.ambiguous += 1;
          summary.outcomes.push({ receiptId: receipt.id, status: 'needs_review', rule: matchRule, reason, candidateCount: candidates.length });
        } else if (receipt.payment_reference && referenceCandidates.length > 0) {
          const reason = 'payment_reference_amount_or_currency_mismatch';
          await db.query(sql`UPDATE accounting_receipts SET status='needs_review', review_reason=${reason},
            updated_at=datetime('now') WHERE id=${receipt.id}`);
          summary.ambiguous += 1;
          summary.outcomes.push({
            receiptId: receipt.id,
            status: 'needs_review',
            rule: matchRule,
            reason,
            candidateCount: referenceCandidates.length,
          });
        } else {
          summary.unmatched += 1;
          summary.outcomes.push({ receiptId: receipt.id, status: 'unmatched', rule: matchRule });
        }
      }
      const evidence = await store.createEvidence(db, {
        runId: run.id, stepKey, source: 'sqlite.accounting_reconciliation', payload: summary,
      });
      return { ...summary, evidenceId: evidence.id };
    },
  }],
  output({ state }) { return { ...state.match_unique_transactions, status: 'verified_by_readback' }; },
};

module.exports = {
  buildReceiptPaidDocumentation,
  buildReceiptPaymentInstruction,
  guestReplyDraft,
  kapitalSafePaymentReference,
  paymentReferencesIn,
  receiptAnnotate,
  receiptIngest,
  receiptPaymentReference,
  receiptProcess,
  receiptReconcile,
  socialContentUpsert,
  validateGuestDraft,
  validateReceiptAnnotation,
  normalizeReceiptItems,
  validateReceipt,
  resortLocalDate,
  validateSocialContent,
};
