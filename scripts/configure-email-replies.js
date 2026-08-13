#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib/runtime-paths');
const { validatePolicy } = require('../crm/lib/channel-policy');

const LIVE_WORKFLOWS = ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'];
const AUTONOMOUS_WORKFLOWS = ['email.message.observe'];

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function approverIds(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function nextPolicy(policy, approvers) {
  const next = structuredClone(policy);
  const matches = Object.entries(next.channels || {})
    .filter(([, channel]) => channel.name === 'prospector-paulina');
  if (matches.length !== 1) throw new Error('workflow policy must contain exactly one prospector-paulina channel');
  const [channelId, channel] = matches[0];
  const users = [...new Set(approvers.filter(value => typeof value === 'string' && value.trim()))];
  if (!users.length) throw new Error('prospector allowed_approvers must contain at least one Slack user id');
  channel.capabilities = [...new Set([...(channel.capabilities || []), 'email.read', 'email.send'])];
  next.restricted_capabilities ||= {};
  next.restricted_capabilities['email.send'] = { users };
  next.live_workflows = [...new Set([...(next.live_workflows || []), ...LIVE_WORKFLOWS])];
  next.autonomous_workflows = [...new Set([...(next.autonomous_workflows || []), ...AUTONOMOUS_WORKFLOWS])];
  validatePolicy(next);
  return { policy: next, channelId, approvers: users };
}

function configure(args = process.argv.slice(2)) {
  const policyPath = path.resolve(option(args, '--workflow-policy', path.join(ROOT, 'workflow', 'policy.json')));
  const prospectorPath = path.resolve(option(args, '--prospector-config', path.join(ROOT, 'prospector', 'config.json')));
  const backupDirectory = path.resolve(option(args, '--backup-dir', path.join(ROOT, 'runtime', 'config-backups')));
  const confirmProduction = args.includes('--confirm-production');
  const current = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const prospector = JSON.parse(fs.readFileSync(prospectorPath, 'utf8'));
  const next = nextPolicy(current, approverIds(prospector.allowed_approvers));
  const changed = JSON.stringify(current) !== JSON.stringify(next.policy);
  if (!confirmProduction || !changed) {
    return {
      ok: true, mode: confirmProduction ? 'unchanged' : 'dry-run', changed,
      channelId: next.channelId, approverCount: next.approvers.length,
      liveWorkflows: LIVE_WORKFLOWS, autonomousWorkflows: AUTONOMOUS_WORKFLOWS,
    };
  }
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDirectory, `workflow-policy.pre-email-replies.${stamp}.json`);
  fs.copyFileSync(policyPath, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  try { writeAtomic(policyPath, next.policy); } catch (error) {
    fs.copyFileSync(backup, policyPath);
    throw error;
  }
  return {
    ok: true, mode: 'production', changed: true, channelId: next.channelId,
    approverCount: next.approvers.length, liveWorkflows: LIVE_WORKFLOWS,
    autonomousWorkflows: AUTONOMOUS_WORKFLOWS, backup,
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(configure())); } catch (error) {
    console.error(`[configure-email-replies] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { AUTONOMOUS_WORKFLOWS, LIVE_WORKFLOWS, approverIds, configure, nextPolicy, option, writeAtomic };
