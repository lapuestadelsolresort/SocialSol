'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { main, waitForConversationLedger } = require('./cutover-email-replies');

test('email cutover refuses to mutate before Gmail send-scope preflight succeeds', async () => {
  const calls = [];
  await assert.rejects(main(['--confirm-production'], {
    run: (program, args) => {
      calls.push([program, ...args]);
      throw new Error('Gmail DWD scope denied');
    },
    configure: () => assert.fail('policy must not change'),
    installLaunchAgent: () => assert.fail('LaunchAgent must not install'),
  }), /scope denied/);
  assert.match(calls[0].join(' '), /verify-gmail-send-scope\.js/);
  assert.equal(calls.length, 1);
});

test('email ledger verification waits for workflow and Slack-thread completion', async () => {
  const snapshots = [
    { events: 2, active: 2, activeRuns: 0, pendingSlack: 0, failed: 0,
      failedRuns: 0, classifierDrift: 0, unthreadedMatched: 2 },
    { events: 2, active: 0, activeRuns: 0, pendingSlack: 2, failed: 0,
      failedRuns: 0, classifierDrift: 0, unthreadedMatched: 2 },
    { events: 2, active: 0, activeRuns: 0, pendingSlack: 0, failed: 0,
      failedRuns: 0, classifierDrift: 0, unthreadedMatched: 0 },
  ];
  const sleeps = [];
  const result = await waitForConversationLedger({
    timeoutMs: 1000, pollMs: 1,
    snapshot: () => snapshots.shift(),
    sleep: async delay => sleeps.push(delay),
  });
  assert.equal(result.events, 2);
  assert.deepEqual(sleeps, [1, 1]);
});

test('email ledger verification fails closed on classifier drift', async () => {
  await assert.rejects(waitForConversationLedger({
    snapshot: () => ({ active: 0, activeRuns: 0, pendingSlack: 0, failed: 0,
      failedRuns: 0, classifierDrift: 1, unthreadedMatched: 0 }),
  }), /verification failed/);
});
