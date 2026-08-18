'use strict';

//
// Tests for the runtime-policy fingerprint (F-055): an out-of-band edit of
// workflow/policy.json — which is gitignored, so the dirty-checkout guard
// cannot see it — must be detectable after the fact.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recordFingerprint, checkFingerprint, fingerprint } = require('./policy-fingerprint');

const VALID_POLICY = {
  version: 1,
  channels: { C123: { name: 'ops', capabilities: [] } },
  live_workflows: [],
  autonomous_workflows: [],
};

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-fingerprint-'));
  const policy = path.join(dir, 'policy.json');
  const record = path.join(dir, 'state', 'policy-fingerprint.json');
  fs.writeFileSync(policy, `${JSON.stringify(VALID_POLICY, null, 2)}\n`);
  return { dir, policy, record };
}

test('an unrecorded policy reports unrecorded, not match', () => {
  const { policy, record } = scratch();
  const result = checkFingerprint({ file: policy, target: record });
  assert.equal(result.status, 'unrecorded');
  assert.equal(result.recorded, null);
  assert.match(result.current.sha256, /^[0-9a-f]{64}$/);
});

test('recording then checking matches', () => {
  const { policy, record } = scratch();
  const entry = recordFingerprint({ file: policy, target: record, note: 'test install' });
  assert.equal(entry.sha256, fingerprint(policy).sha256);
  assert.equal(entry.note, 'test install');

  const result = checkFingerprint({ file: policy, target: record });
  assert.equal(result.status, 'match');
  assert.equal(result.recorded.sha256, result.current.sha256);
});

test('an out-of-band edit is detected as drift', () => {
  const { policy, record } = scratch();
  recordFingerprint({ file: policy, target: record });

  // The exact shape of the F-055 incident: a hand edit, valid JSON, no record.
  const edited = { ...VALID_POLICY, write_notifications: { channel_ids: ['C123'] } };
  fs.writeFileSync(policy, `${JSON.stringify(edited, null, 2)}\n`);

  const result = checkFingerprint({ file: policy, target: record });
  assert.equal(result.status, 'drift');
  assert.notEqual(result.recorded.sha256, result.current.sha256);
});

test('re-recording after a reviewed edit clears the drift', () => {
  const { policy, record } = scratch();
  recordFingerprint({ file: policy, target: record });
  fs.writeFileSync(policy, `${JSON.stringify({ ...VALID_POLICY, live_workflows: ['email.reply.propose'] }, null, 2)}\n`);
  assert.equal(checkFingerprint({ file: policy, target: record }).status, 'drift');

  recordFingerprint({ file: policy, target: record, note: 'reviewed and ratified' });
  assert.equal(checkFingerprint({ file: policy, target: record }).status, 'match');
});

test('an invalid policy is never blessed', () => {
  const { policy, record } = scratch();
  fs.writeFileSync(policy, JSON.stringify({ version: 99 }));
  assert.throws(() => recordFingerprint({ file: policy, target: record }));
  assert.equal(fs.existsSync(record), false);
});

test('the record file is written mode 600 and holds no policy content', () => {
  const { policy, record } = scratch();
  recordFingerprint({ file: policy, target: record });
  assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  const raw = fs.readFileSync(record, 'utf8');
  assert.equal(raw.includes('live_workflows'), false);
  assert.equal(raw.includes('channels'), false);
});

test('a missing policy file reports missing_policy', () => {
  const { policy, record } = scratch();
  recordFingerprint({ file: policy, target: record });
  fs.unlinkSync(policy);
  assert.equal(checkFingerprint({ file: policy, target: record }).status, 'missing_policy');
});

// --- F-024: policy↔registry autonomy agreement ------------------------------

function writePolicy(file, overrides) {
  fs.writeFileSync(file, `${JSON.stringify({ ...VALID_POLICY, ...overrides }, null, 2)}\n`);
}

test('record refuses an autonomy grant the registry does not account for', () => {
  const { policy, record } = scratch();
  // Registered workflow, but neither autonomous: true nor auto_confirm_dispatch.
  writePolicy(policy, { autonomous_workflows: ['crm.contacts.read'] });
  assert.throws(
    () => recordFingerprint({ file: policy, target: record }),
    /neither declares autonomy nor accepts auto_confirm_dispatch/,
  );
  assert.equal(fs.existsSync(record), false);
});

test('record refuses an autonomy grant for a workflow missing from the registry', () => {
  const { policy, record } = scratch();
  writePolicy(policy, { autonomous_workflows: ['no.such.workflow'] });
  assert.throws(() => recordFingerprint({ file: policy, target: record }), /not in the registry/);
});

test('record blesses declared-autonomous and dispatch-armed grants', () => {
  const { policy, record } = scratch();
  writePolicy(policy, {
    autonomous_workflows: ['crm.sync', 'email.message.observe', 'marketing.change.confirm'],
    autonomous_operations: { 'marketing.change.confirm': ['campaign_activate'] },
  });
  const entry = recordFingerprint({ file: policy, target: record, note: 'accounted grants' });
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});

test('record refuses per-operation arming that autonomous_workflows never reaches', () => {
  const { policy, record } = scratch();
  // The half-armed shape: an autonomous_operations entry whose workflow is not
  // system-authorizable, so the arming can never dispatch.
  writePolicy(policy, {
    autonomous_operations: { 'marketing.change.confirm': ['campaign_activate'] },
  });
  assert.throws(() => recordFingerprint({ file: policy, target: record }), /unreachable/);
});

test('check reports agreement violations after a hand edit adds an unaccounted grant', () => {
  const { policy, record } = scratch();
  writePolicy(policy, { autonomous_workflows: ['crm.sync'] });
  recordFingerprint({ file: policy, target: record });

  writePolicy(policy, { autonomous_workflows: ['crm.sync', 'crm.contacts.read'] });
  const result = checkFingerprint({ file: policy, target: record });
  assert.equal(result.status, 'drift');
  assert.equal(result.agreement.status, 'violations');
  assert.equal(result.agreement.violations.length, 1);
  assert.match(result.agreement.violations[0], /crm\.contacts\.read/);
});

test('check reports agreement ok for an accounted policy', () => {
  const { policy, record } = scratch();
  writePolicy(policy, { autonomous_workflows: ['crm.sync'] });
  recordFingerprint({ file: policy, target: record });
  const result = checkFingerprint({ file: policy, target: record });
  assert.equal(result.status, 'match');
  assert.equal(result.agreement.status, 'ok');
});
