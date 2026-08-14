'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { postSlackBlocks, postToChannel } = require('../lib/slack-post');

const CHANNEL = 'C123RECEIPT';
const THREAD = '1786734864.684019';
const BLOCKS = [
  {
    type: 'actions',
    block_id: 'receipt_payment_source_test',
    elements: [{
      type: 'button', action_id: 'receiptsource:personal',
      text: { type: 'plain_text', text: 'Reembolso personal', emoji: true },
      value: '4df5fc31-c9f8-4b30-8dcc-0a13482beedd',
    }],
  },
];

test('native Slack blocks are posted as Block Kit with provider readback', async () => {
  let request;
  const result = await postSlackBlocks(CHANNEL, 'Choose a payment source', {
    threadTs: THREAD,
    account: 'test-account',
    slackBlocks: BLOCKS,
    credential: { accountId: 'test-account', token: 'xoxb-test-token' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, channel: CHANNEL, ts: '1786735000.123456' }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ts, '1786735000.123456');
  assert.equal(request.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer xoxb-test-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    channel: CHANNEL,
    text: 'Choose a payment source',
    blocks: BLOCKS,
    thread_ts: THREAD,
  });
});

test('canonical Slack poster selects the native block path', async () => {
  let called = 0;
  const result = await postToChannel(CHANNEL, 'Choose a payment source', {
    threadTs: THREAD,
    account: 'test-account',
    slackBlocks: BLOCKS,
    credential: { accountId: 'test-account', token: 'xoxb-test-token' },
    fetchImpl: async () => {
      called += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, channel: CHANNEL, ts: '1786735001.123456' }),
      };
    },
  });

  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.equal(result.ts, '1786735001.123456');
});

test('Slack rejects are returned as failed delivery for outbox retry', async () => {
  const result = await postSlackBlocks(CHANNEL, 'Choose a payment source', {
    account: 'test-account',
    slackBlocks: BLOCKS,
    credential: { accountId: 'test-account', token: 'xoxb-test-token' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'invalid_blocks' }),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ts, null);
  assert.match(result.error, /invalid_blocks/);
});
