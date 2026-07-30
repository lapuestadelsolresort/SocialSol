'use strict';
//
// gmail-threads.js — thread-level Gmail API helpers, sitting on top of the
// same DWD service-account auth as gmail-client.js.
//
// Kept separate from gmail-client.js (which is message-shaped) so existing
// consumers of searchSentSince / searchInboxSince don't pick up the heavier
// thread surface area.
//
// Surface:
//   - listThreadsPage({ q, pageToken })       → { threads: [{id}], nextPageToken }
//   - getThreadFull(threadId)                 → parsed thread with messages
//
// Both wrap retry+backoff on 429/503. getThreadFull also paces calls with a
// per-call sleep so a long scan stays under Gmail's 250 quota-units/sec
// ceiling (threads.get ≈ 10 units).

const gmailClient = require('./gmail-client');
const { getGmailClient } = gmailClient;
const { extractTextBody, header, parseAddress } = gmailClient._internal;

const PER_CALL_SLEEP_MS = 120;       // ~8 thread.get/sec → ~80 quota units/sec
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransient(err) {
  const code = err && (err.code || (err.response && err.response.status));
  return code === 429 || code === 500 || code === 502 || code === 503;
}

async function withRetry(fn) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= MAX_RETRIES) throw e;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      attempt += 1;
      await sleep(delay);
    }
  }
}

/**
 * Page through threads matching `q`. Caller drives pagination so it can
 * persist state between pages (see import-direct-email-contacts.js).
 *
 * @param {object} opts
 * @param {string} [opts.q]            Gmail search query
 * @param {string} [opts.pageToken]    From a previous page
 * @param {number} [opts.maxResults]   1–500, default 100
 * @returns {Promise<{threads: Array<{id: string}>, nextPageToken: string|null}>}
 */
async function listThreadsPage({ q, pageToken, maxResults = 100 } = {}) {
  const gmail = getGmailClient();
  const res = await withRetry(() =>
    gmail.users.threads.list({
      userId: 'me',
      q,
      pageToken: pageToken || undefined,
      maxResults,
    })
  );
  return {
    threads: (res.data.threads || []).map((t) => ({ id: t.id })),
    nextPageToken: res.data.nextPageToken || null,
  };
}

/**
 * Fetch one thread in full and return a normalized shape. Paces itself
 * with sleep(PER_CALL_SLEEP_MS) so bulk callers don't need their own.
 *
 * @param {string} threadId
 * @returns {Promise<{
 *   id: string,
 *   subject: string,
 *   participants: string[],          // lowercased addresses, unique, in first-seen order
 *   messageCount: number,
 *   firstAt: string|null,            // ISO
 *   lastAt: string|null,
 *   snippet: string,                 // Gmail-provided
 *   messages: Array<{
 *     id: string,
 *     from: {name: string, address: string},
 *     to: string|null,
 *     date: string|null,             // ISO from internalDate
 *     text: string,                  // first text/plain body (or stripped html)
 *   }>
 * }>}
 */
async function getThreadFull(threadId) {
  const gmail = getGmailClient();
  await sleep(PER_CALL_SLEEP_MS);
  const res = await withRetry(() =>
    gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    })
  );
  const data = res.data || {};
  const rawMessages = data.messages || [];

  let subject = '';
  const participants = [];
  const seen = new Set();
  const messages = [];
  let firstAtMs = null;
  let lastAtMs = null;

  for (const m of rawMessages) {
    const payload = m.payload || {};
    const fromRaw = header(payload.headers, 'From');
    const from = parseAddress(fromRaw);
    const to = header(payload.headers, 'To');
    if (!subject) subject = header(payload.headers, 'Subject') || '';

    const lowerAddr = (from.address || '').toLowerCase();
    if (lowerAddr && !seen.has(lowerAddr)) {
      seen.add(lowerAddr);
      participants.push(lowerAddr);
    }

    const internalMs = m.internalDate ? Number(m.internalDate) : null;
    if (internalMs) {
      if (firstAtMs === null || internalMs < firstAtMs) firstAtMs = internalMs;
      if (lastAtMs === null || internalMs > lastAtMs) lastAtMs = internalMs;
    }

    messages.push({
      id: m.id,
      from,
      to,
      date: internalMs ? new Date(internalMs).toISOString() : null,
      text: extractTextBody(payload),
    });
  }

  return {
    id: data.id || threadId,
    subject,
    participants,
    messageCount: messages.length,
    firstAt: firstAtMs ? new Date(firstAtMs).toISOString() : null,
    lastAt: lastAtMs ? new Date(lastAtMs).toISOString() : null,
    snippet: data.snippet || '',
    messages,
  };
}

module.exports = {
  listThreadsPage,
  getThreadFull,
  // Exposed for tests / scripts that want to tune pacing.
  _internal: { sleep, isTransient, withRetry, PER_CALL_SLEEP_MS },
};
