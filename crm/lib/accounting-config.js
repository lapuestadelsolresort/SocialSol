'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');

const DEFAULT_ACCOUNTING_CONFIG_PATH = path.join(ROOT, 'accounting', 'config.json');

let cached = null;
let cachedPath = null;
let cachedMtime = -1;

function accountingConfigPath() {
  return path.resolve(process.env.ACCOUNTING_CONFIG_PATH || DEFAULT_ACCOUNTING_CONFIG_PATH);
}

function validateOwnerExpenseProfile(channelId, profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`owner expense profile is invalid for ${channelId}`);
  }
  const liability = profile.liability_account;
  const repaymentBank = profile.repayment_bank_account;
  if (
    typeof profile.owner_name !== 'string' || !profile.owner_name.trim()
    || !liability || typeof liability !== 'object'
    || typeof liability.id !== 'string' || !liability.id.trim()
    || typeof liability.name !== 'string' || !liability.name.trim()
    || !repaymentBank || typeof repaymentBank !== 'object'
    || typeof repaymentBank.id !== 'string' || !repaymentBank.id.trim()
    || typeof repaymentBank.name !== 'string' || !repaymentBank.name.trim()
  ) {
    throw new Error(`owner expense profile is incomplete for ${channelId}`);
  }
  const threshold = Number(profile.auto_post_min_confidence ?? 0.9);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new Error(`owner expense confidence threshold is invalid for ${channelId}`);
  }
  return {
    ...profile,
    owner_name: profile.owner_name.trim(),
    liability_account: {
      ...liability,
      id: liability.id.trim(),
      name: liability.name.trim(),
    },
    repayment_bank_account: {
      ...repaymentBank,
      id: repaymentBank.id.trim(),
      name: repaymentBank.name.trim(),
    },
    auto_post_min_confidence: threshold,
  };
}

function validateAccountingConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('accounting config must be an object');
  }
  const expenses = config.qbo_accounts?.expenses;
  if (!expenses || typeof expenses !== 'object' || Array.isArray(expenses)) {
    throw new Error('accounting config must define qbo_accounts.expenses');
  }
  for (const [key, account] of Object.entries(expenses)) {
    if (!account || typeof account.id !== 'string' || !account.id || typeof account.name !== 'string' || !account.name) {
      throw new Error(`QBO expense account is invalid: ${key}`);
    }
  }
  for (const [channelId, profile] of Object.entries(config.owner_expense_channels || {})) {
    validateOwnerExpenseProfile(channelId, profile);
  }
  return config;
}

function loadAccountingConfig({ fresh = false } = {}) {
  const file = accountingConfigPath();
  const stat = fs.statSync(file);
  if (!fresh && cached && cachedPath === file && cachedMtime === stat.mtimeMs) return cached;
  const parsed = validateAccountingConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  cached = parsed;
  cachedPath = file;
  cachedMtime = stat.mtimeMs;
  return parsed;
}

function ownerExpenseProfile(channelId, options = {}) {
  const config = loadAccountingConfig(options);
  const profile = config.owner_expense_channels?.[channelId];
  return profile ? validateOwnerExpenseProfile(channelId, profile) : null;
}

function expenseAccount(categoryKey, options = {}) {
  const config = loadAccountingConfig(options);
  return config.qbo_accounts.expenses[String(categoryKey || '')] || null;
}

function expenseAccountChoices(options = {}) {
  const config = loadAccountingConfig(options);
  return Object.entries(config.qbo_accounts.expenses)
    .map(([key, account]) => ({ key, id: String(account.id), name: String(account.name) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

module.exports = {
  DEFAULT_ACCOUNTING_CONFIG_PATH,
  accountingConfigPath,
  expenseAccount,
  expenseAccountChoices,
  loadAccountingConfig,
  ownerExpenseProfile,
  validateAccountingConfig,
  validateOwnerExpenseProfile,
};
