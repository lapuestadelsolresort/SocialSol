#!/usr/bin/env node
'use strict';

require('../lib/runtime-paths');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { DB_PATH } = require('../lib/runtime-paths');
const { ensureSchemaAsync } = require('../crm/lib/workflow-schema');
const { startGraph } = require('../crm/lib/workflow-engine');
const { policySnapshot } = require('../crm/lib/workflow-execution-policy');
const { loadPolicy } = require('../crm/lib/channel-policy');
const { runCommand } = require('../crm/lib/workflow-command');
const { getDefinition } = require('../crm/workflows/registry');

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuration(args = process.argv.slice(2)) {
  const transactionKind = option(args, '--transaction-kind', 'owner_paid_expense');
  const fxRaw = option(args, '--fx-rate');
  const config = {
    receiptId: required(args, '--receipt-id'),
    qboId: required(args, '--qbo-id'),
    transactionKind,
    transactionDate: required(args, '--date'),
    currency: required(args, '--currency').toUpperCase(),
    amount: Number(required(args, '--amount')),
    amountUsd: Number(required(args, '--amount-usd')),
    fxRate: fxRaw === null ? null : Number(fxRaw),
    categoryKey: transactionKind === 'owner_paid_expense' ? required(args, '--category-key') : null,
    vendor: required(args, '--vendor'),
    description: required(args, '--description'),
    sourceReference: required(args, '--source-reference'),
    confirmProduction: args.includes('--confirm-production'),
  };
  if (!/^[0-9a-f-]{36}$/i.test(config.receiptId)) throw new Error('invalid --receipt-id');
  if (!/^[A-Za-z0-9-]{1,80}$/.test(config.qboId)) throw new Error('invalid --qbo-id');
  if (!['owner_paid_expense', 'owner_repayment'].includes(config.transactionKind)) {
    throw new Error('invalid --transaction-kind');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.transactionDate)) throw new Error('invalid --date');
  if (!['MXN', 'USD'].includes(config.currency)) throw new Error('invalid --currency');
  if (!Number.isFinite(config.amount) || config.amount <= 0) throw new Error('invalid --amount');
  if (!Number.isFinite(config.amountUsd) || config.amountUsd <= 0) throw new Error('invalid --amount-usd');
  if (config.fxRate !== null && (!Number.isFinite(config.fxRate) || config.fxRate <= 0)) {
    throw new Error('invalid --fx-rate');
  }
  return config;
}

function workflowInput(config) {
  return {
    receiptId: config.receiptId,
    qboId: config.qboId,
    transactionKind: config.transactionKind,
    transactionDate: config.transactionDate,
    currency: config.currency,
    amount: config.amount,
    amountUsd: config.amountUsd,
    fxRate: config.fxRate,
    categoryKey: config.categoryKey,
    vendor: config.vendor,
    description: config.description,
    sourceReference: config.sourceReference,
  };
}

async function reconcile(args = process.argv.slice(2), options = {}) {
  const config = configuration(args);
  const definition = getDefinition('receipt.owner_expense.reconcile');
  if (!definition) throw new Error('owner expense reconciliation workflow is unavailable');
  const db = options.db || createDB(options.dbPath || DB_PATH);
  const ownsDb = !options.db;
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await ensureSchemaAsync(db, sql);
    const [receipt] = await db.query(sql`SELECT id, slack_channel_id, slack_message_id, status,
      qbo_entity_id, workflow_run_id FROM accounting_receipts WHERE id=${config.receiptId}`);
    if (!receipt) throw new Error('owner expense receipt was not found');
    if (receipt.qbo_entity_id || receipt.status === 'posted') {
      throw new Error(`owner expense receipt is already posted to QBO ${receipt.qbo_entity_id || '<unknown>'}`);
    }
    const input = workflowInput(config);
    if (typeof definition.validate === 'function') definition.validate(input);
    if (!config.confirmProduction) {
      return {
        ok: true,
        mode: 'dry-run',
        receiptId: receipt.id,
        currentStatus: receipt.status,
        qboId: config.qboId,
        transactionKind: config.transactionKind,
        amountUsd: config.amountUsd,
        sourceReference: config.sourceReference,
        action: 'verify the existing QBO entity by readback, then reconcile the durable receipt/effect/evidence records without creating a QBO transaction',
      };
    }
    const policy = loadPolicy({ fresh: true });
    const services = {
      runCommand: options.runCommand || runCommand,
      enforcePolicy: true,
      policyProvider: () => loadPolicy({ fresh: true }),
      workerId: `admin-reconcile:${process.pid}`,
    };
    const run = await startGraph(db, definition, {
      idempotencyKey: `admin:receipt:${receipt.id}:qbo-reconcile:${config.transactionKind}:${config.qboId}`,
      triggerType: 'admin_reconciliation',
      triggerRef: `qbo:${config.qboId}`,
      channelId: receipt.slack_channel_id,
      actorUserId: null,
      input,
      policySnapshot: policySnapshot(policy, definition),
    }, services);
    if (run.status !== 'completed' || run.output?.status !== 'posted'
      || run.output?.reconciledExisting !== true) {
      throw new Error(`owner expense reconciliation did not complete: ${run.error_message || run.status}`);
    }
    return {
      ok: true,
      mode: 'production',
      receiptId: run.output.receiptId,
      qboEntityType: run.output.qboEntityType,
      qboId: run.output.qboId,
      workflowId: run.id,
      effectId: run.output.effectId,
      evidenceId: run.output.evidenceId,
      reconciledExisting: true,
      qboTransactionCreated: false,
    };
  } finally {
    if (ownsDb) await db.dispose();
  }
}

if (require.main === module) {
  reconcile().then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error(`[reconcile-owner-expense-receipt] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { configuration, option, reconcile, required, workflowInput };
