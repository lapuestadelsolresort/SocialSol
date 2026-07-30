'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { isProtected, isPublicApi } = require('../lib/api-auth');
const {
  verifyCalSignature,
  verifyMetaSignature,
  verifyTwilioSignature,
} = require('../lib/webhook-auth');

test('API policy only exposes LP config and telemetry', () => {
  assert.equal(isPublicApi('/api/track'), true);
  assert.equal(isPublicApi('/api/lp/config'), true);
  assert.equal(isProtected('/api/contacts'), true);
  assert.equal(isProtected('/api/outreach-sends'), true);
  assert.equal(isProtected('/api/whatsapp/reply'), true);
  assert.equal(isProtected('/api/meta-dm/reply'), true);
  assert.equal(isProtected('/api/lp/stats'), true);
});

test('Meta signature accepts exact raw bytes and rejects tampering', () => {
  const secret = 'meta-secret';
  const raw = Buffer.from('{"object":"page","entry":[]}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifyMetaSignature(raw, secret, signature), true);
  assert.equal(verifyMetaSignature(Buffer.from('{"object":"page"}'), secret, signature), false);
});

test('Cal.com signature accepts exact raw bytes and rejects tampering', () => {
  const secret = 'cal-secret';
  const raw = Buffer.from('{"triggerEvent":"BOOKING_CREATED"}');
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyCalSignature(raw, secret, signature), true);
  assert.equal(verifyCalSignature(Buffer.from('{}'), secret, signature), false);
});

test('Twilio signature binds URL and sorted form parameters', () => {
  const token = 'twilio-auth-token';
  const url = 'https://webhook.lapuestadelsolresort.com/webhook/twilio-whatsapp/webhook';
  const params = {
    AccountSid: 'AC123',
    Body: 'Hello',
    From: 'whatsapp:+15551234567',
    MessageSid: 'SM123',
  };
  const payload = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
  const signature = crypto.createHmac('sha1', token).update(payload).digest('base64');
  assert.equal(verifyTwilioSignature(url, params, token, signature), true);
  assert.equal(verifyTwilioSignature(url, { ...params, Body: 'Changed' }, token, signature), false);
});
