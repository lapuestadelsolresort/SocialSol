'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CHECKPOINT_GUARD_NAMES,
  checkpointGuardSql,
  cronMatches,
  joinedChannels,
  mergeSoulMonitoringBlock,
  monitorCronConfig,
  monitoredChannelConfig,
  soulMonitoringBlock,
} = require('./monitoring-contract');
const {
  accountChannelPath,
  cronFailureAlertArgs,
  cronWriteArgs,
  planMonitoring,
} = require('../../scripts/configure-paloma-monitoring');

const groups = [
  { id: 'channel:CJOINED01', name: 'villa-one', raw: { is_member: true, is_archived: false } },
  { id: 'channel:CJOINED02', name: 'general', raw: { is_member: true, is_archived: false } },
  { id: 'channel:CARCHIVE1', name: 'old', raw: { is_member: true, is_archived: true } },
  { id: 'channel:COUTSIDE1', name: 'public-not-joined', raw: { is_member: false, is_archived: false } },
];

test('joinedChannels selects every current non-archived Slack membership', () => {
  assert.deepEqual(joinedChannels(groups).map(channel => channel.id), ['CJOINED01', 'CJOINED02']);
});

test('monitoredChannelConfig disables mention gating without erasing channel policy', () => {
  const current = {
    CJOINED01: { enabled: false, requireMention: true, tools: { deny: ['exec'] } },
    CLEGACY01: { enabled: true, requireMention: true },
  };
  const result = monitoredChannelConfig(current, groups);
  assert.equal(result.channels.CJOINED01.enabled, true);
  assert.equal(result.channels.CJOINED01.requireMention, false);
  assert.deepEqual(result.channels.CJOINED01.tools, { deny: ['exec'] });
  assert.deepEqual(result.channels.CJOINED02, { enabled: true, requireMention: false });
  assert.deepEqual(result.channels.CLEGACY01, current.CLEGACY01);
});

test('monitor cron is isolated, success-silent, failure-routed, dynamic, and checkpoint-safe', () => {
  const monitor = monitorCronConfig({
    accountId: 'paloma-test', databasePath: '/tmp/paloma/tasks.db',
    trackerChannelId: 'CPALOMA01', every: '10m',
  });
  assert.equal(monitor.every, '10m');
  assert.equal(monitor.everyMs, 600000);
  assert.equal(monitor.delivery.to, 'channel:CPALOMA01');
  assert.equal(monitor.delivery.mode, 'none');
  assert.equal(monitor.failureAlert.after, 1);
  assert.equal(monitor.failureAlert.to, 'channel:CPALOMA01');
  assert.equal(monitor.failureAlert.includeSkipped, false);
  assert.equal(monitor.sessionTarget, 'isolated');
  assert.match(monitor.message, /every non-archived channel/);
  assert.match(monitor.message, /direct @mention followed by an imperative request is a task candidate/);
  assert.match(monitor.message, /leave the affected checkpoint unchanged/);
  assert.match(monitor.message, /copy its stdout exactly as scan_start_ts/);
  assert.match(monitor.message, /refuse any checkpoint greater than that stdout/);
  assert.match(monitor.message, /send exactly one concise alert to channel:CPALOMA01/);
  assert.match(monitor.message, /exactly NO_REPLY/);
  assert.ok(cronMatches({
    agentId: 'paloma', name: monitor.name, description: monitor.description, enabled: true,
    schedule: { kind: 'every', everyMs: 600000 }, sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', message: monitor.message, timeoutSeconds: 300 },
    delivery: monitor.delivery,
    failureAlert: monitor.failureAlert,
  }, monitor, 'paloma'));
  assert.ok(cronWriteArgs(monitor, 'paloma').includes('--no-deliver'));
  assert.ok(!cronWriteArgs(monitor, 'paloma').includes('--announce'));
  assert.deepEqual(cronFailureAlertArgs(monitor), [
    '--failure-alert',
    '--failure-alert-after', '1',
    '--failure-alert-channel', 'slack',
    '--failure-alert-to', 'channel:CPALOMA01',
    '--failure-alert-account-id', 'paloma-test',
    '--failure-alert-mode', 'announce',
    '--failure-alert-cooldown', '600000ms',
    '--failure-alert-exclude-skipped',
  ]);
});

test('database guards reject future scan checkpoints on insert and update', () => {
  const sql = checkpointGuardSql();
  for (const name of CHECKPOINT_GUARD_NAMES) assert.match(sql, new RegExp(name));
  assert.match(sql, /BEFORE INSERT ON scan_state/);
  assert.match(sql, /BEFORE UPDATE OF last_scanned_ts ON scan_state/);
  assert.match(sql, /strftime\('%s','now'\)/);
  assert.match(sql, /RAISE\(ABORT, 'Paloma scan checkpoint cannot be in the future'\)/);
});

test('managed SOUL block is idempotent and applies task detection to every joined channel', () => {
  const block = soulMonitoringBlock({
    accountId: 'paloma-test', databasePath: '/tmp/paloma/tasks.db',
  });
  const once = mergeSoulMonitoringBlock('# Paloma\n', block);
  const twice = mergeSoulMonitoringBlock(once, block);
  assert.equal(twice, once);
  assert.match(once, /whether or not Paloma is mentioned/);
  assert.match(once, /directly assigning work to another person is a task/);
});

test('cutover plan targets the requested agent without replacing its Slack account', () => {
  const plan = planMonitoring({
    config: {},
    account: {
      enabled: true,
      botToken: '__REDACTED__',
      channels: { CJOINED01: { enabled: true, requireMention: false } },
    },
    agents: [
      { id: 'other', workspace: '/tmp/other' },
      { id: 'paloma', workspace: '/tmp/paloma' },
    ],
    cronJobs: [],
    groups,
    soul: '# Paloma\n',
    root: '/tmp/socialsol',
    settings: {
      accountId: 'paloma-test',
      agentId: 'paloma',
      every: '10m',
      timeoutSeconds: 300,
      lookbackMinutes: 60,
      trackerChannelId: 'CPALOMA01',
    },
    checkpointGuards: CHECKPOINT_GUARD_NAMES,
  });
  assert.equal(plan.agentIndex, 1);
  assert.deepEqual(plan.changedChannelIds, ['CJOINED02']);
  assert.equal(plan.monitorCron.delivery.to, 'channel:CPALOMA01');
  assert.equal(plan.cronChanged, true);
  assert.deepEqual(plan.missingCheckpointGuards, []);
  assert.equal(accountChannelPath('paloma-test', 'CJOINED02'),
    'channels.slack.accounts["paloma-test"].channels["CJOINED02"]');
});
