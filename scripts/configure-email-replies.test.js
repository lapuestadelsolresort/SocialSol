'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configure, nextPolicy } = require('./configure-email-replies');

function fixture(directory) {
  const policyPath = path.join(directory, 'policy.json');
  const prospectorPath = path.join(directory, 'prospector.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1, shadow_mode: true, live_workflows: [], autonomous_workflows: [],
    always_on_effects: [],
    channels: { CPAULINA: { name: 'prospector-paulina', capabilities: ['paulina.read', 'paulina.send'] } },
    restricted_capabilities: {}, write_notifications: { user_ids: [], channel_ids: [] },
  }));
  fs.writeFileSync(prospectorPath, JSON.stringify({
    allowed_approvers: { 'U-SARAH': 'reviewer', 'U-JASON': 'admin' },
  }));
  return { policyPath, prospectorPath };
}

test('email-reply policy is dry-run by default and binds Gmail sends to configured approvers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-replies-dry-'));
  try {
    const { policyPath, prospectorPath } = fixture(directory);
    const before = fs.readFileSync(policyPath, 'utf8');
    const result = configure([
      '--workflow-policy', policyPath, '--prospector-config', prospectorPath,
      '--backup-dir', path.join(directory, 'backups'),
    ]);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(policyPath, 'utf8'), before);
    const next = nextPolicy(JSON.parse(before), ['U-SARAH', 'U-JASON', 'U-SARAH']).policy;
    assert.ok(next.channels.CPAULINA.capabilities.includes('email.read'));
    assert.ok(next.channels.CPAULINA.capabilities.includes('email.send'));
    assert.deepEqual(next.restricted_capabilities['email.send'].users, ['U-SARAH', 'U-JASON']);
    assert.ok(next.live_workflows.includes('email.reply.confirm'));
    assert.ok(next.autonomous_workflows.includes('email.message.observe'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('email-reply policy writes atomically with a recoverable backup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-replies-live-'));
  try {
    const { policyPath, prospectorPath } = fixture(directory);
    const result = configure([
      '--workflow-policy', policyPath, '--prospector-config', prospectorPath,
      '--backup-dir', path.join(directory, 'backups'), '--confirm-production',
    ]);
    assert.equal(result.mode, 'production');
    assert.ok(fs.existsSync(result.backup));
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assert.deepEqual(policy.restricted_capabilities['email.send'].users, ['U-SARAH', 'U-JASON']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('email-reply policy refuses to infer approvers', () => {
  const policy = {
    version: 1, channels: { CPAULINA: { name: 'prospector-paulina', capabilities: [] } },
    restricted_capabilities: {}, write_notifications: { user_ids: [] },
  };
  assert.throws(() => nextPolicy(policy, []), /allowed_approvers/);
});
