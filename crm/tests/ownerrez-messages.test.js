'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  readOwnerRezMessage,
  sendOwnerRezMessage,
} = require('../lib/ownerrez-messages');

test('OwnerRez message send uses the fixed endpoint and normalizes provider acceptance', async () => {
  let requestInput;
  const result = await sendOwnerRezMessage({
    threadId: 884422,
    body: 'Hello from the resort.',
    request: async input => {
      requestInput = input;
      return { ok: true, data: {
        id: 112025999, thread_id: 884422, body: 'Hello from the resort.',
        from_role: 'owner', date_utc: '2026-08-13T18:06:00Z', is_draft: false,
      } };
    },
  });
  assert.equal(requestInput.method, 'POST');
  assert.equal(requestInput.requestPath, '/v2/messages');
  assert.deepEqual(requestInput.body, { thread_id: 884422, body: 'Hello from the resort.' });
  assert.equal(result.id, '112025999');
  assert.equal(result.threadId, '884422');
});

test('OwnerRez readback requires the exact message on the exact thread', async () => {
  const result = await readOwnerRezMessage('112025999', '884422', {
    request: async input => ({ ok: true, data: { items: [
      { id: 112025998, thread_id: 884422, body: 'Earlier' },
      { id: 112025999, thread_id: 884422, body: 'Exact', from_role: 'owner' },
    ] } }),
  });
  assert.equal(result.body, 'Exact');
  await assert.rejects(readOwnerRezMessage('missing', '884422', {
    request: async () => ({ ok: true, data: { items: [] } }),
  }), /not visible/);
});

test('a network-level OwnerRez send result is ambiguous and never auto-retryable', async () => {
  await assert.rejects(sendOwnerRezMessage({
    threadId: 884422,
    body: 'One send only.',
    request: async () => { throw new Error('socket closed'); },
  }), error => error.code === 'ambiguous_external_result' && error.retryable === false);
});
