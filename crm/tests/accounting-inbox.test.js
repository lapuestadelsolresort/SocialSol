'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { accountingWorkflowsLive } = require('../scripts/accounting-inbox');

test('accounting inbox honors narrow live workflows while global shadow remains enabled', () => {
  assert.equal(accountingWorkflowsLive({
    shadow_mode: true,
    live_workflows: ['accounting.classify', 'qbo.write'],
  }), true);
  assert.equal(accountingWorkflowsLive({
    shadow_mode: true,
    live_workflows: ['accounting.classify'],
  }), false);
  assert.equal(accountingWorkflowsLive({ shadow_mode: false, live_workflows: [] }), true);
});
