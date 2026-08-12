'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { remainingBatchSize } = require('../composer');

test('workflow-attributed drafts reduce a replay to only the remaining batch', () => {
  assert.equal(remainingBatchSize(10, 0), 10);
  assert.equal(remainingBatchSize(10, 4), 6);
  assert.equal(remainingBatchSize(10, 10), 0);
  assert.equal(remainingBatchSize(10, 12), 0);
});
