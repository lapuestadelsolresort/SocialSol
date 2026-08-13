#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { ROOT } = require('../lib/runtime-paths');
const {
  heartbeatConfig,
  joinedChannels,
  mergeSoulMonitoringBlock,
  monitoredChannelConfig,
  soulMonitoringBlock,
} = require('../paloma/lib/monitoring-contract');

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function runOpenClaw(args, { binary = process.env.OPENCLAW_BIN || 'openclaw' } = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`openclaw ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function openClawJson(args, dependencies) {
  const output = (dependencies.runOpenClaw || runOpenClaw)(args, dependencies);
  try { return JSON.parse(output); } catch {
    throw new Error(`openclaw ${args[0]} did not return valid JSON`);
  }
}

function expandHome(file) {
  const value = String(file || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function writeAtomic(file, value) {
  const stat = fs.statSync(file);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: stat.mode & 0o777 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, stat.mode & 0o777);
}

function backupFile(source, directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(directory, `${label}.${stamp}.bak`);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  return destination;
}

function accountChannelPath(accountId, channelId) {
  return `channels.slack.accounts[${JSON.stringify(accountId)}].channels[${JSON.stringify(channelId)}]`;
}

function monitoringSettings(config, args) {
  const monitoring = config.monitoring || {};
  if (monitoring.enabled === false) throw new Error('Paloma monitoring is disabled in runtime config');
  return {
    accountId: option(args, '--account', process.env.PALOMA_SLACK_ACCOUNT || monitoring.slack_account),
    agentId: option(args, '--agent', process.env.PALOMA_AGENT_ID || monitoring.agent_id || 'paloma'),
    every: option(args, '--every', monitoring.heartbeat_every || '10m'),
    timeoutSeconds: Number(option(args, '--timeout-seconds', monitoring.timeout_seconds || 300)),
    lookbackMinutes: Number(option(args, '--lookback-minutes', monitoring.initial_lookback_minutes || 60)),
    trackerChannelId: config.channels?.tracker,
  };
}

function planMonitoring({ config, account, agents, groups, soul, root, settings }) {
  if (!account || account.enabled === false) throw new Error('Paloma Slack account is missing or disabled');
  const agentIndex = agents.findIndex(agent => agent.id === settings.agentId);
  if (agentIndex === -1) throw new Error(`OpenClaw agent ${settings.agentId} was not found`);
  const databasePath = path.join(root, 'paloma', 'data', 'tasks.db');
  const channelPlan = monitoredChannelConfig(account.channels, groups);
  if (!channelPlan.joined.length) throw new Error('Paloma Slack account is not a member of any active channels');
  const heartbeat = heartbeatConfig({
    accountId: settings.accountId,
    databasePath,
    trackerChannelId: settings.trackerChannelId,
    every: settings.every,
    timeoutSeconds: settings.timeoutSeconds,
    lookbackMinutes: settings.lookbackMinutes,
  });
  const block = soulMonitoringBlock({ accountId: settings.accountId, databasePath });
  const nextSoul = mergeSoulMonitoringBlock(soul, block);
  const changedChannelIds = channelPlan.joined
    .filter(channel => !isDeepStrictEqual(account.channels?.[channel.id] || {}, channelPlan.channels[channel.id]))
    .map(channel => channel.id);
  return {
    agentIndex,
    heartbeat,
    nextSoul,
    joined: channelPlan.joined,
    channels: channelPlan.channels,
    changedChannelIds,
    heartbeatChanged: !isDeepStrictEqual(agents[agentIndex].heartbeat || null, heartbeat),
    soulChanged: soul !== nextSoul,
    config,
  };
}

function configure(args = process.argv.slice(2), dependencies = {}) {
  const root = path.resolve(option(args, '--root', ROOT));
  const configPath = path.resolve(option(args, '--paloma-config', path.join(root, 'paloma', 'config.json')));
  const backupDirectory = path.resolve(option(args, '--backup-dir', path.join(root, 'runtime', 'config-backups')));
  const confirmProduction = args.includes('--confirm-production');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const settings = monitoringSettings(config, args);
  if (!settings.accountId) throw new Error('Paloma monitoring.slack_account or --account is required');

  const groups = openClawJson([
    'directory', 'groups', 'list', '--channel', 'slack', '--account', settings.accountId,
    '--json', '--limit', '500',
  ], dependencies);
  const account = openClawJson([
    'config', 'get', `channels.slack.accounts[${JSON.stringify(settings.accountId)}]`, '--json',
  ], dependencies);
  const agents = openClawJson(['config', 'get', 'agents.list', '--json'], dependencies);
  const agent = agents.find(candidate => candidate.id === settings.agentId);
  if (!agent?.workspace) throw new Error(`OpenClaw agent ${settings.agentId} has no workspace`);
  const soulPath = path.resolve(option(args, '--soul-path', path.join(expandHome(agent.workspace), 'SOUL.md')));
  const soul = fs.readFileSync(soulPath, 'utf8');
  const plan = planMonitoring({ config, account, agents, groups, soul, root, settings });
  const changed = plan.changedChannelIds.length > 0 || plan.heartbeatChanged || plan.soulChanged;
  const command = dependencies.runOpenClaw || runOpenClaw;
  const summary = {
    ok: true,
    mode: confirmProduction ? (changed ? 'production' : 'unchanged') : 'dry-run',
    changed,
    agentId: settings.agentId,
    accountId: settings.accountId,
    joinedChannelCount: plan.joined.length,
    joinedChannelNames: plan.joined.map(channel => channel.name),
    realtimeChannelUpdates: plan.changedChannelIds.length,
    heartbeatEvery: plan.heartbeat.every,
    heartbeatTarget: plan.heartbeat.target,
    heartbeatChanged: plan.heartbeatChanged,
    soulChanged: plan.soulChanged,
  };
  if (!confirmProduction) {
    for (const channelId of plan.changedChannelIds) {
      command([
        'config', 'set', accountChannelPath(settings.accountId, channelId),
        JSON.stringify(plan.channels[channelId]), '--strict-json', '--merge', '--dry-run',
      ], dependencies);
    }
    if (plan.heartbeatChanged) {
      command([
        'config', 'set', `agents.list[${plan.agentIndex}].heartbeat`,
        JSON.stringify(plan.heartbeat), '--strict-json', '--dry-run',
      ], dependencies);
    }
    return summary;
  }
  if (!changed) return summary;

  const openClawConfigPath = expandHome(command(['config', 'file'], dependencies));
  const configBackup = backupFile(openClawConfigPath, backupDirectory, 'openclaw.pre-paloma-monitoring');
  const soulBackup = backupFile(soulPath, backupDirectory, 'paloma-soul.pre-all-channel-monitoring');
  try {
    // Put the behavioral contract in place before widening real-time event delivery.
    if (plan.soulChanged) writeAtomic(soulPath, plan.nextSoul);
    for (const channelId of plan.changedChannelIds) {
      command([
        'config', 'set', accountChannelPath(settings.accountId, channelId),
        JSON.stringify(plan.channels[channelId]), '--strict-json', '--merge',
      ], dependencies);
    }
    if (plan.heartbeatChanged) {
      command([
        'config', 'set', `agents.list[${plan.agentIndex}].heartbeat`,
        JSON.stringify(plan.heartbeat), '--strict-json',
      ], dependencies);
    }

    const verifiedAccount = openClawJson([
      'config', 'get', `channels.slack.accounts[${JSON.stringify(settings.accountId)}]`, '--json',
    ], dependencies);
    const verifiedAgents = openClawJson(['config', 'get', 'agents.list', '--json'], dependencies);
    const verifiedHeartbeat = verifiedAgents[plan.agentIndex]?.heartbeat;
    for (const channel of plan.joined) {
      const policy = verifiedAccount.channels?.[channel.id];
      if (!policy?.enabled || policy.requireMention !== false) {
        throw new Error(`verification failed for joined Slack channel ${channel.name}`);
      }
    }
    if (!isDeepStrictEqual(verifiedHeartbeat, plan.heartbeat)) {
      throw new Error('verification failed for Paloma heartbeat configuration');
    }
    if (fs.readFileSync(soulPath, 'utf8') !== plan.nextSoul) {
      throw new Error('verification failed for Paloma SOUL monitoring contract');
    }
  } catch (error) {
    fs.copyFileSync(configBackup, openClawConfigPath);
    fs.copyFileSync(soulBackup, soulPath);
    throw new Error(`Paloma monitoring cutover rolled back: ${error.message}`);
  }
  return { ...summary, configBackup, soulBackup };
}

if (require.main === module) {
  try { console.log(JSON.stringify(configure())); } catch (error) {
    console.error(`[configure-paloma-monitoring] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  accountChannelPath,
  configure,
  expandHome,
  monitoringSettings,
  option,
  planMonitoring,
  runOpenClaw,
};
