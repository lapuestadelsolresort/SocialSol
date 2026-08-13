'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configure, nextPolicy } = require('./configure-sarah-email');

function fixture(directory) {
  const policyPath = path.join(directory, 'policy.json');
  const prospectorPath = path.join(directory, 'prospector.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1, shadow_mode: true, live_workflows: [], autonomous_workflows: [],
    always_on_effects: [],
    channels: { CPAULINA1: { name: 'prospector-paulina', capabilities: ['email.read', 'email.send'] } },
    restricted_capabilities: {}, write_notifications: { user_ids: [], channel_ids: [] },
  }));
  fs.writeFileSync(prospectorPath, JSON.stringify({
    allowed_approvers: { 'U-SARAH': 'reviewer', 'U-JASON': 'admin' },
  }));
  return { policyPath, prospectorPath };
}

test('Sarah email policy dry-run adds a dedicated least-privilege channel', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-email-dry-'));
  try {
    const { policyPath, prospectorPath } = fixture(directory);
    const before = fs.readFileSync(policyPath, 'utf8');
    const result = configure([
      '--workflow-policy', policyPath, '--prospector-config', prospectorPath,
      '--channel-id', 'CSARAH123', '--backup-dir', path.join(directory, 'backups'),
    ]);
    assert.equal(result.mode, 'dry-run');
    assert.equal(fs.readFileSync(policyPath, 'utf8'), before);
    const next = nextPolicy(JSON.parse(before), ['U-SARAH', 'U-JASON'], 'CSARAH123').policy;
    assert.deepEqual(next.channels.CSARAH123.capabilities,
      ['email.read', 'email.send', 'crm.read', 'crm.write']);
    assert.deepEqual(next.restricted_capabilities['email.send'].users, ['U-SARAH', 'U-JASON']);
    assert.ok(next.autonomous_workflows.includes('email.message.observe'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Sarah email policy writes atomically and refuses channel takeover', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-email-live-'));
  try {
    const { policyPath, prospectorPath } = fixture(directory);
    const result = configure([
      '--workflow-policy', policyPath, '--prospector-config', prospectorPath,
      '--channel-id', 'CSARAH123', '--backup-dir', path.join(directory, 'backups'),
      '--confirm-production',
    ]);
    assert.equal(result.mode, 'production');
    assert.ok(fs.existsSync(result.backup));
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assert.equal(policy.channels.CSARAH123.name, 'sarah-email');
    policy.channels.COTHER123 = { name: 'sarah-email', capabilities: [] };
    assert.throws(() => nextPolicy(policy, ['U-SARAH'], 'CSARAH123'), /different channel id/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
