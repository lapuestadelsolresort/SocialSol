#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, OPENCLAW_BIN } = require('../lib/runtime-paths');

// Owner quarantine (F-020, qc/DECISIONS.md D-002, 2026-08-15): these workflows
// must never be armed as live in a rendered production config.
const QUARANTINED_LIVE_WORKFLOWS = ['meta.dm.reply'];

function assertNoQuarantinedLiveWorkflows(patch) {
  const live = patch?.plugins?.entries?.['resort-workflows']?.config?.liveWorkflowNames;
  const armed = QUARANTINED_LIVE_WORKFLOWS.filter(name => Array.isArray(live) && live.includes(name));
  if (armed.length > 0) {
    throw new Error(`refusing quarantined live workflow(s): ${armed.join(', ')} (F-020)`);
  }
}

function merge(left, right) {
  if (!right || typeof right !== 'object' || Array.isArray(right)) return right;
  const output = left && typeof left === 'object' && !Array.isArray(left) ? { ...left } : {};
  for (const [key, value] of Object.entries(right)) output[key] = merge(output[key], value);
  return output;
}

function run(args, env) {
  const result = spawnSync(OPENCLAW_BIN, args, { env, encoding: 'utf8', timeout: 60_000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) throw new Error(`openclaw ${args.join(' ')} exited ${result.status}`);
}

function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const patchPath = process.env.RESORT_OPENCLAW_PATCH_PATH || path.join(ROOT, 'workflow', 'openclaw-policy.patch.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  if (patch.plugins?.entries?.['resort-workflows']?.config?.shadowMode !== true) {
    throw new Error('refusing validation because the rendered plugin is not in shadow mode');
  }
  assertNoQuarantinedLiveWorkflows(patch);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'socialsol-openclaw-validate-'));
  const mergedPath = path.join(directory, 'openclaw.json');
  try {
    fs.writeFileSync(mergedPath, JSON.stringify(merge(current, patch), null, 2), { mode: 0o600 });
    const env = { ...process.env, OPENCLAW_CONFIG_PATH: mergedPath };
    run(['plugins', 'inspect', 'resort-workflows', '--runtime', '--json'], env);
    run(['plugins', 'doctor'], env);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`[validate-openclaw-shadow] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { QUARANTINED_LIVE_WORKFLOWS, assertNoQuarantinedLiveWorkflows, merge };
