'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRoleBasedEmail, verifyEmail } = require('./email-verification');

const goodMx = async () => [{ exchange: 'mx.example.com', priority: 10 }];
const provider = (status, sub_status = '') => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status, sub_status }),
});

test('role addresses are blocked before DNS or paid verification', async () => {
  let called = false;
  const result = await verifyEmail('info@example.com', {
    apiKey: 'test',
    resolveMx: async () => { called = true; return []; },
    fetchImpl: async () => { called = true; return {}; },
  });
  assert.equal(isRoleBasedEmail('INFO@example.com'), true);
  assert.equal(isRoleBasedEmail('hola@example.mx'), true);
  assert.equal(isRoleBasedEmail('weddings@example.com'), true);
  assert.equal(called, false);
  assert.deepEqual(
    { ok: result.ok, reason: result.reason, emailStatus: result.emailStatus },
    { ok: false, reason: 'role_based', emailStatus: 'risky' },
  );
});

test('named ZeroBounce-valid mailbox is eligible', async () => {
  const result = await verifyEmail('sarah@example.com', {
    apiKey: 'test', resolveMx: goodMx, fetchImpl: provider('valid'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.emailStatus, 'verified');
  assert.equal(result.quality, 'named_valid');
});

test('catch-all and do_not_mail results remain blocked by default', async () => {
  const catchAll = await verifyEmail('sarah@example.com', {
    apiKey: 'test', resolveMx: goodMx, fetchImpl: provider('catch-all'),
  });
  assert.equal(catchAll.ok, false);
  assert.equal(catchAll.emailStatus, 'risky');

  const doNotMail = await verifyEmail('sarah@example.com', {
    apiKey: 'test', resolveMx: goodMx, fetchImpl: provider('do_not_mail', 'role_based'),
  });
  assert.equal(doNotMail.ok, false);
  assert.equal(doNotMail.emailStatus, 'risky');
});

test('invalid provider result is terminal and verifier outage fails closed', async () => {
  const invalid = await verifyEmail('sarah@example.com', {
    apiKey: 'test', resolveMx: goodMx, fetchImpl: provider('invalid', 'mailbox_not_found'),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.emailStatus, 'invalid');

  const unavailable = await verifyEmail('sarah@example.com', {
    apiKey: null, resolveMx: goodMx,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'verifier_unavailable');
  assert.equal(unavailable.emailStatus, 'unknown');
});

test('transient DNS failure stays unknown while permanent no-MX is invalid', async () => {
  const transient = await verifyEmail('sarah@example.com', {
    apiKey: 'test',
    resolveMx: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); },
    fetchImpl: provider('valid'),
  });
  assert.equal(transient.emailStatus, 'unknown');

  const noMx = await verifyEmail('sarah@example.com', {
    apiKey: 'test',
    resolveMx: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); },
    fetchImpl: provider('valid'),
  });
  assert.equal(noMx.emailStatus, 'invalid');
});
