'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { loadPolicy } = require('../lib/channel-policy');
const { ownerExpenseProfile, expenseAccount } = require('../lib/accounting-config');
const { policySnapshot } = require('../lib/workflow-execution-policy');
const { pythonCommand } = require('../lib/workflow-command');
const { lastJsonValue } = require('./durable-job');

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value) {
  const text = String(value || '');
  if (!DATE_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text;
}

function validateReceiptId(input) {
  if (!UUID_PATTERN.test(String(input?.receiptId || ''))) throw new Error('valid receiptId is required');
}

function validateIngest(input) {
  if (!input || typeof input !== 'object') throw new Error('owner expense input is required');
  if (!/^\d+(?:\.\d+)?$/.test(String(input.slackMessageId || ''))) {
    throw new Error('trusted Slack message timestamp is required');
  }
}

function validateConfirmation(input) {
  validateReceiptId(input);
  if (!validIsoDate(input.transactionDate)) throw new Error('transactionDate must be a valid YYYY-MM-DD date');
  if (!['MXN', 'USD'].includes(String(input.currency || '').toUpperCase())) throw new Error('currency must be MXN or USD');
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('positive amount is required');
  if (!/^[a-z0-9_]{1,80}$/.test(String(input.categoryKey || ''))) throw new Error('valid categoryKey is required');
  if (!String(input.vendor || '').trim()) throw new Error('vendor is required');
}

function parseFiles(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function profileForRun(run) {
  const profile = ownerExpenseProfile(run.channel_id, { fresh: true });
  if (!profile) {
    const error = new Error(`owner expense channel is not configured: ${run.channel_id}`);
    error.code = 'owner_expense_channel_unconfigured';
    throw error;
  }
  return profile;
}

function expenseForKey(categoryKey) {
  const account = expenseAccount(categoryKey, { fresh: true });
  if (!account) {
    const error = new Error(`unknown owner expense category: ${categoryKey || '<missing>'}`);
    error.code = 'owner_expense_category_invalid';
    throw error;
  }
  return { id: String(account.id), name: String(account.name) };
}

function qboArguments(receipt, profile, account, {
  qboId = null, verifyOnly = false, amountUsd = null, fxRate = null,
} = {}) {
  const args = [
    '--receipt-id', receipt.id,
    '--date', receipt.transaction_date,
    '--amount', String(receipt.amount),
    '--currency', receipt.currency,
    '--expense-account-id', account.id,
    '--liability-account-id', profile.liability_account.id,
    '--liability-account-name', profile.liability_account.name,
    '--owner-name', profile.owner_name,
    '--vendor', receipt.vendor || '',
    '--description', receipt.description || '',
    '--json',
  ];
  if (verifyOnly) {
    args.push('--verify-only', '--qbo-id', qboId);
    if (Number.isFinite(Number(amountUsd)) && Number(amountUsd) > 0) {
      args.push('--expected-amount-usd', String(amountUsd));
    }
    if (fxRate !== null && fxRate !== undefined) args.push('--expected-fx-rate', String(fxRate));
  }
  else args.push('--live');
  return args;
}

function reviewReasons(result, profile) {
  if (!result?.ok) return [result?.reviewReason || 'receipt extraction was unavailable'];
  const value = result.extracted || {};
  const reasons = [];
  if (!value.vendor) reasons.push('vendor is missing');
  if (!validIsoDate(value.transaction_date)) reasons.push('transaction date is missing or invalid');
  if (!['MXN', 'USD'].includes(value.currency)) reasons.push('currency is missing');
  if (!Number.isFinite(Number(value.amount)) || Number(value.amount) <= 0) reasons.push('amount is missing');
  if (!value.description) reasons.push('description is missing');
  if (!value.category_key) reasons.push('expense category is ambiguous');
  if (value.is_business_expense !== true) reasons.push('the document does not clearly establish a business expense');
  if (value.paid_by_owner !== true) reasons.push(`the document does not clearly establish that ${profile.owner_name} paid personally`);
  if (Number(value.confidence) < profile.auto_post_min_confidence) {
    reasons.push(`extraction confidence ${Number(value.confidence || 0).toFixed(2)} is below ${profile.auto_post_min_confidence.toFixed(2)}`);
  }
  if (value.review_reason) reasons.push(String(value.review_reason));
  return [...new Set(reasons)];
}

function confirmationCommand(receipt) {
  const date = receipt.transaction_date || '<YYYY-MM-DD>';
  const currency = receipt.currency || '<MXN|USD>';
  const amount = receipt.amount || '<amount>';
  const category = receipt.category_key || '<category-key>';
  const vendor = receipt.vendor || '<vendor>';
  const description = receipt.description || '<description>';
  return `!receipt confirm ${receipt.id} ${date} ${currency} ${amount} ${category} | ${vendor} | ${description}`;
}

const processDefinition = {
  name: 'receipt.owner_expense.process',
  version: 1,
  capability: 'qbo.owner_expense.write',
  mutates: true,
  allowedTriggers: ['workflow'],
  validate: validateReceiptId,
  steps: [
    {
      key: 'load_receipt', effectClass: 'read', maxAttempts: 2,
      async run({ db, run, input }) {
        const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${input.receiptId}`);
        if (!receipt) throw new Error('owner expense receipt was not found');
        if (receipt.slack_channel_id !== run.channel_id) {
          const error = new Error('owner expense receipt belongs to another channel');
          error.code = 'receipt_scope_violation';
          throw error;
        }
        const profile = profileForRun(run);
        return {
          receipt,
          profile,
          alreadyPosted: Boolean(receipt.qbo_entity_id),
        };
      },
    },
    {
      key: 'extract', effectClass: 'external_read', maxAttempts: 2,
      async run({ input, state, services }) {
        if (state.load_receipt.alreadyPosted || input.skipExtraction === true) return { skipped: true };
        if (typeof services.extractOwnerExpense !== 'function') {
          return { ok: false, confidence: 0, reviewReason: 'owner expense extraction service is unavailable' };
        }
        try {
          return await services.extractOwnerExpense({
            messageText: state.load_receipt.receipt.message_text,
            files: parseFiles(state.load_receipt.receipt.file_refs_json),
            profile: state.load_receipt.profile,
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
      async run({ db, run, input, state, store, stepKey }) {
        const current = state.load_receipt.receipt;
        if (state.load_receipt.alreadyPosted) {
          return { receipt: current, shouldPost: false, alreadyPosted: true };
        }

        let receipt;
        let shouldPost;
        let reasons = [];
        if (input.skipExtraction === true) {
          expenseForKey(current.category_key);
          if (!validIsoDate(current.transaction_date)
            || !['MXN', 'USD'].includes(current.currency)
            || !Number.isFinite(Number(current.amount)) || Number(current.amount) <= 0
            || !current.vendor || !current.description) {
            throw new Error('confirmed owner expense fields are incomplete');
          }
          shouldPost = true;
        } else {
          const result = state.extract;
          const value = result?.ok ? result.extracted : {};
          reasons = reviewReasons(result, state.load_receipt.profile);
          shouldPost = reasons.length === 0;
          const category = value.category_key ? expenseForKey(value.category_key) : null;
          const reviewReason = reasons.join('; ').slice(0, 1000) || null;
          await db.query(sql`UPDATE accounting_receipts SET
            vendor=${value.vendor || null}, transaction_date=${value.transaction_date || null},
            currency=${value.currency || null}, amount=${value.amount || null},
            description=${value.description || null}, category_key=${value.category_key || null},
            category_name=${category?.name || null}, extraction_confidence=${Number(value.confidence || 0)},
            review_reason=${reviewReason}, extraction_json=${JSON.stringify({
              source: 'openai_responses', responseId: result?.responseId || null,
              model: result?.model || null, requestHash: result?.requestHash || null,
              extracted: result?.ok ? value : null, reviewReason: result?.reviewReason || null,
            })}, status=${shouldPost ? 'ready_to_post' : 'needs_review'},
            workflow_run_id=${run.id}, updated_at=datetime('now') WHERE id=${current.id}`);
        }
        if (input.skipExtraction === true) {
          await db.query(sql`UPDATE accounting_receipts SET status='ready_to_post', review_reason=NULL,
            workflow_run_id=${run.id}, updated_at=datetime('now') WHERE id=${current.id}`);
        }
        [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${current.id}`);
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: input.skipExtraction === true ? 'human.slack_confirmation' : 'openai.responses.structured_extraction',
          sourceRef: receipt.id,
          confidence: Number(receipt.extraction_confidence || 0),
          payload: {
            receiptId: receipt.id, status: receipt.status, vendor: receipt.vendor,
            transactionDate: receipt.transaction_date, currency: receipt.currency,
            amount: receipt.amount, description: receipt.description,
            categoryKey: receipt.category_key, reviewReason: receipt.review_reason,
          },
        });
        return { receipt, shouldPost, reasons, evidenceId: evidence.id };
      },
    },
    {
      key: 'register_qbo_effect', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        if (!state.persist_extraction.shouldPost) return { skipped: true };
        const receipt = state.persist_extraction.receipt;
        const profile = state.load_receipt.profile;
        const account = expenseForKey(receipt.category_key);
        const request = {
          receiptId: receipt.id,
          sourceHash: receipt.source_hash,
          transactionDate: receipt.transaction_date,
          amount: Number(receipt.amount),
          currency: receipt.currency,
          expenseAccount: account,
          liabilityAccount: profile.liability_account,
          ownerName: profile.owner_name,
          vendor: receipt.vendor,
          description: receipt.description,
        };
        const effect = await store.createEffect(db, {
          runId: run.id,
          stepKey,
          effectType: 'accounting_journal_entry',
          provider: 'quickbooks',
          operation: 'owner_expense.create_journal_entry',
          idempotencyKey: `receipt:${receipt.id}:qbo-owner-expense`,
          request,
          target: { entityType: 'JournalEntry', liabilityAccountId: profile.liability_account.id },
        });
        return { effectId: effect.id, effectStatus: effect.status, account };
      },
    },
    {
      key: 'write_qbo', effectClass: 'external_idempotent', maxAttempts: 3,
      async run({ db, state, services, store }) {
        if (state.register_qbo_effect.skipped) return { skipped: true };
        const [effect] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${state.register_qbo_effect.effectId}`);
        if (!effect) throw new Error('owner expense QBO effect was not found');
        if (effect.provider_ref && ['accepted_by_provider', 'verified_by_readback'].includes(effect.status)) {
          const response = store.parseJson(effect.response_json, {});
          return {
            effectId: effect.id, qboId: effect.provider_ref, status: effect.status, replayed: true,
            requestId: response.requestId || response.request_id || null,
            amountUsd: Number(response.amountUsd ?? response.amount_usd) || null,
            fxRate: response.fxRate ?? response.fx_rate ?? null,
          };
        }
        if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
        const receipt = state.persist_extraction.receipt;
        let result;
        try {
          result = await services.runCommand(pythonCommand(
            'accounting/owner_expense_qbo.py',
            qboArguments(receipt, state.load_receipt.profile, state.register_qbo_effect.account),
          ));
        } catch (error) {
          error.code = error.code || 'qbo_owner_expense_write_failed';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        const parsed = lastJsonValue(result.stdout);
        if (!parsed || parsed.status !== 'PUSHED' || parsed.verified_by_readback !== true || !parsed.qbo_id) {
          const error = new Error(parsed?.error || 'QBO owner expense command returned no verified JournalEntry');
          error.code = 'qbo_owner_expense_write_unverified';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        await store.transitionEffect(db, {
          effectId: effect.id,
          providerRef: String(parsed.qbo_id),
          status: 'accepted_by_provider',
          providerStatus: 'journal_entry_created',
          response: {
            qboEntityType: 'JournalEntry', qboId: String(parsed.qbo_id),
            requestId: parsed.request_id, amountUsd: parsed.amount_usd, fxRate: parsed.fx_rate,
          },
        });
        return {
          effectId: effect.id, qboId: String(parsed.qbo_id), requestId: parsed.request_id,
          amountUsd: Number(parsed.amount_usd), fxRate: parsed.fx_rate,
          status: 'accepted_by_provider', replayed: false,
        };
      },
    },
    {
      key: 'verify_qbo', effectClass: 'external_read', maxAttempts: 3,
      async run({ db, run, state, services, store, stepKey }) {
        if (state.write_qbo.skipped) return { skipped: true };
        if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
        const receipt = state.persist_extraction.receipt;
        let result;
        try {
          result = await services.runCommand(pythonCommand(
            'accounting/owner_expense_qbo.py',
            qboArguments(receipt, state.load_receipt.profile, state.register_qbo_effect.account, {
              qboId: state.write_qbo.qboId,
              verifyOnly: true,
              amountUsd: state.write_qbo.amountUsd,
              fxRate: state.write_qbo.fxRate,
            }),
          ));
        } catch (error) {
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        const parsed = lastJsonValue(result.stdout);
        if (!parsed || parsed.status !== 'VERIFIED' || parsed.verified_by_readback !== true) {
          const error = new Error(parsed?.error || 'QBO JournalEntry readback was not verified');
          error.code = 'qbo_owner_expense_readback_failed';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: 'quickbooks.journal_entry.readback',
          sourceRef: state.write_qbo.qboId,
          payload: parsed,
        });
        await store.transitionEffect(db, {
          effectId: state.register_qbo_effect.effectId,
          providerRef: state.write_qbo.qboId,
          status: 'verified_by_readback',
          providerStatus: 'journal_entry_lines_verified',
          response: { ...parsed, evidenceId: evidence.id },
        });
        return { ...parsed, evidenceId: evidence.id };
      },
    },
    {
      key: 'persist_qbo', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, state }) {
        if (state.verify_qbo.skipped) return { skipped: true };
        const receipt = state.persist_extraction.receipt;
        try {
          await db.query(sql`UPDATE accounting_receipts SET status='posted', amount_usd=${state.verify_qbo.amount_usd},
            fx_rate=${state.verify_qbo.fx_rate ?? null}, qbo_entity_type='JournalEntry',
            qbo_entity_id=${state.verify_qbo.qbo_id}, qbo_request_id=${state.verify_qbo.request_id},
            posted_at=datetime('now'), workflow_run_id=${run.id}, updated_at=datetime('now') WHERE id=${receipt.id}`);
          const [readback] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${receipt.id}`);
          if (!readback || readback.status !== 'posted' || String(readback.qbo_entity_id) !== String(state.verify_qbo.qbo_id)) {
            throw new Error('owner expense QBO projection readback mismatch');
          }
          return { receipt: readback };
        } catch (error) {
          error.code = error.code || 'owner_expense_projection_failed';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
      },
    },
    {
      key: 'notify', effectClass: 'internal_notification', maxAttempts: 2,
      async run({ db, run, state, store }) {
        const base = state.persist_qbo.receipt || state.persist_extraction.receipt;
        if (state.persist_extraction.alreadyPosted) return { skipped: true, status: 'posted' };
        let message;
        let status;
        if (state.persist_extraction.shouldPost) {
          const profile = state.load_receipt.profile;
          const original = `${Number(base.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${base.currency}`;
          message = [
            `✅ Posted ${profile.owner_name}'s owner-paid business expense to QuickBooks.`,
            `${base.vendor || 'Unknown vendor'} · ${base.transaction_date} · ${original}`,
            `Debit: ${base.category_name} · Credit: ${profile.liability_account.name}`,
            `QBO JournalEntry: ${base.qbo_entity_id} · USD ${Number(base.amount_usd).toFixed(2)}`,
            `Workflow: ${run.id} · Evidence: ${state.verify_qbo.evidenceId}`,
          ].join('\n');
          status = 'posted';
        } else {
          message = [
            '⚠️ Receipt saved, but nothing was posted to QuickBooks because review is required.',
            base.review_reason || 'The owner-paid business expense could not be verified confidently.',
            `Receipt: ${base.id}`,
            'Correct any placeholder and paste this command as a new message:',
            `\`${confirmationCommand(base)}\``,
            `Workflow: ${run.id} · Evidence: ${state.persist_extraction.evidenceId}`,
          ].join('\n');
          status = 'needs_review';
        }
        const outbox = await store.enqueueOutbox(db, {
          runId: run.id,
          topic: 'slack.notification',
          idempotencyKey: `${run.id}:owner-expense:${status}:slack`,
          payload: { channelId: run.channel_id, threadTs: base.slack_thread_ts || base.slack_message_id, message },
        });
        return { status, outboxId: outbox.id, receiptId: base.id };
      },
    },
  ],
  output({ state }) {
    return {
      status: state.notify.status,
      receiptId: state.notify.receiptId || state.load_receipt.receipt.id,
      effectId: state.register_qbo_effect.effectId || null,
      evidenceId: state.verify_qbo.evidenceId || state.persist_extraction.evidenceId || null,
      qboEntityType: state.verify_qbo.qbo_entity_type || null,
      qboId: state.verify_qbo.qbo_id || state.load_receipt.receipt.qbo_entity_id || null,
    };
  },
};

const ingestDefinition = {
  name: 'receipt.owner_expense.ingest',
  version: 1,
  capability: 'qbo.owner_expense.write',
  mutates: true,
  allowedTriggers: ['slack_receipt_hook'],
  validate: validateIngest,
  steps: [
    {
      key: 'fetch_source', effectClass: 'external_read', maxAttempts: 2,
      async run({ run, input, services }) {
        profileForRun(run);
        if (typeof services.fetchSlackReceipt !== 'function') throw new Error('Slack receipt source service is unavailable');
        return services.fetchSlackReceipt({
          channelId: run.channel_id, messageId: input.slackMessageId, threadTs: input.threadTs || null,
        });
      },
    },
    {
      key: 'persist_receipt', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, input, state, store, stepKey }) {
        const source = state.fetch_source;
        if (!source.shouldProcess) return { ignored: true, reason: 'no receipt attachment or receipt-like text' };
        const files = (source.files || []).map(file => ({
          id: String(file.id || '').slice(0, 160),
          name: String(file.name || '').slice(0, 300),
          mimetype: String(file.mimetype || '').slice(0, 160),
          size: Number(file.size) || null,
          sha256: String(file.sha256 || '').slice(0, 64),
          localPath: String(file.localPath || '').slice(0, 2000),
        }));
        const sourceHash = store.sha256({
          channelId: run.channel_id,
          messageId: input.slackMessageId,
          messageText: source.messageText || '',
          files: files.map(({ id, name, mimetype, size, sha256 }) => ({ id, name, mimetype, size, sha256 })),
        });
        const id = crypto.randomUUID();
        await db.query(sql`INSERT OR IGNORE INTO accounting_receipts (
          id, slack_channel_id, slack_message_id, slack_thread_ts, submitted_by, submitted_at,
          message_text, file_refs_json, source_hash, status, workflow_run_id
        ) VALUES (
          ${id}, ${run.channel_id}, ${input.slackMessageId}, ${input.threadTs || input.slackMessageId},
          ${run.actor_user_id}, ${source.submittedAt || input.submittedAt || new Date().toISOString()},
          ${String(source.messageText || '')}, ${JSON.stringify(files)}, ${sourceHash}, 'received', ${run.id}
        )`);
        const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts
          WHERE slack_channel_id=${run.channel_id} AND slack_message_id=${input.slackMessageId}`);
        if (!receipt || receipt.source_hash !== sourceHash) {
          const error = new Error('owner expense receipt readback mismatch');
          error.code = 'receipt_readback_mismatch';
          throw error;
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'slack.message.readback', sourceRef: input.slackMessageId,
          payload: { receiptId: receipt.id, sourceHash, fileCount: files.length },
        });
        return { receiptId: receipt.id, evidenceId: evidence.id, ignored: false };
      },
    },
    {
      key: 'acknowledge', effectClass: 'internal_notification', maxAttempts: 2,
      async run({ db, run, input, state, store }) {
        if (state.persist_receipt.ignored) return { skipped: true };
        const outbox = await store.enqueueOutbox(db, {
          runId: run.id,
          topic: 'slack.notification',
          idempotencyKey: `${run.id}:owner-expense:received:slack`,
          payload: {
            channelId: run.channel_id,
            threadTs: input.threadTs || input.slackMessageId,
            message: `🧾 Receipt received for ${profileForRun(run).owner_name}'s owner-expense ledger. I saved the original and queued extraction; I will reply here after QuickBooks readback or if review is needed. Receipt: ${state.persist_receipt.receiptId} · Workflow: ${run.id}`,
          },
        });
        return { outboxId: outbox.id };
      },
    },
    {
      key: 'queue_processing', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, state, store }) {
        if (state.persist_receipt.ignored) return { skipped: true, status: 'ignored' };
        const policy = loadPolicy({ fresh: true });
        const created = await store.createRun(db, {
          definition: processDefinition,
          idempotencyKey: `receipt:${state.persist_receipt.receiptId}:owner-expense:process:v1`,
          triggerType: 'workflow',
          triggerRef: run.id,
          channelId: run.channel_id,
          actorUserId: run.actor_user_id,
          input: { receiptId: state.persist_receipt.receiptId },
          policySnapshot: policySnapshot(policy, processDefinition),
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

const confirmDefinition = {
  name: 'receipt.owner_expense.confirm',
  version: 1,
  capability: 'qbo.owner_expense.write',
  mutates: true,
  allowedTriggers: ['slack_receipt_confirm_command'],
  validate: validateConfirmation,
  steps: [
    {
      key: 'apply_confirmation', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, input, store, stepKey }) {
        const profile = profileForRun(run);
        const account = expenseForKey(input.categoryKey);
        const [receipt] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${input.receiptId}`);
        if (!receipt) throw new Error('owner expense receipt was not found');
        if (receipt.slack_channel_id !== run.channel_id) {
          const error = new Error('owner expense receipt belongs to another channel');
          error.code = 'receipt_scope_violation';
          throw error;
        }
        if (receipt.qbo_entity_id || receipt.status === 'posted') throw new Error('owner expense receipt is already posted');
        if (receipt.status !== 'needs_review') throw new Error('owner expense receipt is not awaiting review');
        const description = String(input.description || `${input.vendor} business expense`).trim().slice(0, 1000);
        const updated = await db.query(sql`UPDATE accounting_receipts SET vendor=${String(input.vendor).trim().slice(0, 300)},
          transaction_date=${input.transactionDate}, currency=${String(input.currency).toUpperCase()},
          amount=${Number(input.amount)}, description=${description}, category_key=${input.categoryKey},
          category_name=${account.name}, extraction_confidence=1, review_reason=NULL,
          extraction_json=${JSON.stringify({ source: 'slack_human_confirmation', actorUserId: run.actor_user_id,
            confirmedAt: new Date().toISOString(), ownerName: profile.owner_name })},
          status='ready_to_post', workflow_run_id=${run.id}, updated_at=datetime('now')
          WHERE id=${receipt.id} AND status='needs_review' RETURNING id`);
        if (!updated.length) throw new Error('owner expense receipt review was already claimed');
        const [readback] = await db.query(sql`SELECT * FROM accounting_receipts WHERE id=${receipt.id}`);
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'human.slack_confirmation', sourceRef: receipt.id,
          payload: { receiptId: receipt.id, transactionDate: readback.transaction_date,
            currency: readback.currency, amount: readback.amount, categoryKey: readback.category_key,
            vendor: readback.vendor, description: readback.description, actorUserId: run.actor_user_id },
        });
        return { receiptId: receipt.id, evidenceId: evidence.id };
      },
    },
    {
      key: 'queue_processing', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, input, state, store }) {
        const digest = store.sha256({
          transactionDate: input.transactionDate, currency: input.currency, amount: Number(input.amount),
          categoryKey: input.categoryKey, vendor: input.vendor, description: input.description || '',
        }).slice(0, 24);
        const policy = loadPolicy({ fresh: true });
        const created = await store.createRun(db, {
          definition: processDefinition,
          idempotencyKey: `receipt:${state.apply_confirmation.receiptId}:owner-expense:confirm:${digest}`,
          triggerType: 'workflow',
          triggerRef: run.id,
          channelId: run.channel_id,
          actorUserId: run.actor_user_id,
          input: { receiptId: state.apply_confirmation.receiptId, skipExtraction: true },
          policySnapshot: policySnapshot(policy, processDefinition),
        });
        return { processRunId: created.run.id, queued: created.created };
      },
    },
  ],
  output({ state }) {
    return {
      status: 'queued', receiptId: state.apply_confirmation.receiptId,
      evidenceId: state.apply_confirmation.evidenceId,
      processRunId: state.queue_processing.processRunId,
    };
  },
};

module.exports = {
  confirmDefinition,
  confirmationCommand,
  ingestDefinition,
  processDefinition,
  qboArguments,
  reviewReasons,
  validateConfirmation,
  validateIngest,
  validIsoDate,
};
