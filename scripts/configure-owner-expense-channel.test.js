'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configure } = require('./configure-owner-expense-channel');

function fixture(directory) {
  const accountingPath = path.join(directory, 'accounting.json');
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(accountingPath, JSON.stringify({
    qbo_accounts: { expenses: { maintenance: { id: '10', name: 'Maintenance' } } },
    receipt_channels: {},
  }));
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1, shadow_mode: true, live_workflows: [], autonomous_workflows: [], always_on_effects: [],
    channels: {}, restricted_capabilities: {}, write_notifications: { user_ids: [], channel_ids: [] },
  }));
  return { accountingPath, policyPath };
}

function args(directory, confirm = false) {
  const { accountingPath, policyPath } = fixture(directory);
  return [
    '--channel-id', 'C123OWNER', '--channel-name', 'receipt-owner',
    '--owner-name', 'Test Owner', '--liability-account-id', '2100',
    '--liability-account-name', 'Due to Test Owner (Net)',
    '--repayment-bank-account-id', '1100', '--repayment-bank-account-name', 'Operating Bank',
    '--accounting-config', accountingPath, '--workflow-policy', policyPath,
    '--backup-dir', path.join(directory, 'backups'),
    ...(confirm ? ['--confirm-production'] : []),
  ];
}

test('owner expense configurator is dry-run by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-config-dry-'));
  try {
    const commandArgs = args(directory);
    const accountingPath = commandArgs[commandArgs.indexOf('--accounting-config') + 1];
    const before = fs.readFileSync(accountingPath, 'utf8');
    const result = configure(commandArgs);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(accountingPath, 'utf8'), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner expense configurator atomically registers both runtime configs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-config-live-'));
  try {
    const commandArgs = args(directory, true);
    const result = configure(commandArgs);
    const accounting = JSON.parse(fs.readFileSync(commandArgs[commandArgs.indexOf('--accounting-config') + 1], 'utf8'));
    const policy = JSON.parse(fs.readFileSync(commandArgs[commandArgs.indexOf('--workflow-policy') + 1], 'utf8'));
    assert.equal(result.mode, 'production');
    assert.equal(accounting.owner_expense_channels.C123OWNER.owner_name, 'Test Owner');
    assert.equal(accounting.owner_expense_channels.C123OWNER.liability_account.id, '2100');
    assert.equal(accounting.owner_expense_channels.C123OWNER.repayment_bank_account.id, '1100');
    assert.ok(policy.channels.C123OWNER.capabilities.includes('qbo.owner_expense.write'));
    assert.ok(policy.live_workflows.includes('receipt.owner_expense.process'));
    assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
