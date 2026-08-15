'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { QUARANTINED_LIVE_WORKFLOWS, assertNoQuarantinedLiveWorkflows } = require('./validate-openclaw-shadow');

function patchWithLiveWorkflows(liveWorkflowNames) {
  return {
    plugins: {
      entries: {
        'resort-workflows': { config: { shadowMode: true, liveWorkflowNames } },
      },
    },
  };
}

test('meta.dm.reply is quarantined (F-020)', () => {
  assert.ok(QUARANTINED_LIVE_WORKFLOWS.includes('meta.dm.reply'));
});

test('a patch arming a quarantined workflow is refused', () => {
  assert.throws(
    () => assertNoQuarantinedLiveWorkflows(patchWithLiveWorkflows(['whatsapp.reply', 'meta.dm.reply'])),
    /meta\.dm\.reply.*F-020/,
  );
});

test('a patch without quarantined workflows passes', () => {
  assert.doesNotThrow(() => assertNoQuarantinedLiveWorkflows(patchWithLiveWorkflows(['whatsapp.reply'])));
  assert.doesNotThrow(() => assertNoQuarantinedLiveWorkflows({}));
});

test('policy.example.json does not arm any quarantined workflow', () => {
  const examplePath = path.join(__dirname, '..', 'workflow', 'policy.example.json');
  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  for (const name of QUARANTINED_LIVE_WORKFLOWS) {
    assert.ok(
      !example.live_workflows.includes(name),
      `${name} must stay out of policy.example.json live_workflows`,
    );
  }
});
