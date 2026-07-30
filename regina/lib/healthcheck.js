'use strict';
//
// healthcheck.js — Regina-side healthchecks.io ping helper.
//
// Reads workspace/secrets/healthchecks.json (same file Paulina uses) and pings
// the URL for the named check. Suffix can be '/start' or '/fail' or '' (success).
// Silent no-op if the check key is missing — matches voice-draft.js behavior.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const HC_PATH = path.join(SECRETS_DIR, 'healthchecks.json');

let _cache = null;

function loadConfig() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(HC_PATH, 'utf8'));
  } catch {
    _cache = null;
  }
  return _cache;
}

function ping(checkName, suffix = '', body = '') {
  const cfg = loadConfig();
  if (!cfg || !cfg.base_url) return;
  const id = cfg.checks && cfg.checks[checkName];
  if (!id) return; // not configured yet — silent skip, same as voice-draft.js
  const url = `${cfg.base_url}/${id}${suffix}`;
  try {
    if (body) {
      execFileSync('curl', ['-fsS', '--max-time', '5', url, '-d', String(body).slice(0, 200)], {
        stdio: 'ignore',
      });
    } else {
      execFileSync('curl', ['-fsS', '--max-time', '5', url], { stdio: 'ignore' });
    }
  } catch {
    /* non-fatal */
  }
}

const start = (name) => ping(name, '/start');
const success = (name) => ping(name, '');
const fail = (name, reason) => ping(name, '/fail', reason);

module.exports = { ping, start, success, fail, HC_PATH };
