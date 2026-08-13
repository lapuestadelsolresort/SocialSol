'use strict';

const { requestOwnerRez } = require('./ownerrez-api');

function positiveInteger(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function normalizeMessage(message = {}, fallbackThreadId = null) {
  return {
    id: String(message.id || ''),
    threadId: String(message.thread_id || message.thread?.id || fallbackThreadId || ''),
    body: String(message.body || ''),
    internalDate: message.date_utc || null,
    fromRole: message.from_role || null,
    fromContactId: message.from_contact_id || null,
    isDraft: Boolean(message.is_draft),
    removedAt: message.removed_utc || null,
    raw: message,
  };
}

async function sendOwnerRezMessage({ threadId, body, request = requestOwnerRez } = {}) {
  const normalizedThreadId = positiveInteger(threadId, 'OwnerRez threadId');
  const text = String(body || '').trim();
  if (!text || text.length > 10_000) throw new Error('OwnerRez message must contain 1–10000 characters');
  let response;
  try {
    response = await request({
      method: 'POST',
      requestPath: '/v2/messages',
      body: { thread_id: normalizedThreadId, body: text },
    });
  } catch (cause) {
    if (cause.status || cause.providerResponse) throw cause;
    const error = new Error(`OwnerRez send result is ambiguous: ${cause.message}`);
    error.code = 'ambiguous_external_result';
    error.retryable = false;
    error.cause = cause;
    throw error;
  }
  const message = normalizeMessage(response.data, normalizedThreadId);
  if (!message.id || !message.threadId) {
    const error = new Error('OwnerRez accepted the request without a verifiable message identity');
    error.code = 'ambiguous_external_result';
    error.retryable = false;
    throw error;
  }
  return message;
}

async function readOwnerRezMessage(messageId, threadId, { request = requestOwnerRez } = {}) {
  const normalizedThreadId = positiveInteger(threadId, 'OwnerRez threadId');
  const response = await request({
    method: 'GET',
    requestPath: '/v2/messages',
    query: { threadId: normalizedThreadId, include_drafts: true },
  });
  const message = (response.data?.items || []).find(item => String(item.id) === String(messageId));
  if (!message) {
    const error = new Error(`OwnerRez message ${messageId} is not visible on thread ${normalizedThreadId}`);
    error.code = 'ownerrez_message_readback_missing';
    error.retryable = true;
    throw error;
  }
  return normalizeMessage(message, normalizedThreadId);
}

module.exports = {
  normalizeMessage,
  positiveInteger,
  readOwnerRezMessage,
  sendOwnerRezMessage,
};
