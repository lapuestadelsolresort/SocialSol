'use strict';
//
// llm-classify-thread.js — classify a Gmail thread as a resort inquiry or not.
//
// Uses OpenAI gpt-4o-mini via raw fetch (no `openai` npm dep — keeps the
// surface area small and avoids touching package.json for one model call).
// Returns parsed JSON; on any failure (network, parse, schema) returns a
// safe fallback `{ classification: 'ambiguous', confidence: 0, reasoning: 'parse_failed' }`
// so the caller can still stage the thread for human review.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRET_PATH = path.join(SECRETS_DIR, 'openai.json');
const MODEL = 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30_000;

let _cachedKey = null;
function loadApiKey() {
  if (_cachedKey) return _cachedKey;
  if (process.env.OPENAI_API_KEY) {
    _cachedKey = process.env.OPENAI_API_KEY;
    return _cachedKey;
  }
  const raw = fs.readFileSync(SECRET_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.api_key) {
    throw new Error(`Missing api_key in ${SECRET_PATH}`);
  }
  _cachedKey = parsed.api_key;
  return _cachedKey;
}

const SYSTEM_PROMPT = [
  'You classify email threads received by La Puesta del Sol Resort, a small',
  'boutique resort. Sarah is the resort owner who replies to inquiries.',
  '',
  'Decide whether a thread is a "resort_inquiry" — meaning someone is asking',
  'about staying at, booking, renting, or holding an event at the resort.',
  '',
  'Categories (use the closest one):',
  '  - availability: dates / open rooms / can you host us',
  '  - group: families, retreats, multiple rooms, bachelor/bachelorette',
  '  - wedding: weddings, vow renewals, ceremony venue',
  '  - pricing: rates, packages, cost questions',
  '  - general: ambiguous inquiries that are clearly about the resort but',
  '             don\'t fit the above (e.g. "tell me more about the place")',
  '',
  'Examples of NOT resort_inquiry:',
  '  - vendor / contractor pitches, sales outreach to Sarah',
  '  - personal mail to Sarah',
  '  - booking platform notifications, receipts, statements',
  '  - newsletters, marketing blasts',
  '',
  'Output JSON ONLY with this exact shape:',
  '{',
  '  "classification": "resort_inquiry" | "not_inquiry" | "ambiguous",',
  '  "category": "availability" | "group" | "wedding" | "pricing" | "general" | null,',
  '  "confidence": 0.0,',
  '  "reasoning": "one short sentence"',
  '}',
  '',
  'category MUST be null when classification is not "resort_inquiry".',
  'confidence is your calibrated probability the classification is correct.',
].join('\n');

function buildUserPrompt(thread) {
  const ownerAddress = (process.env.GMAIL_IMPERSONATE_USER || '').toLowerCase();
  const inbound = thread.messages.filter(
    (m) => !ownerAddress || (m.from.address || '').toLowerCase() !== ownerAddress
  );
  const sample = inbound.slice(0, 2).map((m, i) => {
    const body = (m.text || '').replace(/\s+/g, ' ').slice(0, 800);
    return `--- inbound message ${i + 1} (from ${m.from.address}, ${m.date}) ---\n${body}`;
  });
  return [
    `Subject: ${thread.subject || '(no subject)'}`,
    `Participants: ${thread.participants.join(', ')}`,
    `Message count: ${thread.messageCount}`,
    '',
    sample.join('\n\n') || '(no inbound messages — likely outbound-only)',
  ].join('\n');
}

const FALLBACK = {
  classification: 'ambiguous',
  category: null,
  confidence: 0,
  reasoning: 'parse_failed',
};

function isValidShape(o) {
  if (!o || typeof o !== 'object') return false;
  if (!['resort_inquiry', 'not_inquiry', 'ambiguous'].includes(o.classification)) return false;
  if (o.category != null && !['availability', 'group', 'wedding', 'pricing', 'general'].includes(o.category)) return false;
  if (typeof o.confidence !== 'number') return false;
  if (typeof o.reasoning !== 'string') return false;
  return true;
}

/**
 * Classify one parsed Gmail thread (as returned by gmail-threads.getThreadFull).
 *
 * @param {object} thread
 * @returns {Promise<{classification, category, confidence, reasoning}>}
 */
async function classifyThread(thread) {
  let apiKey;
  try {
    apiKey = loadApiKey();
  } catch (e) {
    return { ...FALLBACK, reasoning: `key_load_failed: ${e.message}` };
  }

  const body = {
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(thread) },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    return { ...FALLBACK, reasoning: `request_failed: ${e.message}` };
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ...FALLBACK, reasoning: `http_${res.status}: ${text.slice(0, 120)}` };
  }

  let parsed;
  try {
    const json = await res.json();
    const raw = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ...FALLBACK, reasoning: `parse_failed: ${e.message}` };
  }

  if (!isValidShape(parsed)) {
    return { ...FALLBACK, reasoning: 'schema_mismatch' };
  }

  if (parsed.classification !== 'resort_inquiry') {
    parsed.category = null;
  }

  return parsed;
}

module.exports = {
  classifyThread,
  // exported for tests / debugging
  _internal: { buildUserPrompt, isValidShape, SYSTEM_PROMPT, MODEL },
};
