/**
 * QuickBooks OAuth state — signed, session-free CSRF protection.
 * Creates a signed state token for the OAuth flow and verifies it in the callback.
 */
const crypto = require('crypto');

// Use a dedicated signing secret, fall back to a generated one on first run
const SIGNING_SECRET = process.env.QBO_STATE_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(data, secret) {
  return base64url(
    crypto.createHmac('sha256', secret).update(data).digest()
  );
}

function createState() {
  const payloadObj = {
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
  };
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = sign(payload, SIGNING_SECRET);
  return `${payload}.${sig}`;
}

function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
  const parts = (state || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad_format' };

  const [payload, sig] = parts;
  const expected = sign(payload, SIGNING_SECRET);

  if (sig.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, reason: 'bad_signature' };
  }

  try {
    const decoded = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const obj = JSON.parse(decoded);
    if (Date.now() - obj.iat > maxAgeMs) return { ok: false, reason: 'expired' };
    return { ok: true, data: obj };
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
}

module.exports = { createState, verifyState };
