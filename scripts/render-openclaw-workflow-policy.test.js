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
      live_workflows: ['meta.dm.reply'],
      channels: {
        CWA123: { name: 'whatsapp', capabilities: ['whatsapp.read', 'whatsapp.send'] },
        CSOCIAL1: { name: 'social-sol', capabilities: ['social.write'] },
        CRECEIPT1: { name: 'receipt-daniel', capabilities: ['receipts.submit', 'accounting.read_scoped'] },
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
  assert.deepEqual(Object.keys(account.channels).sort(), ['CRECEIPT1', 'CSOCIAL1', 'CWA123']);
  assert.equal(Object.hasOwn(account.channels.CWA123, 'users'), false);
  assert.deepEqual(account.channels.CWA123.tools.alsoAllow, ['resort_workflow']);
  assert.equal(patch.plugins.entries['resort-workflows'].config.shadowMode, true);
  assert.deepEqual(patch.plugins.entries['resort-workflows'].config.receiptChannelIds, ['CRECEIPT1']);
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

test('reservations prompt requires live OwnerRez reads and preserves titled manual entries', () => {
  const previousAccount = process.env.OPENCLAW_SLACK_ACCOUNT;
  process.env.OPENCLAW_SLACK_ACCOUNT = 'test-account';
  try {
    const patch = render({
      policy: {
        shadow_mode: false,
        channels: {
          CRESERVATIONS: { name: 'reservations', capabilities: ['ownerrez.read'] },
        },
      },
      currentConfig: { channels: { slack: { accounts: { 'test-account': {} } } } },
    });
    const prompt = patch.channels.slack.accounts['test-account'].channels.CRESERVATIONS.systemPrompt;
    assert.match(prompt, /call ownerrez\.occupancy\.read/);
    assert.match(prompt, /use nextCalendarEntry/);
    assert.match(prompt, /not proof of owner use/);
    assert.match(prompt, /Never answer mutable booking facts from CRM rows, memory/);
  } finally {
    if (previousAccount === undefined) delete process.env.OPENCLAW_SLACK_ACCOUNT;
    else process.env.OPENCLAW_SLACK_ACCOUNT = previousAccount;
  }
});
