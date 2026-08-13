'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { callOne } = require('../lib/voice-service');
const { loadPolicy } = require('../lib/channel-policy');
const { loadAccountingConfig } = require('../lib/accounting-config');

const PAYMENT_REFERENCE_RE = /\b(?:LPDSR|LPDS-R-)[A-F0-9]{16}\b/g;
const KAPITAL_SAFE_PAYMENT_REFERENCE_RE = /^LPDSR[A-F0-9]{16}$/;
const LEGACY_PAYMENT_REFERENCE_RE = /^LPDS-R-[A-F0-9]{16}$/;

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

function validateReceipt(input) {
  if (!input || typeof input !== 'object') throw new Error('receipt input is required');
  if (!String(input.slackMessageId || '').trim()) throw new Error('trusted Slack message id is required');
  const text = String(input.messageText || '').trim();
  const files = Array.isArray(input.fileRefs) ? input.fileRefs : [];
  if (!text && files.length === 0) throw new Error('receipt message has no text or file references');
}

const receiptIngest = {
  name: 'receipt.ingest',
  version: 1,
  capability: 'receipts.submit',
  mutates: true,
  validate: validateReceipt,
  steps: [
    {
      key: 'register_effect', maxAttempts: 1,
      async run({ db, run, input, store, stepKey }) {
        const source = {
          channelId: run.channel_id,
          slackMessageId: input.slackMessageId,
          messageText: String(input.messageText || ''),
          fileRefs: input.fileRefs || [],
        };
        const effect = await store.createEffect(db, {
          runId: run.id,
          stepKey,
          effectType: 'local_record_write',
          provider: 'sqlite',
          operation: 'accounting_receipt.upsert',
          idempotencyKey: `${run.id}:sqlite:accounting_receipt.upsert`,
          request: source,
          target: { channelId: run.channel_id, messageId: input.slackMessageId },
        });
        return { effectId: effect.id, sourceHash: store.sha256(source) };
      },
    },
    {
      key: 'persist_receipt', maxAttempts: 3,
      async run({ db, run, input, state, store }) {
        const id = crypto.randomUUID();
        const submittedAt = input.submittedAt || new Date().toISOString();
        const fileRefs = (Array.isArray(input.fileRefs) ? input.fileRefs : []).map(file => ({
          id: String(file.id || '').slice(0, 160),
          name: String(file.name || '').slice(0, 300),
          mimetype: String(file.mimetype || file.mimeType || '').slice(0, 160),
          size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
        }));
        await db.query(sql`INSERT OR IGNORE INTO accounting_receipts (
            id, slack_channel_id, slack_message_id, slack_thread_ts, submitted_by,
            submitted_at, message_text, file_refs_json, source_hash, status,
            workflow_run_id
          ) VALUES (
            ${id}, ${run.channel_id}, ${input.slackMessageId}, ${input.threadTs || null},
            ${run.actor_user_id}, ${submittedAt}, ${String(input.messageText || '')},
            ${JSON.stringify(fileRefs)}, ${state.register_effect.sourceHash}, 'received', ${run.id}
          )`);
        const [row] = await db.query(sql`SELECT id, source_hash, status FROM accounting_receipts
          WHERE slack_channel_id=${run.channel_id} AND slack_message_id=${input.slackMessageId}`);
        if (!row) throw new Error('receipt did not persist');
        await store.transitionEffect(db, {
          effectId: state.register_effect.effectId,
          providerRef: row.id,
          status: 'accepted_by_provider',
          providerStatus: 'sqlite_committed',
        });
        return { receiptId: row.id, status: row.status };
      },
    },
    {
      key: 'verify_readback', maxAttempts: 2,
      async run({ db, run, state, store, stepKey }) {
        const [row] = await db.query(sql`SELECT id, slack_channel_id, slack_message_id, source_hash, status
          FROM accounting_receipts WHERE id=${state.persist_receipt.receiptId}`);
        if (!row || row.source_hash !== state.register_effect.sourceHash) {
          const error = new Error('receipt readback hash mismatch');
          error.code = 'receipt_readback_mismatch';
          throw error;
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: 'sqlite.accounting_receipts',
          sourceRef: row.id,
          payload: row,
        });
        await store.transitionEffect(db, {
          effectId: state.register_effect.effectId,
          status: 'verified_by_readback',
          providerStatus: 'row_hash_verified',
          response: { evidenceId: evidence.id, payloadHash: evidence.payloadHash },
        });
        return { receiptId: row.id, evidenceId: evidence.id, status: row.status };
      },
    },
  ],
  output({ state }) {
    return { ...state.verify_readback, effectId: state.register_effect.effectId, status: 'verified_by_readback' };
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
  version: 5,
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
        items: normalizeReceiptItems(input),
      };
      if (!request.reimbursementRecipientUserId
          || !/^U[A-Z0-9]+$/.test(request.reimbursementRecipientUserId)) {
        throw new Error('receipt submitter cannot be resolved as the reimbursement recipient');
      }
      const previousPaymentReference = receipt.payment_reference || null;
      const normalizedReference = kapitalSafePaymentReference(previousPaymentReference, receipt.id);
      const paymentReference = normalizedReference.paymentReference;
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
          reimbursement_recipient_user_id=${request.reimbursementRecipientUserId},
          extraction_json=${JSON.stringify({
            source: 'channel_member', actorUserId: run.actor_user_id,
            itemCount: input.items === undefined ? null : request.items.length,
          })}, status='extracted', workflow_run_id=${run.id}, updated_at=datetime('now')
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
              ${item.description}, ${item.categoryKey}, ${item.categoryName}, 1
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
      const message = buildReceiptPaymentInstruction({
        receipt,
        items,
        approverUserIds,
        paymentReferenceMigrated: state.write_annotation.paymentReferenceMigrated,
      });
      const instructionHash = store.sha256({
        receiptId: receipt.id,
        paymentReference: receipt.payment_reference,
        recipientUserId: receipt.reimbursement_recipient_user_id,
        approverUserIds,
        message,
      });
      const outbox = await store.enqueueOutbox(db, {
        runId: run.id,
        topic: 'slack.notification',
        idempotencyKey: `receipt:${receipt.id}:payment-instruction:${instructionHash}`,
        payload: {
          channelId: receipt.slack_channel_id,
          threadTs: receipt.slack_thread_ts || receipt.slack_message_id,
          message,
        },
      });
      await db.query(sql`UPDATE accounting_receipts SET
        payment_instruction_hash=${instructionHash},
        payment_instruction_queued_at=datetime('now'),
        updated_at=datetime('now') WHERE id=${receipt.id}`);
      return {
        outboxId: outbox.id,
        instructionStatus: outbox.status,
        paymentReference: receipt.payment_reference,
      };
    },
  }],
  output({ state }) {
    return { ...state.write_annotation, ...state.queue_payment_instruction, status: 'verified_by_readback' };
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
  buildReceiptPaymentInstruction,
  guestReplyDraft,
  kapitalSafePaymentReference,
  paymentReferencesIn,
  receiptAnnotate,
  receiptIngest,
  receiptPaymentReference,
  receiptReconcile,
  socialContentUpsert,
  validateGuestDraft,
  validateReceiptAnnotation,
  normalizeReceiptItems,
  validateReceipt,
  validateSocialContent,
};
