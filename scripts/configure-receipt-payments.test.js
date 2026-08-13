'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configure } = require('./configure-receipt-payments');

function fixture(directory, confirm = false) {
  const accountingPath = path.join(directory, 'accounting.json');
  fs.writeFileSync(accountingPath, JSON.stringify({
    qbo_accounts: { expenses: { maintenance: { id: '10', name: 'Maintenance' } } },
  }));
  return [
    '--payment-approver-id', 'U123MAYELA',
    '--accounting-config', accountingPath,
    '--backup-dir', path.join(directory, 'backups'),
    ...(confirm ? ['--confirm-production'] : []),
  ];
}

test('receipt payment approver configuration is dry-run by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-payments-dry-'));
  try {
    const args = fixture(directory);
    const file = args[args.indexOf('--accounting-config') + 1];
    const before = fs.readFileSync(file, 'utf8');
    const result = configure(args);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('receipt payment approver configuration is backed up and written atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-payments-live-'));
  try {
    const args = fixture(directory, true);
    const result = configure(args);
    const file = args[args.indexOf('--accounting-config') + 1];
    const accounting = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(result.mode, 'production');
    assert.deepEqual(accounting.receipt_payment.approver_user_ids, ['U123MAYELA']);
    assert.equal(fs.existsSync(result.backup), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
