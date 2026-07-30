'use strict';

const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = process.env.SOCIALSOL_ENV_FILE || path.join(DEFAULT_ROOT, '.env');

require('dotenv').config({ path: ENV_FILE, quiet: true });

const ROOT = path.resolve(process.env.SOCIALSOL_ROOT || DEFAULT_ROOT);
const SECRETS_DIR = path.resolve(
  process.env.SOCIALSOL_SECRETS_DIR || path.join(ROOT, 'secrets'),
);
const DB_PATH = path.resolve(
  process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db'),
);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';

function secretPath(filename) {
  return path.join(SECRETS_DIR, filename);
}

module.exports = {
  ROOT,
  ENV_FILE,
  SECRETS_DIR,
  DB_PATH,
  OPENCLAW_BIN,
  secretPath,
};
