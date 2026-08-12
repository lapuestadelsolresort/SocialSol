'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SECRETS_DIR } = require('../../lib/runtime-paths');

const META_SECRETS_PATH = path.join(SECRETS_DIR, 'meta.json');

function loadMetaSecrets(file = META_SECRETS_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

async function sendMetaDm({ platform, recipientId, message, secrets = loadMetaSecrets(), fetchImpl = fetch }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!['instagram', 'page'].includes(platform)) throw new Error('unsupported Meta messaging platform');
  if (!recipientId) throw new Error('Meta recipient is required');
  if (!text || text.length > 2000) throw new Error('Meta reply must contain 1–2000 characters');
  if (!secrets.access_token || !secrets.page_id) throw new Error('Meta messaging credentials are unavailable');

  const graph = 'https://graph.facebook.com/v21.0';
  let pageToken = secrets.access_token;
  try {
    const tokenResponse = await fetchImpl(`${graph}/${encodeURIComponent(secrets.page_id)}?fields=access_token`, {
      headers: { Authorization: `Bearer ${secrets.access_token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (tokenResponse.ok && tokenPayload.access_token) pageToken = tokenPayload.access_token;
  } catch {
    // The configured system token may itself be page-scoped. The mutation
    // boundary is the POST below; failure of this optional lookup is safe.
  }

  const senderId = platform === 'instagram'
    ? (process.env.META_INSTAGRAM_ID || secrets.instagram_id)
    : secrets.page_id;
  if (!senderId) throw new Error('Meta sender account is unavailable');

  let response;
  try {
    response = await fetchImpl(`${graph}/${encodeURIComponent(senderId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pageToken}` },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    error.code = 'ambiguous_external_result';
    error.retryable = false;
    error.ambiguous = true;
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error || !result.message_id) {
    const error = new Error(result.error?.message || `Meta message send failed (${response.status})`);
    error.code = result.error?.code ? `meta_${result.error.code}` : `meta_http_${response.status}`;
    error.retryable = false;
    if (response.status === 429 || response.status >= 500 || response.ok) {
      error.code = 'ambiguous_external_result';
      error.ambiguous = true;
    }
    throw error;
  }
  return result;
}

module.exports = { META_SECRETS_PATH, loadMetaSecrets, sendMetaDm };
