'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  heartbeatConfig,
  joinedChannels,
  mergeSoulMonitoringBlock,
  monitoredChannelConfig,
  soulMonitoringBlock,
} = require('./monitoring-contract');
const { accountChannelPath, planMonitoring } = require('../../scripts/configure-paloma-monitoring');

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

test('heartbeat is isolated, success-silent, failure-routed, dynamic, and checkpoint-safe', () => {
  const heartbeat = heartbeatConfig({
    accountId: 'paloma-test', databasePath: '/tmp/paloma/tasks.db',
    trackerChannelId: 'CPALOMA01', every: '10m',
  });
  assert.equal(heartbeat.every, '10m');
  assert.equal(heartbeat.target, 'slack');
  assert.equal(heartbeat.to, 'channel:CPALOMA01');
  assert.equal(heartbeat.isolatedSession, true);
  assert.match(heartbeat.prompt, /every non-archived channel/);
  assert.match(heartbeat.prompt, /direct @mention followed by an imperative request is a task candidate/);
  assert.match(heartbeat.prompt, /leave the affected checkpoint unchanged/);
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
  });
  assert.equal(plan.agentIndex, 1);
  assert.deepEqual(plan.changedChannelIds, ['CJOINED02']);
  assert.equal(plan.heartbeat.to, 'channel:CPALOMA01');
  assert.equal(accountChannelPath('paloma-test', 'CJOINED02'),
    'channels.slack.accounts["paloma-test"].channels["CJOINED02"]');
});
