#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, OPENCLAW_BIN } = require('../lib/runtime-paths');
const { assertNoQuarantinedLiveWorkflows, merge } = require('./validate-openclaw-shadow');

function main() {
  if (!process.argv.includes('--confirm-shadow')) {
    throw new Error('refusing production config write without --confirm-shadow');
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const patchPath = process.env.RESORT_OPENCLAW_PATCH_PATH || path.join(ROOT, 'workflow', 'openclaw-policy.patch.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  if (patch.plugins?.entries?.['resort-workflows']?.config?.shadowMode !== true) {
    throw new Error('patch is not in shadow mode');
  }
  assertNoQuarantinedLiveWorkflows(patch);
  const next = merge(current, patch);
  const configDirectory = path.dirname(configPath);
  const backupDirectory = path.join(configDirectory, 'config-backups');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `openclaw.pre-socialsol-shadow.${stamp}.json`);
  const tempPath = path.join(configDirectory, `.openclaw.socialsol-shadow.${crypto.randomUUID()}.tmp`);
  fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    const validation = spawnSync(OPENCLAW_BIN, ['config', 'validate', '--json'], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: tempPath }, encoding: 'utf8', timeout: 60_000,
    });
    if (validation.status !== 0) {
      throw new Error(`rendered config validation failed: ${String(validation.stderr || validation.stdout).trim()}`);
    }
    fs.renameSync(tempPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log(JSON.stringify({ ok: true, mode: 'shadow', backup: backupPath, config: configPath }));
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`[apply-openclaw-shadow] ${error.message}`);
    process.exitCode = 1;
  }
}
