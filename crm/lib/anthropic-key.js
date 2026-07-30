'use strict';
//
// anthropic-key.js — single source of truth for the Anthropic API key.
//
// Resolution order:
//   1. process.env.ANTHROPIC_API_KEY
//   2. workspace/secrets/anthropic.json  { "api_key": "sk-ant-..." }
//
// Paulina's prospector composer reads ANTHROPIC_API_KEY from ~/.openclaw/.env
// via dotenv. R3's Voice Service follows the openai.json pattern instead.
// Both readers will be unified in R5 when Paulina migrates to the Voice Service.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRET_PATH = path.join(SECRETS_DIR, 'anthropic.json');

let cached = null;

function getAnthropicKey() {
  if (cached) return cached;

  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) {
    cached = fromEnv;
    return cached;
  }

  let raw;
  try {
    raw = fs.readFileSync(SECRET_PATH, 'utf8');
  } catch (e) {
    throw new Error(`Anthropic key not in env and could not read ${SECRET_PATH}: ${e.message}. Drop {"api_key":"sk-ant-..."} into that file.`);
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

module.exports = { getAnthropicKey, SECRET_PATH };
