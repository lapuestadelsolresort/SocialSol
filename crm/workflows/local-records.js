'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { callOne } = require('../lib/voice-service');
const { loadPolicy } = require('../lib/channel-policy');

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
}

const receiptAnnotate = {
  name: 'receipt.annotate',
  version: 1,
  capability: 'receipts.write',
  mutates: true,
  validate: validateReceiptAnnotation,
  steps: [{
    key: 'write_annotation', maxAttempts: 2,
    async run({ db, run, input, store, stepKey }) {
      const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${input.receiptId}`);
      if (!receipt) throw new Error('receipt not found');
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
      };
      const effect = await store.createEffect(db, {
        runId: run.id, stepKey, effectType: 'local_record_write', provider: 'sqlite',
        operation: 'accounting_receipt.annotate', idempotencyKey: `${run.id}:sqlite:accounting_receipt.annotate`,
        request, target: { receiptId: input.receiptId },
      });
      await db.query(sql`UPDATE accounting_receipts SET vendor=${request.vendor},
        transaction_date=${request.transactionDate}, currency=${request.currency}, amount=${request.amount},
        extraction_json=${JSON.stringify({ source: 'channel_member', actorUserId: run.actor_user_id })},
        status='extracted', workflow_run_id=${run.id}, updated_at=datetime('now')
        WHERE id=${input.receiptId}`);
      const [readback] = await db.query(sql`SELECT id, vendor, transaction_date, currency, amount, status
        FROM accounting_receipts WHERE id=${input.receiptId}`);
      if (!readback || Number(readback.amount) !== request.amount || readback.currency !== request.currency) {
        throw new Error('receipt annotation readback mismatch');
      }
      const evidence = await store.createEvidence(db, {
        runId: run.id, stepKey, source: 'sqlite.accounting_receipts', sourceRef: input.receiptId, payload: readback,
      });
      await store.transitionEffect(db, {
        effectId: effect.id, providerRef: input.receiptId, status: 'verified_by_readback',
        providerStatus: 'annotation_readback_verified', response: { evidenceId: evidence.id },
      });
      return { receiptId: input.receiptId, effectId: effect.id, evidenceId: evidence.id, receiptStatus: readback.status };
    },
  }],
  output({ state }) { return { ...state.write_annotation, status: 'verified_by_readback' }; },
};

const receiptReconcile = {
  name: 'receipt.reconcile',
  version: 1,
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
      const summary = { examined: receipts.length, matched: 0, ambiguous: 0, unmatched: 0 };
      for (const receipt of receipts) {
        const candidates = await db.query(sql`SELECT id, source_key, transaction_date, currency, amount,
          category_key, classification_tier FROM accounting_bank_transactions
          WHERE currency=${receipt.currency}
            AND ABS(amount-${Number(receipt.amount)}) <= ${receipt.currency === 'MXN' ? 1 : 0.01}
            AND ABS(julianday(transaction_date)-julianday(${receipt.transaction_date})) <= 3
          ORDER BY transaction_date, id`);
        if (candidates.length === 1) {
          const candidate = candidates[0];
          const reconciliationId = crypto.randomUUID();
          await db.query(sql`INSERT INTO accounting_reconciliations (
              id, receipt_id, bank_reference, status, confidence, evidence_json, workflow_run_id
            ) VALUES (
              ${reconciliationId}, ${receipt.id}, ${candidate.source_key}, 'matched', 1,
              ${JSON.stringify({ rule: 'unique_amount_currency_date_window', bankTransactionId: candidate.id })}, ${run.id}
            ) ON CONFLICT(receipt_id, bank_provider, bank_reference) DO UPDATE SET
              status='matched', confidence=1, evidence_json=excluded.evidence_json,
              workflow_run_id=excluded.workflow_run_id, updated_at=datetime('now')`);
          await db.query(sql`UPDATE accounting_receipts SET status='matched', updated_at=datetime('now') WHERE id=${receipt.id}`);
          summary.matched += 1;
        } else if (candidates.length > 1) {
          await db.query(sql`UPDATE accounting_receipts SET status='needs_review', updated_at=datetime('now') WHERE id=${receipt.id}`);
          summary.ambiguous += 1;
        } else {
          summary.unmatched += 1;
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
  guestReplyDraft,
  receiptAnnotate,
  receiptIngest,
  receiptReconcile,
  socialContentUpsert,
  validateGuestDraft,
  validateReceiptAnnotation,
  validateReceipt,
  validateSocialContent,
};
