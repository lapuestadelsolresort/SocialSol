'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { workflowReplay } = require('../scripts/engagement-analysis');

test('engagement analysis replays one persisted result per workflow run', () => {
  const result = { ok: true, replayed: false, day: 9 };
  const state = {
    hypotheses: [{ workflow_run_id: 'run-1', workflow_result: result }],
  };
  assert.deepEqual(workflowReplay(state, 'run-1'), { ...result, replayed: true });
  assert.equal(workflowReplay(state, 'run-2'), null);
  assert.equal(workflowReplay(state, null), null);
});
