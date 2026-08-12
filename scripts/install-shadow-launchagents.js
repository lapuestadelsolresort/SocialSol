#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../lib/runtime-paths');

const NAMES = [
  'com.lapuestadelsolresort.workflow-worker.plist',
  'com.lapuestadelsolresort.workflow-health.plist',
  'com.lapuestadelsolresort.restore-drill.plist',
];

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 60_000 });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function bootstrapWithRetry(domain, target) {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = launchctl(['bootstrap', domain, target], { allowFailure: true });
    if (last.status === 0) return;
    pause(250 * (attempt + 1));
  }
  throw new Error(`launchctl bootstrap ${domain} ${target} failed: ${String(last?.stderr || last?.stdout).trim()}`);
}

function main() {
  if (!process.argv.includes('--confirm-shadow')) throw new Error('refusing LaunchAgent install without --confirm-shadow');
  const generated = path.join(ROOT, 'deploy', 'launchagents', 'generated');
  const destination = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const backups = path.join(destination, 'socialsol-backups');
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const domain = `gui/${process.getuid()}`;
  const installed = [];
  for (const name of NAMES) {
    const source = path.join(generated, name);
    const target = path.join(destination, name);
    if (!fs.existsSync(source)) throw new Error(`rendered LaunchAgent missing: ${source}`);
    const label = name.replace(/\.plist$/, '');
    if (fs.existsSync(target)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(target, path.join(backups, `${name}.${stamp}.bak`), fs.constants.COPYFILE_EXCL);
    }
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, target);
    const active = launchctl(['print', `${domain}/${label}`], { allowFailure: true }).status === 0;
    if (active) {
      launchctl(['bootout', `${domain}/${label}`]);
      pause(500);
    }
    bootstrapWithRetry(domain, target);
    installed.push({ label, target });
  }
  console.log(JSON.stringify({ ok: true, installed }));
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`[install-shadow-launchagents] ${error.message}`);
    process.exitCode = 1;
  }
}
