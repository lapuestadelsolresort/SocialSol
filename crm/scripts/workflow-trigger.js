#!/usr/bin/env node
'use strict';

require('../../lib/runtime-paths');
const { loadControlToken } = require('../lib/workflow-auth');

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function bucketKey(kind, now = new Date()) {
  const date = new Date(now);
  if (kind === 'day') return date.toISOString().slice(0, 10);
  if (kind === 'hour') return date.toISOString().slice(0, 13);
  const minutes = kind === '5m' ? 5 : 15;
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / minutes) * minutes, 0, 0);
  return date.toISOString().slice(0, 16);
}

async function main(args = process.argv.slice(2), fetchImpl = fetch) {
  const workflow = args[0];
  if (!workflow || workflow.startsWith('--')) throw new Error('usage: workflow-trigger.js <workflow> [--bucket 5m|15m|hour|day] [--input-json JSON]');
  const token = loadControlToken();
  if (!token || token.length < 32) throw new Error('RESORT_WORKFLOW_CONTROL_TOKEN is missing or too short');
  const bucket = option(args, '--bucket') || '15m';
  if (!['5m', '15m', 'hour', 'day'].includes(bucket)) throw new Error('invalid --bucket');
  const inputRaw = option(args, '--input-json');
  const input = inputRaw ? JSON.parse(inputRaw) : {};
  const key = option(args, '--idempotency-key') || `system:${workflow}:${bucketKey(bucket)}`;
  const baseUrl = String(process.env.RESORT_WORKFLOW_BASE_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/api/workflows/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workflow,
      input,
      context: { origin: 'system' },
      idempotency_key: key,
    }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const payload = await response.json().catch(() => ({}));
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!response.ok) {
    const error = new Error(payload.error || `workflow trigger returned ${response.status}`);
    error.code = payload.code || 'workflow_trigger_failed';
    throw error;
  }
  return payload;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[workflow-trigger] ${error.code || 'error'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { bucketKey, main, option };
