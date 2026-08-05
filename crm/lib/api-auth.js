'use strict';
//
// api-auth.js — default-deny guard for the resort CRM API.
//
// Every /api/* route is protected unless explicitly allowlisted below. This
// keeps newly-added admin routes from becoming public by omission.
//
// Policy:
//   - loopback requests pass without credentials (local dashboards/scripts);
//   - public browser telemetry is limited to /api/track and /api/lp/config;
//   - all other /api/* routes require HTTP Basic auth from
//     workspace/secrets/resort-api-auth.json or crm/secrets/api-auth.json;
//   - if credentials are absent, remote access fails closed.
//

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRET_CANDIDATES = [
  path.join(SECRETS_DIR, 'resort-api-auth.json'),
  path.join(__dirname, '..', '..', 'secrets', 'api-auth.json'),
];

const PUBLIC_API_PATHS = new Set([
  '/api/track',
  '/api/track/',
  '/api/lp/config',
  '/api/lp/config/',
  '/api/ownerrez/webhook',
  '/api/ownerrez/webhook/',
]);

let CREDS = null;
for (const candidate of SECRET_CANDIDATES) {
  try {
    const c = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (c && c.user && c.pass) {
      CREDS = c;
      break;
    }
  } catch (e) { /* try next */ }
}
if (CREDS) {
  console.log('[api-auth] credentials loaded — remote internal APIs require Basic auth');
} else {
  console.warn('[api-auth] no credentials found — remote internal APIs are disabled (fail closed)');
}

function isLoopback(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.')
  );
}

function isPublicApi(reqPath) {
  return PUBLIC_API_PATHS.has(reqPath);
}

function isProtected(reqPath) {
  return reqPath === '/api' || (reqPath.startsWith('/api/') && !isPublicApi(reqPath));
}

function parseBasic(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch (e) {
    return null;
  }
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function guardProtected(req, res, next) {
  if (!isProtected(req.path)) return next();
  if (isLoopback(req)) {
    req.internalApiAuthorized = true;
    return next();
  }

  if (!CREDS) {
    return res.status(503).json({ error: 'internal API not available remotely' });
  }
  const creds = parseBasic(req);
  if (!creds || !safeEqual(creds.user, CREDS.user) || !safeEqual(creds.pass, CREDS.pass)) {
    res.set('WWW-Authenticate', 'Basic realm="La Puesta del Sol Internal API"');
    return res.status(401).json({ error: 'authentication required' });
  }
  req.internalApiAuthorized = true;
  return next();
}

module.exports = {
  guardProtected,
  isLoopback,
  isProtected,
  isPublicApi,
  PUBLIC_API_PATHS,
};
