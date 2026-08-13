#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib/runtime-paths');
const { validatePolicy } = require('../crm/lib/channel-policy');
const { approverIds, option } = require('./configure-email-replies');

const LIVE_WORKFLOWS = ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'];
const AUTONOMOUS_WORKFLOWS = ['email.message.observe'];

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function validateChannelId(value) {
  const channelId = String(value || '').trim();
  if (!/^[CG][A-Z0-9]{8,}$/.test(channelId)) throw new Error('valid Sarah email Slack channel id is required');
  return channelId;
}

function nextPolicy(policy, approvers, requestedChannelId) {
  const channelId = validateChannelId(requestedChannelId);
  const next = structuredClone(policy);
  next.channels ||= {};
  const named = Object.entries(next.channels).filter(([, channel]) => channel.name === 'sarah-email');
  if (named.some(([id]) => id !== channelId)) {
    throw new Error('workflow policy already binds sarah-email to a different channel id');
  }
  const occupied = next.channels[channelId];
  if (occupied && occupied.name !== 'sarah-email') {
    throw new Error(`Slack channel ${channelId} is already bound to ${occupied.name}`);
  }
  const users = [...new Set(approvers.filter(value => typeof value === 'string' && value.trim()))];
  if (!users.length) throw new Error('prospector allowed_approvers must contain at least one Slack user id');
  next.channels[channelId] = {
    name: 'sarah-email',
    capabilities: ['email.read', 'email.send', 'crm.read', 'crm.write'],
  };
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
  const channelId = option(args, '--channel-id', process.env.SARAH_EMAIL_SLACK_CHANNEL || '');
  const confirmProduction = args.includes('--confirm-production');
  const current = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const prospector = JSON.parse(fs.readFileSync(prospectorPath, 'utf8'));
  const next = nextPolicy(current, approverIds(prospector.allowed_approvers), channelId);
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
  const backup = path.join(backupDirectory, `workflow-policy.pre-sarah-email.${stamp}.json`);
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
    console.error(`[configure-sarah-email] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  AUTONOMOUS_WORKFLOWS,
  LIVE_WORKFLOWS,
  configure,
  nextPolicy,
  validateChannelId,
  writeAtomic,
};
