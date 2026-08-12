#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib/runtime-paths');
const { validatePolicy } = require('../crm/lib/channel-policy');

const LIVE_WORKFLOWS = [
  'marketing.change.confirm',
  'meta.campaign.autonomous',
  'marketing.report.daily',
  'meta.audience.sync',
];
const AUTONOMOUS_WORKFLOWS = [
  'meta.campaign.autonomous',
  'marketing.report.daily',
  'meta.audience.sync',
];

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

function nextPolicy(policy) {
  const next = structuredClone(policy);
  const social = Object.entries(next.channels || {}).filter(([, channel]) => channel.name === 'social-sol');
  if (social.length !== 1) throw new Error('workflow policy must contain exactly one social-sol channel');
  const [channelId, channel] = social[0];
  const approvers = Array.isArray(next.write_notifications?.user_ids)
    ? next.write_notifications.user_ids.filter(value => typeof value === 'string' && value.trim())
    : [];
  if (!approvers.length) {
    throw new Error('write_notifications.user_ids must contain the paid-media approver allowlist');
  }
  channel.capabilities = [...new Set([
    ...(Array.isArray(channel.capabilities) ? channel.capabilities : []),
    'marketing.read',
    'marketing.write',
  ])];
  next.restricted_capabilities ||= {};
  next.restricted_capabilities['marketing.write'] = { users: [...new Set(approvers)] };
  next.live_workflows = [...new Set([...(next.live_workflows || []), ...LIVE_WORKFLOWS])];
  next.autonomous_workflows = [...new Set([...(next.autonomous_workflows || []), ...AUTONOMOUS_WORKFLOWS])];
  validatePolicy(next);
  return { policy: next, channelId, approvers };
}

function configure(args = process.argv.slice(2)) {
  const policyPath = path.resolve(option(args, '--workflow-policy', path.join(ROOT, 'workflow', 'policy.json')));
  const backupDirectory = path.resolve(option(args, '--backup-dir', path.join(ROOT, 'runtime', 'config-backups')));
  const confirmProduction = args.includes('--confirm-production');
  const current = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const next = nextPolicy(current);
  const changed = JSON.stringify(current) !== JSON.stringify(next.policy);
  if (!confirmProduction || !changed) {
    return {
      ok: true,
      mode: confirmProduction ? 'unchanged' : 'dry-run',
      changed,
      channelId: next.channelId,
      approverCount: next.approvers.length,
      liveWorkflows: LIVE_WORKFLOWS,
      autonomousWorkflows: AUTONOMOUS_WORKFLOWS,
    };
  }
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDirectory, `workflow-policy.pre-social-autonomy.${stamp}.json`);
  fs.copyFileSync(policyPath, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  try {
    writeAtomic(policyPath, next.policy);
  } catch (error) {
    fs.copyFileSync(backup, policyPath);
    throw error;
  }
  return {
    ok: true,
    mode: 'production',
    changed: true,
    channelId: next.channelId,
    approverCount: next.approvers.length,
    liveWorkflows: LIVE_WORKFLOWS,
    autonomousWorkflows: AUTONOMOUS_WORKFLOWS,
    backup,
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(configure())); } catch (error) {
    console.error(`[configure-social-autonomy] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { AUTONOMOUS_WORKFLOWS, LIVE_WORKFLOWS, configure, nextPolicy, writeAtomic };
