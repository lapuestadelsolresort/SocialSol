'use strict';

const dns = require('node:dns').promises;

// Generic inboxes are useful for customer support, but are materially riskier
// for cold outreach. They are rejected before a paid verification lookup so a
// queue full of info@ addresses cannot consume credits or sender reputation.
const ROLE_PREFIXES = new Set([
  'hello', 'info', 'contact', 'team', 'hi', 'mail', 'admin', 'support',
  'sales', 'marketing', 'office', 'enquiries', 'enquiry', 'inquiries',
  'inquiry', 'general', 'webmaster', 'postmaster', 'noreply', 'no-reply',
  'careers', 'jobs', 'billing', 'accounts', 'hr', 'press', 'media',
  'bookings', 'booking', 'events', 'reservations', 'wedding', 'weddings',
  // Spanish equivalents common in the Mexico planner queue.
  'hola', 'contacto', 'ventas', 'eventos', 'reservas', 'bodas', 'banquetes',
]);

function parseEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const match = normalized.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!match) return null;
  return { normalized, prefix: match[1], domain: match[2] };
}

function isRoleBasedEmail(email) {
  const parsed = parseEmail(email);
  return Boolean(parsed && ROLE_PREFIXES.has(parsed.prefix));
}

function blocked(reason, emailStatus, detail, extra = {}) {
  return { ok: false, reason, emailStatus, detail, ...extra };
}

function allowed(emailStatus = 'verified', quality = 'named_valid', extra = {}) {
  return { ok: true, emailStatus, quality, ...extra };
}

/**
 * Verify one recipient using syntax, role-prefix, MX, then ZeroBounce.
 *
 * The default is deliberately fail-closed. A transient verifier outage leaves
 * the contact at `unknown`; it never turns an unverified address into a send.
 * Dependencies are injectable so the policy can be tested without DNS/API I/O.
 */
async function verifyEmail(email, options = {}) {
  const {
    allowRoleEmails = false,
    allowCatchAll = false,
    failClosed = true,
    apiKey = null,
    resolveMx = dns.resolveMx,
    fetchImpl = globalThis.fetch,
    logger = null,
  } = options;

  const parsed = parseEmail(email);
  if (!parsed) return blocked('invalid_format', 'invalid', 'Email format is invalid');

  const roleBased = ROLE_PREFIXES.has(parsed.prefix);
  if (roleBased && !allowRoleEmails) {
    return blocked(
      'role_based',
      'risky',
      `"${parsed.prefix}@" is a generic role inbox`,
      { quality: 'role' },
    );
  }

  try {
    const mx = await resolveMx(parsed.domain);
    if (!Array.isArray(mx) || mx.length === 0) {
      return blocked('no_mx', 'invalid', `No MX records for ${parsed.domain}`);
    }
  } catch (error) {
    const permanent = new Set(['ENODATA', 'ENOTFOUND', 'ENOTIMP']).has(error?.code);
    return blocked(
      permanent ? 'no_mx' : 'mx_lookup_failed',
      permanent ? 'invalid' : 'unknown',
      error?.message || `MX lookup failed for ${parsed.domain}`,
    );
  }

  if (!apiKey || typeof fetchImpl !== 'function') {
    if (failClosed) {
      return blocked(
        'verifier_unavailable',
        'unknown',
        'ZeroBounce verification is unavailable; fail-closed policy blocked the address',
      );
    }
    return allowed('verified', roleBased ? 'role_mx_only' : 'named_mx_only', {
      warning: 'verifier_unavailable',
    });
  }

  let response;
  let payload;
  try {
    response = await fetchImpl(
      `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}` +
        `&email=${encodeURIComponent(parsed.normalized)}&ip_address=`,
    );
    payload = await response.json();
    if (!response.ok) throw new Error(payload?.message || `ZeroBounce HTTP ${response.status}`);
  } catch (error) {
    logger?.(`ZeroBounce lookup failed for ${parsed.normalized}: ${error.message}`);
    if (failClosed) {
      return blocked('verifier_error', 'unknown', error.message || 'ZeroBounce lookup failed');
    }
    return allowed('verified', roleBased ? 'role_mx_only' : 'named_mx_only', {
      warning: 'verifier_error',
    });
  }

  const providerStatus = String(payload?.status || 'unknown').toLowerCase();
  const subStatus = String(payload?.sub_status || '').toLowerCase();
  const provider = { providerStatus, subStatus };
  logger?.(
    `ZeroBounce ${parsed.normalized}: status=${providerStatus}` +
      `${subStatus ? ` sub_status=${subStatus}` : ''}`,
  );

  if (providerStatus === 'valid') {
    return allowed('verified', roleBased ? 'role_valid' : 'named_valid', provider);
  }

  if (providerStatus === 'catch-all') {
    if (!allowCatchAll) {
      return blocked(
        'catch_all',
        'risky',
        `ZeroBounce: catch-all${subStatus ? ` (${subStatus})` : ''}`,
        { quality: 'catch_all', ...provider },
      );
    }
    return allowed('verified', roleBased ? 'role_catch_all' : 'named_catch_all', provider);
  }

  if (providerStatus === 'do_not_mail') {
    const isProviderRole = subStatus.includes('role');
    if (allowRoleEmails && (roleBased || isProviderRole)) {
      return allowed('verified', 'role_do_not_mail_override', provider);
    }
    return blocked(
      'do_not_mail',
      'risky',
      `ZeroBounce: do_not_mail${subStatus ? ` (${subStatus})` : ''}`,
      { quality: isProviderRole ? 'role' : 'do_not_mail', ...provider },
    );
  }

  if (new Set(['invalid', 'spamtrap', 'abuse']).has(providerStatus)) {
    return blocked(
      `zerobounce_${providerStatus}`,
      'invalid',
      `ZeroBounce: ${providerStatus}${subStatus ? ` (${subStatus})` : ''}`,
      provider,
    );
  }

  if (failClosed) {
    return blocked(
      `zerobounce_${providerStatus || 'unknown'}`,
      'unknown',
      `ZeroBounce returned ${providerStatus || 'unknown'}${subStatus ? ` (${subStatus})` : ''}`,
      provider,
    );
  }
  return allowed('verified', roleBased ? 'role_unknown' : 'named_unknown', {
    warning: `zerobounce_${providerStatus || 'unknown'}`,
    ...provider,
  });
}

module.exports = {
  ROLE_PREFIXES,
  isRoleBasedEmail,
  parseEmail,
  verifyEmail,
};
