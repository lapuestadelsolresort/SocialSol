'use strict';
//
// openai-key.js — single source of truth for the OpenAI API key.
//
// Resolution order (matches the indexer wrapper's shell logic):
//   1. process.env.OPENAI_API_KEY (set by index-voice-corpus.sh)
//   2. workspace/secrets/openai.json  { "api_key": "sk-..." }
//
// The .env fallback is intentionally NOT supported here — the indexer's
// shell wrapper handles that for cron contexts; in-process callers go
// through the secrets file.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRET_PATH = path.join(SECRETS_DIR, 'openai.json');

let cached = null;

function getOpenAIKey() {
  if (cached) return cached;

  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim() && !/not needed/i.test(fromEnv)) {
    cached = fromEnv;
    return cached;
  }

  let raw;
  try {
    raw = fs.readFileSync(SECRET_PATH, 'utf8');
  } catch (e) {
    throw new Error(`OpenAI key not in env and could not read ${SECRET_PATH}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed JSON in ${SECRET_PATH}: ${e.message}`);
  }
  const key = parsed && parsed.api_key;
  if (!key || typeof key !== 'string') {
    throw new Error(`No "api_key" string in ${SECRET_PATH}`);
  }
  cached = key;
  return cached;
}

module.exports = { getOpenAIKey, SECRET_PATH };
