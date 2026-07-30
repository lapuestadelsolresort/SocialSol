'use strict';
//
// gmail-client.js — Gmail API client backed by service-account + DWD.
//
// Auth is provisioned out-of-band with domain-wide delegation and the
// gmail.readonly scope. The service-account JSON must remain outside git.
//
// CRITICAL: load the JSON manually and pass client_email + private_key
// explicitly to google.auth.JWT. Do NOT use { keyFile: ... } / keyFilename —
// that path errors with "Invalid issuer: null" against impersonation.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRET_PATH = path.join(SECRETS_DIR, 'gmail-service-account.json');
const IMPERSONATE_USER = process.env.GMAIL_IMPERSONATE_USER || '';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

let _cachedClient = null;

function loadServiceAccount() {
  let raw;
  try {
    raw = fs.readFileSync(SECRET_PATH, 'utf8');
  } catch (e) {
    throw new Error(`Gmail SA key not readable at ${SECRET_PATH}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed JSON in ${SECRET_PATH}: ${e.message}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(`Missing client_email or private_key in ${SECRET_PATH}`);
  }
  return parsed;
}

function getGmailClient() {
  if (_cachedClient) return _cachedClient;
  if (!IMPERSONATE_USER) {
    throw new Error('GMAIL_IMPERSONATE_USER is not configured');
  }
  const sa = loadServiceAccount();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: SCOPES,
    subject: IMPERSONATE_USER,
  });
  _cachedClient = google.gmail({ version: 'v1', auth });
  return _cachedClient;
}

// Decode a Gmail API base64url body to text. Gmail returns body data as
// base64url-encoded UTF-8.
function decodeBody(b64url) {
  if (!b64url) return '';
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Walk message payload parts to find the first text/plain body.
// Falls back to text/html if no plain part. Returns ''  if neither.
function extractTextBody(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data && (payload.mimeType || '').startsWith('text/plain')) {
    return decodeBody(payload.body.data);
  }
  const parts = payload.parts || [];
  for (const p of parts) {
    if ((p.mimeType || '').startsWith('text/plain') && p.body && p.body.data) {
      return decodeBody(p.body.data);
    }
    if (p.parts) {
      const nested = extractTextBody(p);
      if (nested) return nested;
    }
  }
  // Fallback: first text/html part with crude tag-strip.
  for (const p of parts) {
    if ((p.mimeType || '').startsWith('text/html') && p.body && p.body.data) {
      return decodeBody(p.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (p.parts) {
      const nested = extractTextBody(p);
      if (nested) return nested;
    }
  }
  return '';
}

function header(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const found = headers.find((h) => (h.name || '').toLowerCase() === lower);
  return found ? found.value : null;
}

// Parse an RFC 5322 From header into { name, address }. Handles the common
// shapes:
//   "Display Name" <addr@x.com>
//   Display Name <addr@x.com>
//   <addr@x.com>
//   addr@x.com
function parseAddress(value) {
  if (!value) return { name: '', address: '' };
  const s = String(value).trim();
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    return { name, address: m[2].trim() };
  }
  return { name: '', address: s };
}

/**
 * List Sarah's Sent messages within the last `days` days.
 *
 * @param {number} days
 * @param {object} [opts]
 * @param {string} [opts.toFilter]  Additional 'to:<email>' constraint.
 * @returns {Promise<Array<{id, to, from, subject, body, sent_at}>>}
 */
async function searchSentSince(days, opts = {}) {
  const gmail = getGmailClient();
  const dayCount = Math.max(1, Math.min(30, Number(days) || 7));

  let q = `in:sent newer_than:${dayCount}d`;
  if (opts.toFilter) q += ` to:${opts.toFilter}`;

  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 100,
  });
  const ids = (list.data.messages || []).map((m) => m.id);
  if (ids.length === 0) return [];

  const out = [];
  for (const id of ids) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const payload = full.data.payload || {};
    const body = extractTextBody(payload);
    out.push({
      id,
      to: header(payload.headers, 'To'),
      from: header(payload.headers, 'From'),
      subject: header(payload.headers, 'Subject'),
      body,
      sent_at: full.data.internalDate
        ? new Date(Number(full.data.internalDate)).toISOString()
        : null,
    });
  }
  return out;
}

/**
 * List Sarah's Inbox messages received within the last `minutes` minutes.
 * Used by gmail-reply-forwarder to feed /webhook/resend-reply.
 *
 * Query: `in:inbox -in:chats -in:sent after:<epoch>` (Gmail's `newer_than:`
 * unit codes are d/m/y — month, not minute — so we use `after:` with a
 * Unix-seconds timestamp for real minute-level granularity).
 * Messages are NOT marked read (scope is gmail.readonly anyway).
 *
 * @param {number} minutes
 * @returns {Promise<Array<{
 *   id: string,
 *   messageId: string|null,
 *   from: {name: string, address: string},
 *   to: string|null,
 *   subject: string|null,
 *   text: string,
 *   internalDate: string|null,
 *   inReplyTo: string|null,
 *   references: string|null
 * }>>}
 */
async function searchInboxSince(minutes) {
  const gmail = getGmailClient();
  const mins = Math.max(1, Number(minutes) || 60);

  const afterEpoch = Math.floor((Date.now() - mins * 60 * 1000) / 1000);
  const q = `in:inbox -in:chats -in:sent after:${afterEpoch}`;

  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 100,
  });
  const ids = (list.data.messages || []).map((m) => m.id);
  if (ids.length === 0) return [];

  const out = [];
  for (const id of ids) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const payload = full.data.payload || {};
    const fromRaw = header(payload.headers, 'From');
    const from = parseAddress(fromRaw);
    out.push({
      id,
      messageId: header(payload.headers, 'Message-ID'),
      from,
      to: header(payload.headers, 'To'),
      subject: header(payload.headers, 'Subject'),
      text: extractTextBody(payload),
      internalDate: full.data.internalDate
        ? new Date(Number(full.data.internalDate)).toISOString()
        : null,
      inReplyTo: header(payload.headers, 'In-Reply-To'),
      references: header(payload.headers, 'References'),
    });
  }
  return out;
}

module.exports = {
  searchSentSince,
  searchInboxSince,
  getGmailClient,
  loadServiceAccount, // exported for tests
  SECRET_PATH,
  IMPERSONATE_USER,
  SCOPES,
  // exported for tests
  _internal: { decodeBody, extractTextBody, header, parseAddress },
};
