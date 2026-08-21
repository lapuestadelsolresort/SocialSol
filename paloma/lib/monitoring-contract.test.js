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
  monitorInvocation,
} = require('./monitoring-contract');
const {
  accountChannelPath,
  cronFailureAlertArgs,
  cronWriteArgs,
  planMonitoring,
  taskTrackerConfigMatches,
  taskTrackerPluginConfig,
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
  assert.match(once, /task-report\.js --user-id <TRUSTED_SENDER_ID> --status active/);
  assert.match(once, /Never use Slack member-info or an improvised SQL query/);
  assert.match(once, /Return the command's bilingual stdout verbatim/);
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
  assert.equal(plan.taskTrackerConfigChanged, true);
  assert.deepEqual(plan.taskTrackerConfig, {
    taskTrackerAgentIds: ['paloma'],
    taskTrackerAccountIds: ['paloma-test'],
    taskTrackerChannelIds: ['CJOINED01', 'CJOINED02'],
    taskTrackerDatabasePath: '/tmp/socialsol/paloma/data/tasks.db',
    taskTrackerConfigPath: '/tmp/socialsol/paloma/config.json',
  });
  assert.equal(accountChannelPath('paloma-test', 'CJOINED02'),
    'channels.slack.accounts["paloma-test"].channels["CJOINED02"]');
});

test('task reply configuration is identity-driven and compares only its owned fields', () => {
  const expected = taskTrackerPluginConfig({
    root: '/srv/socialsol', configPath: '/runtime/paloma.json',
    settings: { agentId: 'tracker-agent', accountId: 'tracker-account' },
    joined: [{ id: 'C-TWO' }, { id: 'C-ONE' }],
  });
  assert.deepEqual(expected, {
    taskTrackerAgentIds: ['tracker-agent'],
    taskTrackerAccountIds: ['tracker-account'],
    taskTrackerChannelIds: ['C-ONE', 'C-TWO'],
    taskTrackerDatabasePath: '/srv/socialsol/paloma/data/tasks.db',
    taskTrackerConfigPath: '/runtime/paloma.json',
  });
  assert.equal(taskTrackerConfigMatches({ ...expected, unrelated: true }, expected), true);
  assert.equal(taskTrackerConfigMatches({ ...expected, taskTrackerAgentIds: ['other'] }, expected), false);
});

test('scan invocation carries the tracker channel and runs one agent turn (F-066)', () => {
  const config = {
    channels: { tracker: 'CTRACK123456', maintenance: 'CMAINT123456' },
    users: {},
    monitoring: { enabled: true, slack_account: 'paloma-account', agent_id: 'paloma', timeout_seconds: 120, initial_lookback_minutes: 45 },
  };
  const invocation = monitorInvocation({ config, env: {}, root: '/srv/socialsol' });
  assert.equal(invocation.accountId, 'paloma-account');
  assert.equal(invocation.agentId, 'paloma');
  assert.equal(invocation.timeoutSeconds, 120);
  assert.deepEqual(invocation.args.slice(0, 3), ['agent', '--agent', 'paloma']);
  assert.deepEqual(invocation.args.slice(-3), ['--timeout', '120', '--json']);
  assert.match(invocation.message, /channel:CTRACK123456/);
  assert.match(invocation.message, /\/srv\/socialsol\/paloma\/data\/tasks\.db/);
  assert.match(invocation.message, /begin 45 minutes before/);
  // Environment overrides win, matching configure-paloma-monitoring.js.
  const overridden = monitorInvocation({ config, env: { PALOMA_SLACK_ACCOUNT: 'env-account', PALOMA_AGENT_ID: 'env-agent' }, root: '/srv/socialsol' });
  assert.equal(overridden.accountId, 'env-account');
  assert.equal(overridden.agentId, 'env-agent');
});

test('scan invocation fails loudly on the config gaps that silently broke the trio', () => {
  const base = { channels: { tracker: 'CTRACK123456' }, monitoring: { slack_account: 'paloma-account' } };
  assert.throws(
    () => monitorInvocation({ config: { ...base, monitoring: {} }, env: {}, root: '/srv/socialsol' }),
    /monitoring\.slack_account is required/,
  );
  assert.throws(
    () => monitorInvocation({ config: { ...base, channels: {} }, env: {}, root: '/srv/socialsol' }),
    /tracker Slack channel id is invalid/,
  );
  assert.throws(
    () => monitorInvocation({ config: { ...base, monitoring: { ...base.monitoring, enabled: false } }, env: {}, root: '/srv/socialsol' }),
    /monitoring is disabled/,
  );
});
