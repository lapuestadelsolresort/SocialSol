'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { waitForWorkflowRun } = require('./cutover-social-autonomy');

test('social autonomy cutover waits for durable canary completion', async () => {
  const statuses = ['queued', 'running', 'completed'];
  const sleeps = [];
  const run = await waitForWorkflowRun('run-1', {
    token: 'x'.repeat(32),
    timeoutMs: 1000,
    pollMs: 1,
    sleep: async delay => sleeps.push(delay),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ run: { id: 'run-1', status: statuses.shift() } }),
    }),
  });
  assert.equal(run.status, 'completed');
  assert.deepEqual(sleeps, [1, 1]);
});

test('social autonomy cutover fails on a failed canary', async () => {
  await assert.rejects(waitForWorkflowRun('run-2', {
    token: 'x'.repeat(32),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ run: { id: 'run-2', status: 'failed', error_message: 'provider drift' } }),
    }),
  }), /provider drift/);
});
