'use strict';

// F-024: a policy autonomy grant must be accounted for by the registry —
// either the definition declares `autonomous: true` (built to run on its own)
// or it accepts `auto_confirm_dispatch` (built for policy-armed confirmation,
// the D-019 arming path). These tests cover the module rules, the worker's
// system-origin guard, and both committed policy shapes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTO_CONFIRM_TRIGGER,
  systemOriginAccounted,
  assertSystemOriginAccounted,
  policyRegistryAgreementViolations,
  assertPolicyRegistryAgreement,
} = require('../lib/policy-registry-agreement');

test('a definition is accounted by the autonomous flag or the dispatch trigger, in either spelling', () => {
  assert.equal(systemOriginAccounted({ name: 'a', autonomous: true }), true);
  assert.equal(systemOriginAccounted({ name: 'b', allowedTriggers: ['x', AUTO_CONFIRM_TRIGGER] }), true);
  assert.equal(systemOriginAccounted({ name: 'c', allowed_triggers: [AUTO_CONFIRM_TRIGGER] }), true);
  assert.equal(systemOriginAccounted({ name: 'd', allowed_triggers: ['slack_whatsapp_command'] }), false);
  assert.equal(systemOriginAccounted({ name: 'e' }), false);
  assert.equal(systemOriginAccounted(null), false);
});

test('the unaccounted assertion throws the workflow_forbidden shape', () => {
  assert.throws(() => assertSystemOriginAccounted({ name: 'crm.contacts.read' }), error => {
    assert.equal(error.code, 'workflow_forbidden');
    assert.equal(error.status, 403);
    assert.equal(error.decision.reason, 'autonomy_not_registry_accounted');
    assert.match(error.message, /crm\.contacts\.read/);
    return true;
  });
  assert.doesNotThrow(() => assertSystemOriginAccounted({ name: 'ok', autonomous: true }));
});

test('violations cover ghosts, unaccounted grants, and unreachable or undispatchable per-op arming', () => {
  const definitions = [
    { name: 'auto.flagged', autonomous: true, allowed_triggers: null },
    { name: 'confirm.armed', autonomous: false, allowed_triggers: ['cmd', AUTO_CONFIRM_TRIGGER] },
    { name: 'plain.read', autonomous: false, allowed_triggers: null },
  ];
  const violations = policyRegistryAgreementViolations({
    autonomous_workflows: ['auto.flagged', 'confirm.armed', 'plain.read', 'no.such'],
    autonomous_operations: { 'confirm.armed': ['op_a'], 'plain.read': ['op_b'], 'ghost.op': ['op_c'] },
  }, definitions);

  assert.equal(violations.some(v => v.includes('no.such') && v.includes('not in the registry')), true);
  assert.equal(violations.some(v => v.includes('plain.read') && v.includes('neither declares autonomy')), true);
  assert.equal(violations.some(v => v.includes('plain.read') && v.includes('can never dispatch')), true);
  assert.equal(violations.some(v => v.includes('ghost.op') && v.includes('not in the registry')), true);
  assert.equal(violations.some(v => v.includes('ghost.op') && v.includes('unreachable')), true);
  assert.equal(violations.some(v => v.includes('auto.flagged')), false);
  assert.equal(violations.some(v => v.startsWith('autonomous_workflows lists confirm.armed')), false);

  assert.throws(() => assertPolicyRegistryAgreement({ autonomous_workflows: ['no.such'] }, definitions),
    /disagrees with the registry/);
  assert.doesNotThrow(() => assertPolicyRegistryAgreement({
    autonomous_workflows: ['auto.flagged'],
  }, definitions));
});

test('every autonomy grant in policy.example.json is registry-accounted', () => {
  const { listDefinitions } = require('../workflows/registry');
  const example = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'workflow', 'policy.example.json'), 'utf8'));
  assert.deepEqual(policyRegistryAgreementViolations(example, listDefinitions()), []);
});

test('the worker refuses to system-authorize an unaccounted definition', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agreement-worker-'));
  const policyFile = path.join(directory, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({
    version: 1,
    channels: {},
    live_workflows: [],
    autonomous_workflows: ['fixture.unaccounted', 'fixture.accounted'],
  }));
  const previous = process.env.RESORT_WORKFLOW_POLICY_PATH;
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyFile;
  try {
    const { authorizeSystemRun } = require('../scripts/workflow-worker');
    assert.throws(() => authorizeSystemRun({
      name: 'fixture.unaccounted', capability: 'crm.write', steps: [],
    }), error => error.decision?.reason === 'autonomy_not_registry_accounted');
    const { snapshot } = authorizeSystemRun({
      name: 'fixture.accounted', capability: 'crm.write', autonomous: true, steps: [],
    });
    assert.ok(snapshot);
  } finally {
    if (previous === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = previous;
  }
});
