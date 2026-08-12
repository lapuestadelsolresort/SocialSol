'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configure, nextPolicy } = require('./configure-social-autonomy');

function fixture(directory) {
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: true,
    live_workflows: [],
    autonomous_workflows: [],
    always_on_effects: [],
    channels: {
      CSOCIAL: { name: 'social-sol', capabilities: ['social.read', 'marketing.read'] },
    },
    restricted_capabilities: {},
    write_notifications: { user_ids: ['U-JASON'], channel_ids: [] },
  }));
  return policyPath;
}

test('social autonomy policy is dry-run by default and binds marketing writes to approvers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'social-autonomy-dry-'));
  try {
    const policyPath = fixture(directory);
    const before = fs.readFileSync(policyPath, 'utf8');
    const result = configure(['--workflow-policy', policyPath, '--backup-dir', path.join(directory, 'backups')]);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(policyPath, 'utf8'), before);
    const next = nextPolicy(JSON.parse(before)).policy;
    assert.ok(next.channels.CSOCIAL.capabilities.includes('marketing.write'));
    assert.deepEqual(next.restricted_capabilities['marketing.write'].users, ['U-JASON']);
    assert.ok(next.live_workflows.includes('meta.campaign.autonomous'));
    assert.ok(next.autonomous_workflows.includes('meta.audience.sync'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('social autonomy policy writes atomically with a recoverable backup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'social-autonomy-live-'));
  try {
    const policyPath = fixture(directory);
    const result = configure([
      '--workflow-policy', policyPath,
      '--backup-dir', path.join(directory, 'backups'),
      '--confirm-production',
    ]);
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assert.equal(result.mode, 'production');
    assert.ok(fs.existsSync(result.backup));
    assert.deepEqual(policy.restricted_capabilities['marketing.write'].users, ['U-JASON']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('social autonomy refuses to infer approvers', () => {
  const policy = {
    version: 1, channels: { CSOCIAL: { name: 'social-sol', capabilities: [] } },
    restricted_capabilities: {}, write_notifications: { user_ids: [] },
  };
  assert.throws(() => nextPolicy(policy), /approver allowlist/);
});
