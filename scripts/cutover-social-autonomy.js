#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../lib/runtime-paths');
const { configure } = require('./configure-social-autonomy');

const LAUNCHAGENTS = [
  'com.lapuestadelsolresort.daily-report.plist',
  'com.lapuestadelsolresort.crm-audience-sync.plist',
];
const RETIRED_LAUNCHAGENTS = ['com.lapuestadelsolresort.pipeline-validation.plist'];

function run(program, args, { allowFailure = false } = {}) {
  const result = spawnSync(program, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function installLaunchAgent(name, domain, backupDirectory) {
  const source = path.join(ROOT, 'deploy', 'launchagents', 'generated', name);
  const destination = path.join(os.homedir(), 'Library', 'LaunchAgents', name);
  if (!fs.existsSync(source)) throw new Error(`rendered LaunchAgent is missing: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  let backup = null;
  if (fs.existsSync(destination)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = path.join(backupDirectory, `${name}.${stamp}.bak`);
    fs.copyFileSync(destination, backup, fs.constants.COPYFILE_EXCL);
  }
  const label = name.replace(/\.plist$/, '');
  const target = `${domain}/${label}`;
  if (run('/bin/launchctl', ['print', target], { allowFailure: true }).status === 0) {
    run('/bin/launchctl', ['bootout', target]);
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
  run('/bin/launchctl', ['bootstrap', domain, destination]);
  run('/bin/launchctl', ['print', target]);
  return { label, destination, backup };
}

function retireLaunchAgent(name, domain, backupDirectory) {
  const destination = path.join(os.homedir(), 'Library', 'LaunchAgents', name);
  const label = name.replace(/\.plist$/, '');
  const target = `${domain}/${label}`;
  const loaded = run('/bin/launchctl', ['print', target], { allowFailure: true }).status === 0;
  if (loaded) run('/bin/launchctl', ['bootout', target]);
  if (!fs.existsSync(destination)) return { label, retired: loaded, backup: null };
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDirectory, `${name}.${stamp}.retired`);
  fs.renameSync(destination, backup);
  return { label, retired: true, backup };
}

function main(args = process.argv.slice(2)) {
  if (!args.includes('--confirm-production')) {
    throw new Error('refusing social autonomy cutover without --confirm-production');
  }
  const configured = configure(['--confirm-production']);
  run(process.execPath, ['scripts/render-launchagents.js']);
  const patchPath = path.join(ROOT, 'workflow', 'openclaw-policy.patch.json');
  run(process.execPath, ['scripts/render-openclaw-workflow-policy.js', '--output', patchPath]);
  run(process.execPath, ['scripts/apply-openclaw-shadow.js', '--confirm-shadow']);
  const domain = `gui/${process.getuid()}`;
  const backupDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents', 'socialsol-backups');
  const installed = LAUNCHAGENTS.map(name => installLaunchAgent(name, domain, backupDirectory));
  const retired = RETIRED_LAUNCHAGENTS.map(name => retireLaunchAgent(name, domain, backupDirectory));
  run('/bin/launchctl', ['kickstart', '-k', `${domain}/ai.openclaw.gateway`]);
  const canaries = [
    run(process.execPath, ['crm/scripts/workflow-trigger.js', 'marketing.report.daily', '--bucket', 'day']),
    run(process.execPath, ['crm/scripts/workflow-trigger.js', 'meta.audience.sync', '--bucket', 'day']),
  ].map(result => JSON.parse(String(result.stdout || '{}')));
  return { ok: true, configured, installed, retired, canaries, gatewayRestarted: true };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(), null, 2)); } catch (error) {
    console.error(`[cutover-social-autonomy] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { LAUNCHAGENTS, RETIRED_LAUNCHAGENTS, installLaunchAgent, main, retireLaunchAgent, run };
