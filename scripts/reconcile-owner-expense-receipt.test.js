'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  configuration,
  workflowInput,
} = require('./reconcile-owner-expense-receipt');

const RECEIPT_ID = '97633809-9d90-424a-842c-d63e4572b245';

function args(extra = []) {
  return [
    '--receipt-id', RECEIPT_ID,
    '--qbo-id', '2472',
    '--date', '2026-08-06',
    '--currency', 'MXN',
    '--amount', '4400',
    '--amount-usd', '255.37',
    '--fx-rate', '17.23',
    '--category-key', 'maintenance',
    '--vendor', 'Fidencio Lopez',
    '--description', 'Maintenance labor - 4 days',
    '--source-reference', '0670449961',
    ...extra,
  ];
}

test('owner expense reconciliation is dry-run unless production is explicit', () => {
  const dryRun = configuration(args());
  assert.equal(dryRun.confirmProduction, false);
  assert.deepEqual(workflowInput(dryRun), {
    receiptId: RECEIPT_ID,
    qboId: '2472',
    transactionKind: 'owner_paid_expense',
    transactionDate: '2026-08-06',
    currency: 'MXN',
    amount: 4400,
    amountUsd: 255.37,
    fxRate: 17.23,
    categoryKey: 'maintenance',
    vendor: 'Fidencio Lopez',
    description: 'Maintenance labor - 4 days',
    sourceReference: '0670449961',
  });
  assert.equal(configuration(args(['--confirm-production'])).confirmProduction, true);
});

test('owner expense reconciliation requires an exact source reference', () => {
  const withoutReference = args();
  withoutReference.splice(withoutReference.indexOf('--source-reference'), 2);
  assert.throws(() => configuration(withoutReference), /--source-reference is required/);
});
