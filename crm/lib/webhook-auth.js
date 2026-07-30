'use strict';

const crypto = require('crypto');

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyHmacHex(rawBody, secret, signature, prefix = '') {
  if (!Buffer.isBuffer(rawBody) || !secret || !signature) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualText(`${prefix}${digest}`, signature);
}

function verifyMetaSignature(rawBody, appSecret, signature) {
  return verifyHmacHex(rawBody, appSecret, signature, 'sha256=');
}

function verifyCalSignature(rawBody, secret, signature) {
  return verifyHmacHex(rawBody, secret, signature);
}

// Twilio signs the exact webhook URL followed by every form parameter sorted
// by key, then HMAC-SHA1s the resulting UTF-8 string with the Account Auth
// Token. This mirrors Twilio's RequestValidator for flat form webhook bodies.
function verifyTwilioSignature(url, params, authToken, signature) {
  if (!url || !params || !authToken || !signature) return false;
  let payload = String(url);
  for (const key of Object.keys(params).sort()) {
    const raw = params[key];
    const values = Array.isArray(raw) ? [...raw].sort() : [raw];
    for (const value of values) payload += key + String(value ?? '');
  }
  const expected = crypto.createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
  return safeEqualText(expected, signature);
}

module.exports = {
  safeEqualText,
  verifyCalSignature,
  verifyMetaSignature,
  verifyTwilioSignature,
};
