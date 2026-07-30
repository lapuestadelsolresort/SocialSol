'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { cacheDir } = require('./config');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function urlHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function cachePathFor(url) {
  return path.join(cacheDir(), urlHash(url) + '.html');
}

function readCache(url, ttlDays) {
  const p = cachePathFor(url);
  if (!fs.existsSync(p)) return null;
  const stat = fs.statSync(p);
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > ttlDays * 24 * 60 * 60 * 1000) return null;
  return fs.readFileSync(p, 'utf8');
}

function writeCache(url, html) {
  const p = cachePathFor(url);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, html);
}

const robotsCache = new Map();

function parseRobots(txt, userAgent) {
  // Minimal parser: returns array of disallowed path prefixes for our UA or '*'.
  const lines = txt.split(/\r?\n/);
  const groups = [];
  let current = null;
  for (let raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (current && current.disallows.length === 0 && current.agents.length > 0) {
        // continue same group
      } else {
        current = { agents: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
    } else if (key === 'disallow' && current) {
      current.disallows.push(val);
    }
  }
  // Pick the group matching our UA most specifically; fallback to '*'.
  const uaLower = userAgent.toLowerCase();
  const matching = groups.filter(g => g.agents.some(a => uaLower.includes(a) || a === '*'));
  // Prefer non-wildcard matches over wildcard
  matching.sort((a, b) => {
    const aWild = a.agents.includes('*') ? 1 : 0;
    const bWild = b.agents.includes('*') ? 1 : 0;
    return aWild - bWild;
  });
  if (matching.length === 0) return [];
  return matching[0].disallows.filter(d => d !== '');
}

async function loadRobots(origin, userAgent, timeoutMs) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const url = origin + '/robots.txt';
  let disallows = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const txt = await res.text();
      disallows = parseRobots(txt, userAgent);
    }
  } catch (_) {
    // No robots.txt or fetch failed → allow
  }
  robotsCache.set(origin, disallows);
  return disallows;
}

function isAllowed(disallows, urlPath) {
  for (const d of disallows) {
    if (d === '/') return false;
    if (urlPath.startsWith(d)) return false;
  }
  return true;
}

async function fetchWithBackoff(url, userAgent, timeoutMs) {
  const delays = [0, 1000, 2000, 4000];
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, 'Accept': 'text/html,*/*' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      if (res.status === 429 || res.status === 503) {
        if (i === delays.length - 1) {
          return { status: res.status, error: `retries exhausted on ${res.status}` };
        }
        continue;
      }
      const html = res.ok ? await res.text() : '';
      return { status: res.status, html, error: res.ok ? null : `http ${res.status}` };
    } catch (e) {
      lastErr = e;
      if (i === delays.length - 1) {
        return { status: 0, error: String(e.message || e) };
      }
    }
  }
  return { status: 0, error: String(lastErr && lastErr.message) || 'unknown' };
}

function readabilityExtract(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return { title: null, text: '' };
    const text = (article.textContent || '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    return { title: article.title || null, text };
  } catch (e) {
    return { title: null, text: '', error: String(e.message || e) };
  }
}

const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu',
  'domain.com', 'yourdomain.com', 'mydomain.com', 'sentry.io',
  'sentry.wixpress.com', 'wixpress.com', 'w.org', 'wordpress.org',
  'wordpress.com', 'placeholder.com', 'site.com', 'mysite.com',
  'mail.com', 'noemail.com', 'test.com', 'sample.com',
]);
const PLACEHOLDER_LOCALS = new Set([
  'email', 'youremail', 'your.email', 'name', 'firstname', 'lastname',
  'placeholder', 'username', 'sample', 'test',
]);

function isPlausibleEmail(email) {
  if (!email || email.length > 254) return false;
  const at = email.indexOf('@');
  if (at < 1 || at >= email.length - 3) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain.includes('.')) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_LOCALS.has(local)) return false;
  // Drop obvious non-emails: ext-looking trailing tokens, image filenames
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?|ttf)$/i.test(email)) return false;
  return true;
}

function rootDomain(host) {
  if (!host) return '';
  return host.toLowerCase().replace(/^www\./, '');
}

function emailDomainsMatch(emailDomain, pageDomain) {
  if (!emailDomain || !pageDomain) return false;
  if (emailDomain === pageDomain) return true;
  if (emailDomain.endsWith('.' + pageDomain)) return true;
  if (pageDomain.endsWith('.' + emailDomain)) return true;
  return false;
}

function harvestContactSignals(html, pageUrl) {
  const emails = new Set();
  if (typeof html === 'string' && html.length > 0) {
    const mailtoRe = /mailto:([^"'\s?>]+)/gi;
    let m;
    while ((m = mailtoRe.exec(html)) !== null) {
      const raw = (m[1] || '').toLowerCase().trim();
      // mailto can carry query strings (?subject=...) — strip after '?' if any
      const e = raw.split('?')[0];
      if (isPlausibleEmail(e)) emails.add(e);
    }
    const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    while ((m = emailRe.exec(html)) !== null) {
      const e = (m[0] || '').toLowerCase().trim();
      if (isPlausibleEmail(e)) emails.add(e);
    }
  }
  const phones = new Set();
  if (typeof html === 'string' && html.length > 0) {
    const telRe = /tel:([+\d\-\s().]+)/gi;
    let m;
    while ((m = telRe.exec(html)) !== null) {
      const p = (m[1] || '').replace(/\s+/g, ' ').trim();
      if (p && p.length >= 7) phones.add(p);
    }
  }
  let pageDomain = '';
  try { pageDomain = rootDomain(new URL(pageUrl).hostname); } catch {}
  const emailList = [...emails].sort((a, b) => {
    const da = a.split('@')[1];
    const db = b.split('@')[1];
    const matchA = emailDomainsMatch(da, pageDomain) ? 0 : 1;
    const matchB = emailDomainsMatch(db, pageDomain) ? 0 : 1;
    if (matchA !== matchB) return matchA - matchB;
    return a.localeCompare(b);
  }).slice(0, 20);
  const phoneList = [...phones].slice(0, 20);
  return { emails: emailList, phones: phoneList };
}

function buildDiscoveredBlock(signals) {
  if (!signals || (signals.emails.length === 0 && signals.phones.length === 0)) return '';
  const lines = ['[discovered_contacts]'];
  if (signals.emails.length > 0) lines.push(`emails: ${signals.emails.join(', ')}`);
  if (signals.phones.length > 0) lines.push(`phones: ${signals.phones.join(', ')}`);
  lines.push('[/discovered_contacts]');
  return '\n\n' + lines.join('\n');
}

const PROMPT_TEXT_BUDGET = 8000;

function buildPromptText(bodyText, signals) {
  const block = buildDiscoveredBlock(signals);
  const trimmed = (bodyText || '').slice(0, Math.max(0, PROMPT_TEXT_BUDGET - block.length));
  return trimmed + block;
}

async function fetchPage(url, opts) {
  const { userAgent, timeoutMs, cacheTtlDays, respectRobots, bypassCache } = opts;

  // Cache hit?
  const cached = bypassCache ? null : readCache(url, cacheTtlDays);
  if (cached) {
    const { title, text } = readabilityExtract(cached, url);
    const signals = harvestContactSignals(cached, url);
    const promptText = buildPromptText(text, signals);
    return {
      url,
      status: 200,
      cached: true,
      title,
      text: promptText,
      html_length: cached.length,
      text_length: text.length,
      discovered_emails: signals.emails,
      discovered_phones: signals.phones,
      fetched_at: new Date().toISOString(),
    };
  }

  // robots.txt check
  let parsed;
  try { parsed = new URL(url); } catch { return { url, status: 0, error: 'invalid URL', fetched_at: new Date().toISOString() }; }
  if (respectRobots !== false) {
    const disallows = await loadRobots(parsed.origin, userAgent, timeoutMs);
    if (!isAllowed(disallows, parsed.pathname || '/')) {
      return { url, status: 0, error: 'robots_disallow', fetched_at: new Date().toISOString() };
    }
  }

  const result = await fetchWithBackoff(url, userAgent, timeoutMs);
  if (result.status !== 200 || !result.html) {
    return { url, status: result.status, error: result.error || null, fetched_at: new Date().toISOString() };
  }
  writeCache(url, result.html);
  const { title, text } = readabilityExtract(result.html, url);
  const signals = harvestContactSignals(result.html, url);
  const promptText = buildPromptText(text, signals);
  return {
    url,
    status: 200,
    cached: false,
    title,
    text: promptText,
    html_length: result.html.length,
    text_length: text.length,
    discovered_emails: signals.emails,
    discovered_phones: signals.phones,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchAll(urls, opts) {
  const { concurrency, onProgress } = opts;
  const results = new Array(urls.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= urls.length) return;
      const url = urls[idx];
      try {
        results[idx] = await fetchPage(url, opts);
      } catch (e) {
        results[idx] = { url, status: 0, error: String(e.message || e), fetched_at: new Date().toISOString() };
      }
      completed++;
      if (onProgress) onProgress(completed, urls.length, results[idx]);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  fetchPage,
  fetchAll,
  urlHash,
  harvestContactSignals,
  buildDiscoveredBlock,
  buildPromptText,
  isPlausibleEmail,
};
