'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENV_PATH = process.env.SOCIALSOL_ENV_FILE || path.join(REPO_ROOT, '.env');

let loaded = false;
function load() {
  if (loaded) return;
  require('dotenv').config({ path: ENV_PATH });
  loaded = true;
}

function require_env(name) {
  load();
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name} in ${ENV_PATH}`);
  }
  return v;
}

function optional_env(name, fallback) {
  load();
  return process.env[name] || fallback;
}

module.exports = { load, require_env, optional_env, ENV_PATH };
