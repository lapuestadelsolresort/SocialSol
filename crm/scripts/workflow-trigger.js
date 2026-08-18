#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../../lib/runtime-paths');
const { loadControlToken } = require('../lib/workflow-auth');

// A production deploy replaces node_modules in place. A scheduled trigger that
// fires inside that window starts a run whose steps can die loading native
// bindings — the failure is classified ambiguous, opens a durable manual
// review and pauses the workflow, even though nothing reached a provider
// (F-053). Skipping the tick is free: the next one is minutes away.
const DEPLOY_LOCK_PATH = path.join(ROOT, 'runtime', 'production-release.lock');
const DEPLOY_LOCK_MAX_AGE_MS = 30 * 60_000;

/**
 * Truthy while a release is genuinely in progress. A lock whose owner process
 * is gone AND which is older than the window is treated as stale and ignored:
 * a crashed deploy must not silently disable every scheduled graph.
 */
function deployInProgress(lockPath = DEPLOY_LOCK_PATH, now = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { reason: 'release_lock_unreadable' };
  }
  let lock = {};
  try {
    lock = JSON.parse(raw);
  } catch {
    lock = {};
  }
  let ownerAlive = false;
  if (Number.isInteger(lock.pid)) {
    try {
      process.kill(lock.pid, 0);
      ownerAlive = true;
    } catch {
      ownerAlive = false;
    }
  }
  const startedAt = Date.parse(lock.startedAt || '');
  const ageMs = Number.isFinite(startedAt) ? now - startedAt : Infinity;
  if (ownerAlive || ageMs < DEPLOY_LOCK_MAX_AGE_MS) {
    return { reason: 'release_in_progress', pid: lock.pid ?? null, targetSha: lock.targetSha ?? null };
  }
  return null;
}

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

async function main(args = process.argv.slice(2), fetchImpl = fetch, { lockPath = DEPLOY_LOCK_PATH } = {}) {
  const workflow = args[0];
  if (!workflow || workflow.startsWith('--')) throw new Error('usage: workflow-trigger.js <workflow> [--bucket 5m|15m|hour|day] [--input-json JSON]');
  const deploying = deployInProgress(lockPath);
  if (deploying) {
    // Exit 0: a skipped tick is the intended outcome, not a job failure.
    process.stdout.write(`${JSON.stringify({ skipped: true, workflow, ...deploying })}\n`);
    return { skipped: true, workflow, ...deploying };
  }
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

module.exports = { bucketKey, main, option, deployInProgress };
