'use strict';

const { require_env } = require('./env');

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function isExcluded(url, excludeDomains, excludeExtensions) {
  const host = hostnameOf(url);
  if (!host) return true;
  for (const dom of excludeDomains) {
    const d = dom.toLowerCase();
    if (host === d || host.endsWith('.' + d)) return true;
  }
  const lower = url.toLowerCase().split('?')[0].split('#')[0];
  for (const ext of excludeExtensions) {
    if (lower.endsWith(ext.toLowerCase())) return true;
  }
  return false;
}

class BraveClient {
  constructor({ apiKey, intervalMs }) {
    this.apiKey = apiKey;
    this.intervalMs = intervalMs;
    this.lastCallAt = 0;
  }

  async _waitForSlot() {
    const now = Date.now();
    const wait = this.lastCallAt + this.intervalMs - now;
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  async search(query, { count = 10, country = 'US', searchLang = 'en', safesearch = 'moderate' } = {}) {
    await this._waitForSlot();
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      country,
      search_lang: searchLang,
      safesearch,
    });
    const res = await fetch(`${BRAVE_URL}?${params.toString()}`, {
      headers: {
        'X-Subscription-Token': this.apiKey,
        'Accept': 'application/json',
      },
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      const err = new Error(`Brave API auth failed (${res.status}): ${body.slice(0, 200)}`);
      err.fatal = true;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brave API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.web && Array.isArray(json.web.results) ? json.web.results : [];
  }
}

function makeBraveClient(researchCfg) {
  const apiKey = require_env('BRAVE_API_KEY');
  return new BraveClient({ apiKey, intervalMs: researchCfg.brave_request_interval_ms || 1100 });
}

module.exports = { BraveClient, makeBraveClient, isExcluded, hostnameOf };
