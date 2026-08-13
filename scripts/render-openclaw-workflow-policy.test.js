'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { render } = require('./render-openclaw-workflow-policy');

test('OpenClaw renderer uses stable Slack IDs, allowlist routing, and workflow-only tools', () => {
  const previousAccount = process.env.OPENCLAW_SLACK_ACCOUNT;
  process.env.OPENCLAW_SLACK_ACCOUNT = 'test-account';
  try {
  const patch = render({
    policy: {
      shadow_mode: true,
      live_workflows: ['meta.dm.reply', 'receipt.owner_expense.ingest', 'qbo.write'],
      channels: {
        CWA123: { name: 'whatsapp', capabilities: ['whatsapp.read', 'whatsapp.send'] },
        CSOCIAL1: { name: 'social-sol', capabilities: ['social.write'] },
        CRECEIPT1: { name: 'receipt-daniel', capabilities: ['receipts.submit', 'accounting.read_scoped'] },
        COWNER1: { name: 'receipt-jorge', capabilities: ['receipts.submit', 'accounting.read_scoped', 'qbo.owner_expense.write'] },
        CACCT1: { name: 'accounting', capabilities: ['accounting.write', 'qbo.write'] },
      },
    },
    currentConfig: {
      channels: { slack: { accounts: { 'test-account': {} } } },
      plugins: { entries: { slack: { enabled: true } }, load: { paths: ['/existing'] } },
    },
    pluginIds: ['slack'],
  });
  const account = patch.channels.slack.accounts['test-account'];
  assert.equal(account.groupPolicy, 'allowlist');
  assert.equal(Object.hasOwn(account, 'groupAllowFrom'), false);
  assert.deepEqual(Object.keys(account.channels).sort(), ['CACCT1', 'COWNER1', 'CRECEIPT1', 'CSOCIAL1', 'CWA123']);
  assert.equal(Object.hasOwn(account.channels.CWA123, 'users'), false);
  assert.deepEqual(account.channels.CWA123.tools.alsoAllow, ['resort_workflow']);
  assert.equal(patch.plugins.entries['resort-workflows'].config.shadowMode, true);
  assert.deepEqual(patch.plugins.entries['resort-workflows'].config.receiptChannelIds, ['CRECEIPT1', 'COWNER1']);
  assert.deepEqual(patch.plugins.entries['resort-workflows'].config.ownerExpenseChannelIds, ['COWNER1']);
  assert.deepEqual(patch.plugins.entries['resort-workflows'].config.accountingChannelIds, ['CACCT1']);
  assert.match(account.channels.CACCT1.systemPrompt, /CSV attachments are captured automatically/);
  assert.match(account.channels.CACCT1.systemPrompt, /Never manually save an upload/);
  assert.match(account.channels.COWNER1.systemPrompt, /owner-ledger channel/);
  assert.match(account.channels.COWNER1.systemPrompt, /confirm repayment/);
  assert.deepEqual(patch.plugins.entries['resort-workflows'].config.socialChannelIds, ['CSOCIAL1']);
  assert.deepEqual(account.channels.CSOCIAL1.tools.allow, ['resort_workflow']);
  assert.equal(patch.plugins.allow.includes('resort-workflows'), true);
  } finally {
    if (previousAccount === undefined) delete process.env.OPENCLAW_SLACK_ACCOUNT;
    else process.env.OPENCLAW_SLACK_ACCOUNT = previousAccount;
  }
});

test('narrow live workflow cutovers remove the shadow-only prompt for their owning channels', () => {
  const previousAccount = process.env.OPENCLAW_SLACK_ACCOUNT;
  process.env.OPENCLAW_SLACK_ACCOUNT = 'test-account';
  try {
    const patch = render({
      policy: {
        shadow_mode: true,
        live_workflows: ['paulina.daily', 'accounting.classify', 'qbo.write', 'receipt.ingest'],
        channels: {
          CPAULINA: { name: 'prospector-paulina', capabilities: ['paulina.send'] },
          CACCT: { name: 'accounting', capabilities: ['accounting.write', 'qbo.write'] },
          CRECEIPT: { name: 'receipt-worker', capabilities: ['receipts.submit', 'accounting.read_scoped'] },
        },
      },
      currentConfig: { channels: { slack: { accounts: { 'test-account': {} } } } },
    });
    const channels = patch.channels.slack.accounts['test-account'].channels;
    for (const channelId of ['CPAULINA', 'CACCT', 'CRECEIPT']) {
      assert.deepEqual(channels[channelId].tools.allow, ['resort_workflow']);
      assert.doesNotMatch(channels[channelId].systemPrompt, /^SHADOW MODE:/);
    }
  } finally {
    if (previousAccount === undefined) delete process.env.OPENCLAW_SLACK_ACCOUNT;
    else process.env.OPENCLAW_SLACK_ACCOUNT = previousAccount;
  }
});

test('email console rendering exposes only thread-bound commands to both authorized channels', () => {
  const previousAccount = process.env.OPENCLAW_SLACK_ACCOUNT;
  process.env.OPENCLAW_SLACK_ACCOUNT = 'test-account';
  try {
    const patch = render({
      policy: {
        shadow_mode: true,
        live_workflows: ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'],
        channels: {
          CPAULINA: { name: 'prospector-paulina', capabilities: ['paulina.read', 'email.read', 'email.send'] },
          CEMAIL: { name: 'sarah-email', capabilities: ['email.read', 'email.send', 'crm.read', 'crm.write'] },
        },
      },
      currentConfig: { channels: { slack: { accounts: { 'test-account': {} } } } },
    });
    assert.deepEqual(patch.plugins.entries['resort-workflows'].config.emailChannelIds, ['CPAULINA', 'CEMAIL']);
    const channel = patch.channels.slack.accounts['test-account'].channels.CPAULINA;
    assert.match(channel.systemPrompt, /same thread sends through Gmail/);
    assert.match(channel.systemPrompt, /top-level email commands never send/);
    assert.deepEqual(channel.tools.allow, ['resort_workflow']);
    const sarah = patch.channels.slack.accounts['test-account'].channels.CEMAIL;
    assert.match(sarah.systemPrompt, /Gmail and OwnerRez/);
    assert.match(sarah.systemPrompt, /same user in that same thread/);
    assert.deepEqual(sarah.tools.allow, ['resort_workflow']);
  } finally {
    if (previousAccount === undefined) delete process.env.OPENCLAW_SLACK_ACCOUNT;
    else process.env.OPENCLAW_SLACK_ACCOUNT = previousAccount;
  }
});

test('reservations prompt requires live OwnerRez reads and preserves titled manual entries', () => {
  const previousAccount = process.env.OPENCLAW_SLACK_ACCOUNT;
  process.env.OPENCLAW_SLACK_ACCOUNT = 'test-account';
  try {
    const patch = render({
      policy: {
        shadow_mode: true,
        live_workflows: [],
        channels: {
          CRESERVATIONS: { name: 'reservations', capabilities: ['ownerrez.read'] },
        },
      },
      currentConfig: { channels: { slack: { accounts: { 'test-account': {} } } } },
    });
    const channel = patch.channels.slack.accounts['test-account'].channels.CRESERVATIONS;
    const prompt = channel.systemPrompt;
    assert.match(prompt, /call ownerrez\.occupancy\.read/);
    assert.match(prompt, /use nextCalendarEntry/);
    assert.match(prompt, /not proof of owner use/);
    assert.match(prompt, /Never answer mutable booking facts from CRM rows, memory/);
    assert.deepEqual(channel.tools.allow, ['resort_workflow']);
    assert.deepEqual(channel.tools.alsoAllow, []);
    assert.doesNotMatch(prompt, /^SHADOW MODE:/);
    assert.deepEqual(
      patch.plugins.entries['resort-workflows'].config.reservationsChannelIds,
      ['CRESERVATIONS'],
    );
    assert.deepEqual(patch.plugins.entries['resort-workflows'].config.ownerrezChannelIds, []);
  } finally {
    if (previousAccount === undefined) delete process.env.OPENCLAW_SLACK_ACCOUNT;
    else process.env.OPENCLAW_SLACK_ACCOUNT = previousAccount;
  }
});
