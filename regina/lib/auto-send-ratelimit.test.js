/**
 * Regression tests for Regina's Resend rate-limit handling (F-050b).
 *
 * A 429 used to cancel the row immediately with the comment "a later batch
 * can retry safely". For anniversary sends there is no later batch —
 * eligibility matches on the anniversary MM-DD, so the contact was silently
 * skipped for the year. The send is now retried in-run first; the retried
 * POST carries the same Idempotency-Key, so it cannot produce a second email.
 *
 * Run: node regina/lib/auto-send-ratelimit.test.js
 * Expect: every assertion passes; final line "✓ ALL TESTS PASSED".
 */

'use strict';

const {
  postWithRateLimitRetry,
  rateLimitWaitMs,
  RATE_LIMIT_MAX_RETRIES,
} = require('./auto-send');

let passed = 0;
let failed = 0;

function assert(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

function response(status, body = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}

const REQUEST = { url: 'https://api.resend.com/emails', init: { method: 'POST' } };

async function testRetriesThenSucceeds() {
  console.log('\n=== 429 twice then 200 → send succeeds, one email ===');
  const calls = [];
  const slept = [];
  const queue = [response(429), response(429), response(200, { id: 'email_123' })];
  const out = await postWithRateLimitRetry(REQUEST, {
    fetchImpl: async (url, init) => { calls.push({ url, init }); return queue.shift(); },
    sleepImpl: async (ms) => { slept.push(ms); },
  });

  assert(calls.length === 3, 'POSTed three times', calls.length);
  assert(out.resp.status === 200, 'final response is the 200', out.resp.status);
  assert(out.body.id === 'email_123', 'body comes from the successful attempt', out.body);
  assert(out.retries === 2, 'reports two retries', out.retries);
  assert(slept.length === 2, 'slept between attempts', slept);
  assert(calls.every((c) => c.url === REQUEST.url), 'same endpoint every time');
}

async function testGivesUpAfterMaxRetries() {
  console.log('\n=== 429 on every attempt → gives up and reports the 429 ===');
  const calls = [];
  const out = await postWithRateLimitRetry(REQUEST, {
    fetchImpl: async () => { calls.push(1); return response(429); },
    sleepImpl: async () => {},
  });

  assert(calls.length === RATE_LIMIT_MAX_RETRIES + 1, 'attempts = 1 + max retries', calls.length);
  assert(out.resp.status === 429, 'caller sees the 429 and cancels the row', out.resp.status);
  assert(out.retries === RATE_LIMIT_MAX_RETRIES, 'retry count reported', out.retries);
}

async function testNoRetryOnOtherStatuses() {
  console.log('\n=== non-429 responses are never retried ===');
  for (const status of [200, 422, 500]) {
    const calls = [];
    await postWithRateLimitRetry(REQUEST, {
      fetchImpl: async () => { calls.push(1); return response(status); },
      sleepImpl: async () => {},
    });
    assert(calls.length === 1, `HTTP ${status} → single attempt`, calls.length);
  }
}

async function testNetworkErrorPropagates() {
  console.log('\n=== a network throw still reaches the ambiguous path ===');
  let threw = false;
  try {
    await postWithRateLimitRetry(REQUEST, {
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
      sleepImpl: async () => {},
    });
  } catch (e) {
    threw = e.message === 'ECONNRESET';
  }
  assert(threw, 'throw propagates unchanged (caller marks the row ambiguous)');
}

async function testWaitComputation() {
  console.log('\n=== wait time honors retry-after and stays bounded ===');
  assert(rateLimitWaitMs(response(429, {}, {}), 1) === 1000, 'default backoff is linear', rateLimitWaitMs(response(429), 1));
  assert(rateLimitWaitMs(response(429, {}, {}), 2) === 2000, 'second retry waits longer');
  assert(
    rateLimitWaitMs(response(429, {}, { 'retry-after': '3' }), 1) === 3000,
    'retry-after seconds are honored',
  );
  assert(
    rateLimitWaitMs(response(429, {}, { 'retry-after': '9999' }), 1) === 10_000,
    'a hostile retry-after cannot stall the run',
  );
  assert(
    rateLimitWaitMs(response(429, {}, { 'retry-after': 'soon' }), 1) === 1000,
    'an unparseable retry-after falls back to backoff',
  );
}

async function main() {
  await testRetriesThenSucceeds();
  await testGivesUpAfterMaxRetries();
  await testNoRetryOnOtherStatuses();
  await testNetworkErrorPropagates();
  await testWaitComputation();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('✗ TESTS FAILED');
    process.exit(1);
  }
  console.log('✓ ALL TESTS PASSED');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
