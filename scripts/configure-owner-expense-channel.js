#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib/runtime-paths');
const { validateAccountingConfig } = require('../crm/lib/accounting-config');
const { validatePolicy } = require('../crm/lib/channel-policy');

const OWNER_WORKFLOWS = [
  'receipt.owner_expense.ingest',
  'receipt.owner_expense.process',
  'receipt.owner_expense.confirm',
];
const OWNER_CAPABILITY = 'qbo.owner_expense.write';

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
  const threshold = Number(option(args, '--auto-post-min-confidence', '0.9'));
  const config = {
    channelId: required(args, '--channel-id'),
    channelName: required(args, '--channel-name').replace(/^#/, ''),
    ownerName: required(args, '--owner-name'),
    liabilityAccountId: required(args, '--liability-account-id'),
    liabilityAccountName: required(args, '--liability-account-name'),
    threshold,
    accountingPath: path.resolve(option(args, '--accounting-config', path.join(ROOT, 'accounting', 'config.json'))),
    policyPath: path.resolve(option(args, '--workflow-policy', path.join(ROOT, 'workflow', 'policy.json'))),
    backupDirectory: path.resolve(option(args, '--backup-dir', path.join(ROOT, 'runtime', 'config-backups'))),
    confirmProduction: args.includes('--confirm-production'),
  };
  if (!/^[A-Z][A-Z0-9]+$/.test(config.channelId)) throw new Error('invalid --channel-id');
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(config.channelName)) throw new Error('invalid --channel-name');
  if (!config.ownerName.trim()) throw new Error('invalid --owner-name');
  if (!/^\d+$/.test(config.liabilityAccountId)) throw new Error('invalid --liability-account-id');
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) throw new Error('invalid confidence threshold');
  return config;
}

function nextConfigs(accounting, policy, config) {
  const nextAccounting = structuredClone(accounting);
  nextAccounting.receipt_channels ||= {};
  nextAccounting.receipt_channels[config.channelId] = {
    name: `#${config.channelName}`,
    scope: config.channelName.replace(/^receipts?-/, ''),
    description: `${config.ownerName} owner-paid business receipts and invoices`,
    people: [],
  };
  nextAccounting.owner_expense_channels ||= {};
  nextAccounting.owner_expense_channels[config.channelId] = {
    name: `#${config.channelName}`,
    owner_name: config.ownerName,
    liability_account: {
      id: config.liabilityAccountId,
      name: config.liabilityAccountName,
    },
    auto_post_min_confidence: config.threshold,
  };

  const nextPolicy = structuredClone(policy);
  nextPolicy.channels ||= {};
  const existing = nextPolicy.channels[config.channelId] || { name: config.channelName, capabilities: [] };
  nextPolicy.channels[config.channelId] = {
    ...existing,
    name: config.channelName,
    capabilities: [...new Set([
      ...(Array.isArray(existing.capabilities) ? existing.capabilities : []),
      'receipts.submit',
      'receipts.write',
      'accounting.read_scoped',
      OWNER_CAPABILITY,
    ])],
  };
  nextPolicy.live_workflows = [...new Set([...(nextPolicy.live_workflows || []), ...OWNER_WORKFLOWS])];
  validateAccountingConfig(nextAccounting);
  validatePolicy(nextPolicy);
  return { accounting: nextAccounting, policy: nextPolicy };
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function backupFiles(files, directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return files.map(file => {
    const destination = path.join(directory, `${path.basename(path.dirname(file))}-${path.basename(file)}.${stamp}.bak`);
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    return destination;
  });
}

function configure(args = process.argv.slice(2)) {
  const config = configuration(args);
  const accounting = JSON.parse(fs.readFileSync(config.accountingPath, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(config.policyPath, 'utf8'));
  const next = nextConfigs(accounting, policy, config);
  const changed = JSON.stringify(accounting) !== JSON.stringify(next.accounting)
    || JSON.stringify(policy) !== JSON.stringify(next.policy);
  if (!config.confirmProduction || !changed) {
    return {
      ok: true,
      mode: config.confirmProduction ? 'unchanged' : 'dry-run',
      changed,
      channelId: config.channelId,
      channelName: `#${config.channelName}`,
      ownerName: config.ownerName,
      liabilityAccount: { id: config.liabilityAccountId, name: config.liabilityAccountName },
      workflows: OWNER_WORKFLOWS,
    };
  }

  const backups = backupFiles([config.accountingPath, config.policyPath], config.backupDirectory);
  try {
    writeAtomic(config.accountingPath, next.accounting);
    writeAtomic(config.policyPath, next.policy);
  } catch (error) {
    fs.copyFileSync(backups[0], config.accountingPath);
    fs.copyFileSync(backups[1], config.policyPath);
    throw error;
  }
  return {
    ok: true,
    mode: 'production',
    changed: true,
    channelId: config.channelId,
    channelName: `#${config.channelName}`,
    ownerName: config.ownerName,
    liabilityAccount: { id: config.liabilityAccountId, name: config.liabilityAccountName },
    workflows: OWNER_WORKFLOWS,
    backups,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(configure()));
  } catch (error) {
    console.error(`[configure-owner-expense-channel] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  OWNER_CAPABILITY,
  OWNER_WORKFLOWS,
  configuration,
  configure,
  nextConfigs,
  writeAtomic,
};
