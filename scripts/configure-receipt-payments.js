#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib/runtime-paths');
const { validateAccountingConfig } = require('../crm/lib/accounting-config');

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

function configuration(args = process.argv.slice(2)) {
  const approverUserIds = [...new Set(options(args, '--payment-approver-id'))];
  if (!approverUserIds.length || approverUserIds.some(userId => !/^U[A-Z0-9]+$/.test(userId))) {
    throw new Error('at least one valid --payment-approver-id is required');
  }
  return {
    approverUserIds,
    accountingPath: path.resolve(option(args, '--accounting-config', path.join(ROOT, 'accounting', 'config.json'))),
    backupDirectory: path.resolve(option(args, '--backup-dir', path.join(ROOT, 'runtime', 'config-backups'))),
    confirmProduction: args.includes('--confirm-production'),
  };
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function configure(args = process.argv.slice(2)) {
  const config = configuration(args);
  const current = JSON.parse(fs.readFileSync(config.accountingPath, 'utf8'));
  const next = structuredClone(current);
  next.receipt_payment = { ...(next.receipt_payment || {}), approver_user_ids: config.approverUserIds };
  validateAccountingConfig(next);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (!config.confirmProduction || !changed) {
    return {
      ok: true,
      mode: config.confirmProduction ? 'unchanged' : 'dry-run',
      changed,
      approverUserIds: config.approverUserIds,
    };
  }
  fs.mkdirSync(config.backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(config.backupDirectory, `accounting-config.${stamp}.bak`);
  fs.copyFileSync(config.accountingPath, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  try {
    writeAtomic(config.accountingPath, next);
  } catch (error) {
    fs.copyFileSync(backup, config.accountingPath);
    throw error;
  }
  return { ok: true, mode: 'production', changed: true, approverUserIds: config.approverUserIds, backup };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(configure()));
  } catch (error) {
    console.error(`[configure-receipt-payments] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { configuration, configure, writeAtomic };
