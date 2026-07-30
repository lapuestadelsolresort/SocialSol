'use strict';

const { execFile } = require('child_process');
const path = require('path');
const {
  OPENCLAW_BIN: OPENCLAW,
} = require(path.resolve(__dirname, '..', '..', '..', '..', 'lib', 'runtime-paths'));

const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';

function postToChannel(channel, message, { dryRun = false } = {}) {
  if (!SLACK_ACCOUNT) {
    return Promise.resolve({ ok: false, error: 'OPENCLAW_SLACK_ACCOUNT is not configured', stderr: '' });
  }
  const args = [
    'message', 'send',
    '--channel', 'slack',
    '--account', SLACK_ACCOUNT,
    '--target', channel,
    '--message', message,
    '--json',
  ];
  if (dryRun) args.push('--dry-run');
  return new Promise((resolve) => {
    execFile(OPENCLAW, args, {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || '') });
      } else {
        resolve({ ok: true, stdout: String(stdout || '') });
      }
    });
  });
}

module.exports = { postToChannel, SLACK_ACCOUNT };
