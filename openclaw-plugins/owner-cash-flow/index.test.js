import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBeforeReplyHandler,
  isOwnerCashFlowQuestion,
  reportArgsFromPrompt,
} from './index.js';

test('detects booking cash-flow questions without claiming generic finance questions', () => {
  assert.equal(isOwnerCashFlowQuestion('What do future cashflows look like based on current bookings?'), true);
  assert.equal(isOwnerCashFlowQuestion('How much cash is still incoming from Airbnb bookings?'), true);
  assert.equal(isOwnerCashFlowQuestion('What is our forward booked revenue?'), true);
  assert.equal(isOwnerCashFlowQuestion('How much money is coming in from guest stays?'), true);
  assert.equal(isOwnerCashFlowQuestion('What upcoming payouts do we expect?'), true);
  assert.equal(isOwnerCashFlowQuestion('What is the current bank balance?'), false);
  assert.equal(isOwnerCashFlowQuestion('Summarize the latest bookings'), false);
  assert.equal(isOwnerCashFlowQuestion('How much money did we spend on direct mail?'), false);
});

test('passes only explicit ISO report windows to the canonical command', () => {
  assert.deepEqual(reportArgsFromPrompt('Cash flow from bookings as of 2026-08-10 through 2027-03-31'), [
    '--as-of', '2026-08-10', '--through', '2027-03-31',
  ]);
  assert.deepEqual(reportArgsFromPrompt('Cash flow from current bookings'), []);
});

test('short-circuits the model with the canonical report for configured agents', async () => {
  const calls = [];
  const handler = createBeforeReplyHandler({
    config: { agentIds: ['resort'], timeoutMs: 1234 },
    runReport: async params => { calls.push(params); return '*Canonical report*'; },
  });
  const result = await handler(
    { cleanedBody: 'What do future cash flows look like from current bookings?' },
    { trigger: 'user', agentId: 'resort', workspaceDir: '/workspace' }
  );
  assert.deepEqual(result, {
    handled: true,
    reply: { text: '*Canonical report*' },
    reason: 'deterministic_owner_cash_flow',
  });
  assert.deepEqual(calls, [{
    workspaceDir: '/workspace',
    relativePath: 'crm/scripts/owner-cash-flow.js',
    args: [],
    timeoutMs: 1234,
  }]);
  assert.equal(await handler(
    { cleanedBody: 'What do future cash flows look like from current bookings?' },
    { trigger: 'user', agentId: 'other', workspaceDir: '/workspace' }
  ), undefined);
});

test('fails closed instead of allowing a partial model answer', async () => {
  const handler = createBeforeReplyHandler({
    config: { agentIds: ['resort'] },
    runReport: async () => { throw new Error('test failure'); },
  });
  const result = await handler(
    { cleanedBody: 'Expected receipts from Airbnb bookings?' },
    { trigger: 'user', agentId: 'resort', workspaceDir: '/workspace' }
  );
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /temporarily unavailable/);
  assert.equal(result.reason, 'owner_cash_flow_report_failed_closed');
});
