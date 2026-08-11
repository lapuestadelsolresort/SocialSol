'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SECRETS_DIR } = require('../../lib/runtime-paths');

function loadControlToken({ env = process.env, secretsDir = SECRETS_DIR } = {}) {
  const fromEnv = env.RESORT_WORKFLOW_CONTROL_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.length >= 32) return fromEnv;
  const file = env.RESORT_WORKFLOW_CONTROL_TOKEN_FILE
    ? path.resolve(env.RESORT_WORKFLOW_CONTROL_TOKEN_FILE)
    : path.join(secretsDir, 'workflow-control.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token;
  } catch {}
  return null;
}

module.exports = { loadControlToken };
