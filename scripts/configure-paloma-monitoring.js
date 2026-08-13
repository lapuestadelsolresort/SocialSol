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
  CHECKPOINT_GUARD_NAMES,
  checkpointGuardSql,
  cronMatches,
  mergeSoulMonitoringBlock,
  monitorCronConfig,
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

function runSqlite(databasePath, sql, { sqliteBinary = process.env.SQLITE3_BIN || 'sqlite3' } = {}) {
  const result = spawnSync(sqliteBinary, [databasePath, sql], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function installedCheckpointGuards(databasePath, dependencies = {}) {
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const sql = `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${CHECKPOINT_GUARD_NAMES.map(quote).join(',')}) ORDER BY name;`;
  const output = (dependencies.runSqlite || runSqlite)(databasePath, sql, dependencies);
  return new Set(String(output || '').split(/\r?\n/).filter(Boolean));
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

function cronWriteArgs(contract, agentId) {
  return [
    '--agent', agentId,
    '--name', contract.name,
    '--description', contract.description,
    '--every', contract.every,
    '--session', contract.sessionTarget,
    '--message', contract.message,
    '--timeout-seconds', String(contract.timeoutSeconds),
    '--no-deliver',
    '--channel', contract.delivery.channel,
    '--account', contract.delivery.accountId,
    '--to', contract.delivery.to,
  ];
}

function cronFailureAlertArgs(contract) {
  return [
    '--failure-alert',
    '--failure-alert-after', String(contract.failureAlert.after),
    '--failure-alert-channel', contract.failureAlert.channel,
    '--failure-alert-to', contract.failureAlert.to,
    '--failure-alert-account-id', contract.failureAlert.accountId,
    '--failure-alert-mode', contract.failureAlert.mode,
    '--failure-alert-cooldown', `${contract.failureAlert.cooldownMs}ms`,
    ...(contract.failureAlert.includeSkipped
      ? ['--failure-alert-include-skipped'] : ['--failure-alert-exclude-skipped']),
  ];
}

function monitoringSettings(config, args) {
  const monitoring = config.monitoring || {};
  if (monitoring.enabled === false) throw new Error('Paloma monitoring is disabled in runtime config');
  return {
    accountId: option(args, '--account', process.env.PALOMA_SLACK_ACCOUNT || monitoring.slack_account),
    agentId: option(args, '--agent', process.env.PALOMA_AGENT_ID || monitoring.agent_id || 'paloma'),
    every: option(args, '--every', monitoring.monitor_every || monitoring.heartbeat_every || '10m'),
    timeoutSeconds: Number(option(args, '--timeout-seconds', monitoring.timeout_seconds || 300)),
    lookbackMinutes: Number(option(args, '--lookback-minutes', monitoring.initial_lookback_minutes || 60)),
    trackerChannelId: config.channels?.tracker,
  };
}

function planMonitoring({
  config, account, agents, cronJobs, groups, soul, root, settings, checkpointGuards = [],
}) {
  if (!account || account.enabled === false) throw new Error('Paloma Slack account is missing or disabled');
  const agentIndex = agents.findIndex(agent => agent.id === settings.agentId);
  if (agentIndex === -1) throw new Error(`OpenClaw agent ${settings.agentId} was not found`);
  const databasePath = path.join(root, 'paloma', 'data', 'tasks.db');
  const channelPlan = monitoredChannelConfig(account.channels, groups);
  if (!channelPlan.joined.length) throw new Error('Paloma Slack account is not a member of any active channels');
  const monitorCron = monitorCronConfig({
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
  const matchingCronJobs = (cronJobs || []).filter(job => job.name === monitorCron.name);
  if (matchingCronJobs.some(job => job.agentId !== settings.agentId)) {
    throw new Error(`${monitorCron.name} is already owned by a different OpenClaw agent`);
  }
  if (matchingCronJobs.length > 1) throw new Error(`multiple ${monitorCron.name} cron jobs exist`);
  const cronJob = matchingCronJobs[0] || null;
  return {
    agentIndex,
    cronJob,
    monitorCron,
    nextSoul,
    joined: channelPlan.joined,
    channels: channelPlan.channels,
    changedChannelIds,
    missingCheckpointGuards: CHECKPOINT_GUARD_NAMES
      .filter(name => !new Set(checkpointGuards).has(name)),
    cronChanged: !cronMatches(cronJob, monitorCron, settings.agentId),
    legacyHeartbeatPresent: Boolean(agents[agentIndex].heartbeat),
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
  const databasePath = path.join(root, 'paloma', 'data', 'tasks.db');
  const checkpointGuards = installedCheckpointGuards(databasePath, dependencies);

  const groups = openClawJson([
    'directory', 'groups', 'list', '--channel', 'slack', '--account', settings.accountId,
    '--json', '--limit', '500',
  ], dependencies);
  const account = openClawJson([
    'config', 'get', `channels.slack.accounts[${JSON.stringify(settings.accountId)}]`, '--json',
  ], dependencies);
  const agents = openClawJson(['config', 'get', 'agents.list', '--json'], dependencies);
  const cronPayload = openClawJson(['cron', 'list', '--all', '--json'], dependencies);
  const agent = agents.find(candidate => candidate.id === settings.agentId);
  if (!agent?.workspace) throw new Error(`OpenClaw agent ${settings.agentId} has no workspace`);
  const soulPath = path.resolve(option(args, '--soul-path', path.join(expandHome(agent.workspace), 'SOUL.md')));
  const soul = fs.readFileSync(soulPath, 'utf8');
  const plan = planMonitoring({
    config, account, agents, cronJobs: cronPayload.jobs || [], groups, soul, root, settings,
    checkpointGuards,
  });
  const changed = plan.changedChannelIds.length > 0 || plan.cronChanged
    || plan.missingCheckpointGuards.length > 0
    || plan.legacyHeartbeatPresent || plan.soulChanged;
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
    checkpointGuardInstall: plan.missingCheckpointGuards.length > 0,
    monitorEvery: plan.monitorCron.every,
    monitorTarget: plan.monitorCron.delivery.to,
    cronChanged: plan.cronChanged,
    legacyHeartbeatRemoval: plan.legacyHeartbeatPresent,
    soulChanged: plan.soulChanged,
  };
  if (!confirmProduction) {
    for (const channelId of plan.changedChannelIds) {
      command([
        'config', 'set', accountChannelPath(settings.accountId, channelId),
        JSON.stringify(plan.channels[channelId]), '--strict-json', '--merge', '--dry-run',
      ], dependencies);
    }
    if (plan.legacyHeartbeatPresent) {
      command([
        'config', 'unset', `agents.list[${plan.agentIndex}].heartbeat`, '--dry-run',
      ], dependencies);
    }
    return summary;
  }
  if (!changed) return summary;

  const openClawConfigPath = expandHome(command(['config', 'file'], dependencies));
  const configBackup = backupFile(openClawConfigPath, backupDirectory, 'openclaw.pre-paloma-monitoring');
  const soulBackup = backupFile(soulPath, backupDirectory, 'paloma-soul.pre-all-channel-monitoring');
  let createdCronId = '';
  try {
    // Put the behavioral contract in place before widening real-time event delivery.
    if (plan.soulChanged) writeAtomic(soulPath, plan.nextSoul);
    if (plan.missingCheckpointGuards.length) {
      (dependencies.runSqlite || runSqlite)(databasePath, checkpointGuardSql(), dependencies);
    }
    for (const channelId of plan.changedChannelIds) {
      command([
        'config', 'set', accountChannelPath(settings.accountId, channelId),
        JSON.stringify(plan.channels[channelId]), '--strict-json', '--merge',
      ], dependencies);
    }
    if (plan.cronChanged) {
      if (plan.cronJob) {
        command([
          'cron', 'edit', plan.cronJob.id,
          ...cronWriteArgs(plan.monitorCron, settings.agentId),
          ...cronFailureAlertArgs(plan.monitorCron),
        ], dependencies);
        if (!plan.cronJob.enabled) command(['cron', 'enable', plan.cronJob.id], dependencies);
      } else {
        const created = openClawJson([
          'cron', 'add', ...cronWriteArgs(plan.monitorCron, settings.agentId), '--json',
        ], dependencies);
        createdCronId = created.id || '';
        if (!createdCronId) throw new Error('Paloma monitor cron creation returned no job id');
        command([
          'cron', 'edit', createdCronId, ...cronFailureAlertArgs(plan.monitorCron),
        ], dependencies);
      }
    }
    if (plan.legacyHeartbeatPresent) {
      command(['config', 'unset', `agents.list[${plan.agentIndex}].heartbeat`], dependencies);
    }

    const verifiedAccount = openClawJson([
      'config', 'get', `channels.slack.accounts[${JSON.stringify(settings.accountId)}]`, '--json',
    ], dependencies);
    const verifiedAgents = openClawJson(['config', 'get', 'agents.list', '--json'], dependencies);
    const verifiedCronPayload = openClawJson(['cron', 'list', '--all', '--json'], dependencies);
    const verifiedCronJobs = (verifiedCronPayload.jobs || [])
      .filter(job => job.name === plan.monitorCron.name && job.agentId === settings.agentId);
    for (const channel of plan.joined) {
      const policy = verifiedAccount.channels?.[channel.id];
      if (!policy?.enabled || policy.requireMention !== false) {
        throw new Error(`verification failed for joined Slack channel ${channel.name}`);
      }
    }
    if (verifiedAgents[plan.agentIndex]?.heartbeat) {
      throw new Error('verification failed while retiring unsupported Paloma heartbeat configuration');
    }
    const verifiedCheckpointGuards = installedCheckpointGuards(databasePath, dependencies);
    if (CHECKPOINT_GUARD_NAMES.some(name => !verifiedCheckpointGuards.has(name))) {
      throw new Error('verification failed for Paloma checkpoint database guards');
    }
    if (verifiedCronJobs.length !== 1
        || !cronMatches(verifiedCronJobs[0], plan.monitorCron, settings.agentId)) {
      throw new Error('verification failed for Paloma monitor cron configuration');
    }
    if (fs.readFileSync(soulPath, 'utf8') !== plan.nextSoul) {
      throw new Error('verification failed for Paloma SOUL monitoring contract');
    }
  } catch (error) {
    if (createdCronId) {
      try { command(['cron', 'rm', createdCronId], dependencies); } catch {}
    }
    fs.copyFileSync(configBackup, openClawConfigPath);
    fs.copyFileSync(soulBackup, soulPath);
    if (plan.missingCheckpointGuards.length) {
      const rollbackSql = plan.missingCheckpointGuards
        .map(name => `DROP TRIGGER IF EXISTS ${name};`).join('\n');
      try { (dependencies.runSqlite || runSqlite)(databasePath, rollbackSql, dependencies); } catch {}
    }
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
  cronFailureAlertArgs,
  cronWriteArgs,
  expandHome,
  monitoringSettings,
  option,
  planMonitoring,
  runOpenClaw,
  runSqlite,
  installedCheckpointGuards,
};
