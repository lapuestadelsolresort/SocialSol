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
