'use strict';
//
// gmail-client.js — Gmail API client backed by service-account + DWD.
//
// Auth is provisioned out-of-band with domain-wide delegation. Mailbox polling
// uses gmail.readonly; the confirmation-gated reply graph requests
// gmail.readonly + gmail.send so it can perform a Sent-folder readback. The
// service-account JSON must remain outside git.
//
// CRITICAL: load the JSON manually and pass client_email + private_key
// explicitly to google.auth.JWT. Do NOT use { keyFile: ... } / keyFilename —
// that path errors with "Invalid issuer: null" against impersonation.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { ROOT: REPO_ROOT, SECRETS_DIR } = require('../../lib/runtime-paths');

const SECRET_PATH = path.join(SECRETS_DIR, 'gmail-service-account.json');
let IMPERSONATE_USER = process.env.GMAIL_IMPERSONATE_USER || '';
if (!IMPERSONATE_USER) {
  try {
    IMPERSONATE_USER = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prospector', 'config.json'), 'utf8')).sender_reply_to || '';
  } catch {}
}
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const SEND_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

const _cachedClients = new Map();

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

function getGmailClient(scopes = SCOPES) {
  const scopeList = [...new Set(scopes)].sort();
  const cacheKey = scopeList.join(' ');
  if (_cachedClients.has(cacheKey)) return _cachedClients.get(cacheKey);
  if (!IMPERSONATE_USER) {
    throw new Error('GMAIL_IMPERSONATE_USER is not configured');
  }
  const sa = loadServiceAccount();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: scopeList,
    subject: IMPERSONATE_USER,
  });
  const client = google.gmail({ version: 'v1', auth });
  _cachedClients.set(cacheKey, client);
  return client;
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

async function listMessageIds(gmail, q, maxResults = 500, { includeSpamTrash = false } = {}) {
  const limit = Math.max(1, Math.min(5000, Number(maxResults) || 500));
  const ids = [];
  let pageToken;
  do {
    const list = await gmail.users.messages.list({
      userId: 'me', q, maxResults: Math.min(500, limit - ids.length), pageToken,
      includeSpamTrash,
    });
    ids.push(...(list.data.messages || []).map(message => message.id));
    pageToken = list.data.nextPageToken || null;
  } while (pageToken && ids.length < limit);
  return ids.slice(0, limit);
}

async function getMessageById(id, { scopes = SCOPES, gmail: suppliedGmail = null } = {}) {
  const gmail = suppliedGmail || getGmailClient(scopes);
  const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const payload = full.data.payload || {};
  return {
    id: full.data.id,
    threadId: full.data.threadId || null,
    labelIds: full.data.labelIds || [],
    messageId: header(payload.headers, 'Message-ID'),
    from: parseAddress(header(payload.headers, 'From')),
    to: header(payload.headers, 'To'),
    subject: header(payload.headers, 'Subject'),
    text: extractTextBody(payload),
    internalDate: full.data.internalDate
      ? new Date(Number(full.data.internalDate)).toISOString()
      : null,
    inReplyTo: header(payload.headers, 'In-Reply-To'),
    references: header(payload.headers, 'References'),
  };
}

async function loadMessages(ids, options = {}) {
  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency) || 10));
  const out = [];
  for (let index = 0; index < ids.length; index += concurrency) {
    const chunk = ids.slice(index, index + concurrency);
    out.push(...await Promise.all(chunk.map(id => getMessageById(id, options))));
  }
  return out;
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

  const ids = await listMessageIds(gmail, q, 500);
  if (ids.length === 0) return [];
  const messages = await loadMessages(ids);
  return messages.map(message => ({
    id: message.id,
    threadId: message.threadId,
    messageId: message.messageId,
    to: message.to,
    from: message.from?.address || '',
    subject: message.subject,
    body: message.text,
    sent_at: message.internalDate,
    inReplyTo: message.inReplyTo,
    references: message.references,
  }));
}

/**
 * List messages received by Sarah within the last `minutes` minutes, including
 * mail that has already been archived out of Inbox.
 * Used by gmail-reply-forwarder to feed /webhook/resend-reply.
 *
 * Query: `-in:trash -in:chats -in:sent after:<epoch>` (Gmail's `newer_than:`
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
  const q = `-in:trash -in:chats -in:sent after:${afterEpoch}`;

  // Gmail excludes Spam from list results unless includeSpamTrash is set.
  // Sarah's console intentionally mirrors received spam for visibility, while
  // the explicit query exclusion keeps deleted mail out of the console.
  const ids = await listMessageIds(gmail, q, 500, { includeSpamTrash: true });
  if (ids.length === 0) return [];
  return loadMessages(ids);
}

async function searchSentSinceMinutes(minutes) {
  const gmail = getGmailClient();
  const mins = Math.max(1, Number(minutes) || 60);
  const afterEpoch = Math.floor((Date.now() - mins * 60 * 1000) / 1000);
  const ids = await listMessageIds(gmail, `in:sent after:${afterEpoch}`, 500);
  return loadMessages(ids);
}

async function searchMailboxSinceDays(days, { maxResults = 5000 } = {}) {
  const gmail = getGmailClient();
  const dayCount = Math.max(1, Math.min(3650, Number(days) || 365));
  const [inboxIds, sentIds] = await Promise.all([
    listMessageIds(gmail, `-in:chats -in:sent newer_than:${dayCount}d`, maxResults),
    listMessageIds(gmail, `in:sent newer_than:${dayCount}d`, maxResults),
  ]);
  const [inbox, sent] = await Promise.all([loadMessages(inboxIds), loadMessages(sentIds)]);
  return { inbox, sent };
}

/**
 * Read Sarah's mailbox activity inside an exact UTC instant window. Callers
 * are responsible for converting their business-local dates to UTC instants.
 * This is read-only and deliberately excludes Trash, Chats, and Drafts.
 */
async function searchEmailActivity({ start, end, direction = 'inbound', limit = 25 }, options = {}) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('email activity requires a valid start/end instant window');
  }
  if (!['inbound', 'outbound', 'all'].includes(direction)) {
    throw new Error('email activity direction must be inbound, outbound, or all');
  }

  const gmail = options.gmail || getGmailClient();
  const displayLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const scanLimit = Math.max(100, displayLimit);
  const after = Math.max(0, Math.floor(startMs / 1000) - 1);
  const before = Math.ceil(endMs / 1000);
  const searches = [];

  if (direction === 'inbound' || direction === 'all') {
    searches.push({
      direction: 'inbound',
      query: `-in:trash -in:chats -in:sent -in:drafts after:${after} before:${before}`,
      includeSpamTrash: true,
    });
  }
  if (direction === 'outbound' || direction === 'all') {
    searches.push({
      direction: 'outbound',
      query: `in:sent -in:drafts after:${after} before:${before}`,
      includeSpamTrash: false,
    });
  }

  const batches = await Promise.all(searches.map(async search => {
    const ids = await listMessageIds(gmail, search.query, scanLimit, {
      includeSpamTrash: search.includeSpamTrash,
    });
    const messages = await loadMessages(ids, { gmail });
    return {
      direction: search.direction,
      truncated: ids.length >= scanLimit,
      messages: messages.filter(message => {
        const timestamp = Date.parse(message.internalDate || '');
        return Number.isFinite(timestamp) && timestamp >= startMs && timestamp < endMs;
      }),
    };
  }));

  const messages = batches.flatMap(batch => batch.messages.map(message => ({
    ...message,
    direction: batch.direction,
  }))).sort((left, right) => (
    String(right.internalDate || '').localeCompare(String(left.internalDate || ''))
    || String(right.id || '').localeCompare(String(left.id || ''))
  ));

  return {
    messages: messages.slice(0, displayLimit),
    total: messages.length,
    inbound: messages.filter(message => message.direction === 'inbound').length,
    outbound: messages.filter(message => message.direction === 'outbound').length,
    unread: messages.filter(message => Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD')).length,
    spam: messages.filter(message => Array.isArray(message.labelIds) && message.labelIds.includes('SPAM')).length,
    truncated: batches.some(batch => batch.truncated) || messages.length > displayLimit,
    displayLimit,
  };
}

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

// RFC 5322 headers are ASCII. Encode any Unicode header value as adjacent
// RFC 2047 encoded-words, each within the 75-character encoded-word limit.
// Separating folded encoded-words with linear whitespace is display-neutral.
function encodeMimeHeader(value) {
  const cleaned = cleanHeader(value);
  if (!/[^\x20-\x7e]/.test(cleaned)) return cleaned;
  const chunks = [];
  let chunk = '';
  for (const character of cleaned) {
    const candidate = chunk + character;
    if (chunk && Buffer.byteLength(candidate, 'utf8') > 45) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(part => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

function encodeRawMessage({ from, to, subject, body, inReplyTo, references, messageId }) {
  const headers = [
    `From: ${cleanHeader(from)}`,
    `To: ${cleanHeader(to)}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    ...(messageId ? [`Message-ID: <${cleanHeader(messageId).replace(/^<|>$/g, '')}>`] : []),
    ...(inReplyTo ? [`In-Reply-To: <${cleanHeader(inReplyTo).replace(/^<|>$/g, '')}>`] : []),
    ...(references ? [`References: ${cleanHeader(references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const raw = `${headers.join('\r\n')}\r\n\r\n${String(body || '').replace(/\r?\n/g, '\r\n')}\r\n`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

async function sendGmailReply({ to, subject, body, threadId, inReplyTo, references, messageId }) {
  const gmail = getGmailClient(SEND_SCOPES);
  const raw = encodeRawMessage({
    from: IMPERSONATE_USER,
    to,
    subject,
    body,
    inReplyTo,
    references,
    messageId,
  });
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, ...(threadId ? { threadId } : {}) },
  });
  if (!response.data?.id) {
    const error = new Error('Gmail accepted no durable message id');
    error.code = 'ambiguous_external_result';
    throw error;
  }
  return {
    id: response.data.id,
    threadId: response.data.threadId || threadId || null,
    labelIds: response.data.labelIds || [],
  };
}

async function readSentMessage(id) {
  return getMessageById(id, { scopes: SEND_SCOPES });
}

async function verifySendScope() {
  const gmail = getGmailClient(SEND_SCOPES);
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return { emailAddress: profile.data.emailAddress || IMPERSONATE_USER };
}

module.exports = {
  searchEmailActivity,
  searchSentSince,
  searchSentSinceMinutes,
  searchMailboxSinceDays,
  getMessageById,
  sendGmailReply,
  readSentMessage,
  verifySendScope,
  searchInboxSince,
  getGmailClient,
  loadServiceAccount, // exported for tests
  SECRET_PATH,
  IMPERSONATE_USER,
  SCOPES,
  SEND_SCOPES,
  // exported for tests
  _internal: { cleanHeader, decodeBody, encodeMimeHeader, encodeRawMessage, extractTextBody, header, listMessageIds, loadMessages, parseAddress },
};
