'use strict';

const DEFAULT_BASE_URL = 'https://api.squarespace.com';
const DEFAULT_USER_AGENT = 'OpenClaw LPDS Squarespace Commerce Sync/1.0';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeErrorDetail(payload, status) {
  const detail = payload?.message || payload?.error || payload?.errors?.[0]?.message;
  return String(detail || `HTTP ${status}`).replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function createSquarespaceClient({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = 20000,
  maxRetries = 3,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('Squarespace API key is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  async function request(method, endpoint, { params = {}, body = null } = {}) {
    const url = new URL(endpoint, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': userAgent,
            'Accept': 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt >= maxRetries) throw new Error(`Squarespace request failed for ${endpoint}: ${error.message}`);
        await delay(Math.min(1000 * (2 ** attempt), 8000));
        continue;
      }

      let payload = null;
      const text = await response.text();
      if (text) {
        try { payload = JSON.parse(text); }
        catch { throw new Error(`Squarespace returned invalid JSON for ${endpoint}`); }
      }
      if (response.ok) return payload || {};

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`Squarespace API ${response.status} for ${endpoint}: ${safeErrorDetail(payload, response.status)}`);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(1000 * (2 ** attempt), 8000);
      await delay(waitMs);
    }
    throw new Error(`Squarespace request failed for ${endpoint}`);
  }

  async function paginate(endpoint, resultKey, params = {}) {
    const rows = [];
    let cursor = null;
    do {
      const page = await request('GET', endpoint, {
        params: cursor ? { cursor } : params,
      });
      rows.push(...(page[resultKey] || []));
      cursor = page.pagination?.hasNextPage ? page.pagination.nextPageCursor : null;
    } while (cursor);
    return rows;
  }

  return {
    request,
    listOrders(params = {}) {
      return paginate('/1.0/commerce/orders', 'result', params);
    },
    listTransactions(params = {}) {
      return paginate('/1.0/commerce/transactions', 'documents', params);
    },
    listContacts(params = {}) {
      return paginate('/v1/contacts', 'contacts', { pageSize: 1000, ...params });
    },
    async getContact(contactId) {
      const payload = await request('GET', `/v1/contacts/${encodeURIComponent(contactId)}`);
      return payload.contact || null;
    },
    async getTransactionSummaries(contactIds) {
      if (!Array.isArray(contactIds) || contactIds.length === 0) return [];
      const output = [];
      for (let i = 0; i < contactIds.length; i += 1000) {
        const payload = await request('POST', '/v1/analytics/transaction-summaries', {
          body: { contactIds: contactIds.slice(i, i + 1000), groupBy: 'contactId' },
        });
        output.push(...(payload.transactionsSummaryWrappers || []));
      }
      return output;
    },
  };
}

module.exports = {
  createSquarespaceClient,
  DEFAULT_BASE_URL,
  DEFAULT_USER_AGENT,
};
