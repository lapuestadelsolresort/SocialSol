'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSquarespaceClient } = require('../scripts/lib/squarespace-api');

test('requires a key and sends it only in the authorization header', () => {
  assert.throws(() => createSquarespaceClient(), /API key is required/);
});

test('paginates with a cursor and does not repeat incompatible filters', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        result: [{ id: 'one' }],
        pagination: { hasNextPage: true, nextPageCursor: 'cursor-2' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      result: [{ id: 'two' }], pagination: { hasNextPage: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createSquarespaceClient({
    apiKey: 'test-key', baseUrl: 'https://api.example.invalid', fetchImpl, maxRetries: 0,
  });
  const orders = await client.listOrders({
    modifiedAfter: '2026-08-01T00:00:00Z',
    modifiedBefore: '2026-08-02T00:00:00Z',
    paymentStates: 'PAID,PARTIALLY_PAID',
  });
  assert.deepEqual(orders.map(item => item.id), ['one', 'two']);
  assert.match(calls[0].url, /modifiedAfter=/);
  assert.match(calls[0].url, /PARTIALLY_PAID/);
  assert.match(calls[1].url, /cursor=cursor-2/);
  assert.doesNotMatch(calls[1].url, /modifiedAfter=/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(new URL(calls[0].url).searchParams.has('api_key'), false);
});
