'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SECRETS_DIR } = require('../../lib/runtime-paths');

function loadPostizConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'postiz.json'), 'utf8'));
  const apiKey = raw.api_key;
  const apiUrl = String(raw.api_url || 'https://api.postiz.com').replace(/\/+$/, '');
  const integrationId = process.env.POSTIZ_INTEGRATION_ID || raw.integration_id;
  if (!apiKey || !integrationId) throw new Error('Postiz API key and integration id are required');
  return { apiKey, apiUrl, integrationId };
}

function publicBase(apiUrl) {
  return /\/public\/v1$/.test(apiUrl) ? apiUrl : `${apiUrl}/public/v1`;
}

async function request(pathname, { method = 'GET', body = null, config = loadPostizConfig(), fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${publicBase(config.apiUrl)}${pathname}`, {
    method,
    headers: {
      Authorization: config.apiKey,
      Accept: 'application/json',
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Postiz API ${response.status}`);
    error.code = 'postiz_api_error';
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function listPosts({ startDate, endDate, config, fetchImpl } = {}) {
  const query = new URLSearchParams({ startDate, endDate });
  const payload = await request(`/posts?${query}`, { config, fetchImpl });
  return Array.isArray(payload.posts) ? payload.posts : [];
}

async function createInstagramPost({ caption, mediaRefs, scheduledFor, publishNow = false, config = loadPostizConfig(), fetchImpl } = {}) {
  const payload = await request('/posts', {
    method: 'POST', config, fetchImpl,
    body: {
      type: publishNow ? 'now' : 'schedule',
      date: scheduledFor,
      shortLink: false,
      tags: [],
      posts: [{
        integration: { id: config.integrationId },
        value: [{ content: caption, image: mediaRefs }],
        settings: { __type: 'instagram-standalone', post_type: 'post' },
      }],
    },
  });
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first?.postId) throw new Error('Postiz create returned no postId');
  return { postId: first.postId, integration: first.integration || config.integrationId, raw: payload };
}

module.exports = { createInstagramPost, listPosts, loadPostizConfig, publicBase, request };
