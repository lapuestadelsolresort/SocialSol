/**
 * Unsubscribe token generation + verification.
 *
 * Token format: {contactId}.{campaignName}.{base64url_hmac}
 *   contactId    — integer PK from contacts
 *   campaignName — outreach_campaigns.name (e.g. 'planner_outreach_v1');
 *                  the spec called this "campaign_id" generically, but the
 *                  schema column is `name`. Either term refers to the same
 *                  string identifier.
 *   hmac         — base64url(HMAC-SHA256("{contactId}.{campaignName}", secret))
 *
 * No timestamp, no expiry. Unsubscribe links must work indefinitely.
 * Stateless — no tokens table.
 *
 * Boot-time secret loading is warn-and-degrade (matches the Resend Svix
 * pattern in server.js). When the secret isn't loaded, verifyUnsubscribeToken
 * returns {valid: false} for every input — fail-closed at request time. The
 * endpoint serves the generic "invalid link" page until the secret is set.
 */

const crypto = require('crypto');

let secret = null;

function setSecret(s) {
  secret = s || null;
}

function base64urlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  // Restore padding
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function generateUnsubscribeToken(contactId, campaignName) {
  if (!secret) {
    throw new Error('generateUnsubscribeToken: no secret loaded — cannot sign');
  }
  if (!Number.isInteger(contactId) || contactId < 0) {
    throw new Error('generateUnsubscribeToken: contactId must be a non-negative integer');
  }
  if (typeof campaignName !== 'string' || !campaignName) {
    throw new Error('generateUnsubscribeToken: campaignName must be a non-empty string');
  }
  if (campaignName.includes('.')) {
    // The token uses '.' as separator; campaign names with dots would break parsing.
    throw new Error('generateUnsubscribeToken: campaignName must not contain "."');
  }
  const payload = `${contactId}.${campaignName}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${base64urlEncode(mac)}`;
}

/**
 * Verify a token. Never throws.
 * Returns { valid: bool, contactId: int|null, campaignName: string|null }.
 *
 * Returns {valid: false, contactId: null, campaignName: null} for any
 * malformed input or signature mismatch. Returns the same when no secret
 * is loaded — endpoint runs in degraded mode.
 */
function verifyUnsubscribeToken(token) {
  const fail = { valid: false, contactId: null, campaignName: null };

  if (!secret) return fail;
  if (typeof token !== 'string' || !token) return fail;

  // Token has exactly two '.' separators (format: id.campaign.hmac)
  // Use indexOf-based split to allow campaignName to contain other characters
  // (we already ban '.' in generation).
  const firstDot = token.indexOf('.');
  if (firstDot < 1) return fail;
  const lastDot = token.lastIndexOf('.');
  if (lastDot === firstDot) return fail; // only one '.' present

  const idPart = token.slice(0, firstDot);
  const campaignName = token.slice(firstDot + 1, lastDot);
  const hmacB64 = token.slice(lastDot + 1);

  if (!/^\d+$/.test(idPart)) return fail;
  if (!campaignName) return fail;
  if (!hmacB64 || !/^[A-Za-z0-9_-]+$/.test(hmacB64)) return fail;

  const contactId = parseInt(idPart, 10);
  if (!Number.isFinite(contactId)) return fail;

  let providedMac;
  try {
    providedMac = base64urlDecode(hmacB64);
  } catch (e) {
    return fail;
  }

  const payload = `${contactId}.${campaignName}`;
  const expectedMac = crypto.createHmac('sha256', secret).update(payload).digest();

  // timingSafeEqual requires equal-length buffers; bail out before calling it
  // otherwise it throws.
  if (providedMac.length !== expectedMac.length) return fail;

  if (!crypto.timingSafeEqual(providedMac, expectedMac)) return fail;

  return { valid: true, contactId, campaignName };
}

/**
 * Hash a token for audit logging — never log the full token. SHA-256 of the
 * token string, first 8 hex chars. Enough to correlate logs without exposing
 * the actual unsubscribe credential.
 */
function tokenHashForLog(token) {
  if (typeof token !== 'string' || !token) return 'no-token';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}

module.exports = {
  setSecret,
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  tokenHashForLog,
};
