'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SECRETS_DIR } = require('../../lib/runtime-paths');

const BASE_URL = 'https://api.ownerrez.com';
const USER_AGENT = 'SocialSol Resort Workflows/1.0';

function loadOwnerRezSecrets(file = path.join(SECRETS_DIR, 'ownerrez.json')) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const token = parsed.access_token || parsed.api_token;
  if (!token) throw new Error('OwnerRez access token is not configured');
  return { token, baseUrl: parsed.api_base || BASE_URL };
}

function safePath(value) {
  const candidate = String(value || '');
  if (!/^\/v2\/[a-z0-9/_{}-]+$/i.test(candidate) || candidate.includes('..')) {
    throw new Error('OwnerRez request path is outside the fixed v2 API boundary');
  }
  return candidate;
}

function ownerRezError(status, payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages.join('; ') : payload?.message;
  const error = new Error(`OwnerRez API ${status}: ${messages || payload?.code || 'request failed'}`);
  error.status = status;
  error.code = payload?.code || `ownerrez_http_${status}`;
  error.retryable = status === 429 || status === 503;
  error.providerResponse = payload || null;
  return error;
}

async function requestOwnerRez({
  method = 'GET', requestPath, query = {}, body, headers = {}, allowNotFound = false,
  fetchImpl = fetch, secrets = loadOwnerRezSecrets(), timeoutMs = 20_000,
} = {}) {
  const pathValue = safePath(requestPath);
  // Existing deployments commonly store api_base as either the origin or the
  // v2 root. requestPath is always catalog-controlled and already begins /v2,
  // so normalize both forms to the origin to avoid /v2/v2 requests.
  const base = String(secrets.baseUrl || BASE_URL).replace(/\/+$/, '').replace(/\/v2$/i, '');
  const url = new URL(`${base}${pathValue}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const normalizedMethod = String(method).toUpperCase();
  const response = await fetchImpl(url, {
    method: normalizedMethod,
    headers: {
      Authorization: `bearer ${secrets.token}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch {
      const error = new Error(`OwnerRez returned non-JSON data for ${normalizedMethod} ${pathValue}`);
      error.code = 'ownerrez_invalid_json';
      error.status = response.status;
      throw error;
    }
  }
  if (response.status === 404 && allowNotFound) {
    return { ok: false, status: 404, data, etag: response.headers.get('etag') };
  }
  if (!response.ok || Number(data?.status_code || 0) >= 400) {
    throw ownerRezError(data?.status_code || response.status, data);
  }
  return {
    ok: true,
    status: response.status,
    data,
    etag: response.headers.get('etag'),
  };
}

module.exports = {
  BASE_URL,
  USER_AGENT,
  loadOwnerRezSecrets,
  ownerRezError,
  requestOwnerRez,
  safePath,
};
