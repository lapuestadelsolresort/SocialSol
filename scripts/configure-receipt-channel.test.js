'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configure } = require('./configure-receipt-channel');

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
    '--channel-id', 'C123RECEIPT', '--channel-name', 'receipts-pettycash',
    '--scope', 'sergio', '--description', 'Sergio petty cash receipts and invoices',
    '--person-id', 'U123SERGIO', '--person-id', 'U123MAYELA',
    '--accounting-config', accountingPath, '--workflow-policy', policyPath,
    '--backup-dir', path.join(directory, 'backups'),
    ...(confirm ? ['--confirm-production'] : []),
  ];
}

test('receipt channel configurator is dry-run by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-config-dry-'));
  try {
    const commandArgs = args(directory);
    const accountingPath = commandArgs[commandArgs.indexOf('--accounting-config') + 1];
    const before = fs.readFileSync(accountingPath, 'utf8');
    const result = configure(commandArgs);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.changed, true);
    assert.deepEqual(result.people, ['U123SERGIO', 'U123MAYELA']);
    assert.equal(fs.readFileSync(accountingPath, 'utf8'), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('receipt channel configurator atomically registers accounting and workflow policy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-config-live-'));
  try {
    const commandArgs = args(directory, true);
    const result = configure(commandArgs);
    const accounting = JSON.parse(fs.readFileSync(commandArgs[commandArgs.indexOf('--accounting-config') + 1], 'utf8'));
    const policy = JSON.parse(fs.readFileSync(commandArgs[commandArgs.indexOf('--workflow-policy') + 1], 'utf8'));
    assert.equal(result.mode, 'production');
    assert.deepEqual(accounting.receipt_channels.C123RECEIPT, {
      name: '#receipts-pettycash', scope: 'sergio',
      description: 'Sergio petty cash receipts and invoices',
      people: ['U123SERGIO', 'U123MAYELA'],
    });
    assert.deepEqual(policy.channels.C123RECEIPT, {
      name: 'receipts-pettycash',
      capabilities: ['receipts.submit', 'receipts.write', 'accounting.read_scoped'],
    });
    assert.ok(policy.live_workflows.includes('receipt.ingest'));
    assert.ok(policy.live_workflows.includes('receipt.process'));
    assert.ok(policy.live_workflows.includes('receipt.payment_source.select'));
    assert.ok(policy.live_workflows.includes('receipt.annotate'));
    assert.ok(policy.live_workflows.includes('receipt.reconcile'));
    assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
