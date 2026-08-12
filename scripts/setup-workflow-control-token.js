#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SECRETS_DIR } = require('../lib/runtime-paths');

function setup(file = path.join(SECRETS_DIR, 'workflow-control.json')) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed.token !== 'string' || parsed.token.length < 32) {
      throw new Error('existing workflow-control.json is invalid; refusing to overwrite it');
    }
    fs.chmodSync(file, 0o600);
    return { created: false, file };
  }
  const payload = `${JSON.stringify({ token: crypto.randomBytes(32).toString('base64url') }, null, 2)}\n`;
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, payload, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
  return { created: true, file };
}

if (require.main === module) {
  try {
    const result = setup();
    console.log(JSON.stringify({ ok: true, created: result.created, file: result.file }));
  } catch (error) {
    console.error(`[workflow-token] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { setup };
