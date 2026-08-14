#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib/runtime-paths');
const { validateAccountingConfig } = require('../crm/lib/accounting-config');
const { validatePolicy } = require('../crm/lib/channel-policy');

const RECEIPT_WORKFLOWS = [
  'receipt.ingest', 'receipt.process', 'receipt.payment_source.select',
  'receipt.annotate', 'receipt.reconcile',
];
const RECEIPT_CAPABILITIES = ['receipts.submit', 'receipts.write', 'accounting.read_scoped'];

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuration(args = process.argv.slice(2)) {
  const config = {
    channelId: required(args, '--channel-id'),
    channelName: required(args, '--channel-name').replace(/^#/, ''),
    scope: required(args, '--scope'),
    description: required(args, '--description'),
    people: [...new Set(options(args, '--person-id'))],
    accountingPath: path.resolve(option(args, '--accounting-config', path.join(ROOT, 'accounting', 'config.json'))),
    policyPath: path.resolve(option(args, '--workflow-policy', path.join(ROOT, 'workflow', 'policy.json'))),
    backupDirectory: path.resolve(option(args, '--backup-dir', path.join(ROOT, 'runtime', 'config-backups'))),
    confirmProduction: args.includes('--confirm-production'),
  };
  if (!/^C[A-Z0-9]+$/.test(config.channelId)) throw new Error('invalid --channel-id');
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(config.channelName)) throw new Error('invalid --channel-name');
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(config.scope)) throw new Error('invalid --scope');
  if (!config.description.trim() || config.description.length > 500) throw new Error('invalid --description');
  if (config.people.some(userId => !/^U[A-Z0-9]+$/.test(userId))) throw new Error('invalid --person-id');
  return config;
}

function nextConfigs(accounting, policy, config) {
  const nextAccounting = structuredClone(accounting);
  nextAccounting.receipt_channels ||= {};
  const existingReceipt = nextAccounting.receipt_channels[config.channelId] || {};
  nextAccounting.receipt_channels[config.channelId] = {
    ...existingReceipt,
    name: `#${config.channelName}`,
    scope: config.scope,
    description: config.description.trim(),
    people: config.people,
  };

  const nextPolicy = structuredClone(policy);
  nextPolicy.channels ||= {};
  const existingChannel = nextPolicy.channels[config.channelId] || { capabilities: [] };
  nextPolicy.channels[config.channelId] = {
    ...existingChannel,
    name: config.channelName,
    capabilities: [...new Set([
      ...(Array.isArray(existingChannel.capabilities) ? existingChannel.capabilities : []),
      ...RECEIPT_CAPABILITIES,
    ])],
  };
  nextPolicy.live_workflows = [...new Set([...(nextPolicy.live_workflows || []), ...RECEIPT_WORKFLOWS])];
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
      scope: config.scope,
      people: config.people,
      workflows: RECEIPT_WORKFLOWS,
      capabilities: RECEIPT_CAPABILITIES,
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
    scope: config.scope,
    people: config.people,
    workflows: RECEIPT_WORKFLOWS,
    capabilities: RECEIPT_CAPABILITIES,
    backups,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(configure()));
  } catch (error) {
    console.error(`[configure-receipt-channel] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RECEIPT_CAPABILITIES,
  RECEIPT_WORKFLOWS,
  configuration,
  configure,
  nextConfigs,
  writeAtomic,
};
