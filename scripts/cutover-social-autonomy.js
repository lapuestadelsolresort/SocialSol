#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../lib/runtime-paths');
const { loadControlToken } = require('../crm/lib/workflow-auth');
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

async function waitForWorkflowRun(runId, {
  fetchImpl = fetch,
  token = loadControlToken(),
  timeoutMs = 15 * 60_000,
  pollMs = 1000,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  if (!runId) throw new Error('workflow canary did not return a run id');
  if (!token || token.length < 32) throw new Error('workflow control token is unavailable');
  const baseUrl = String(process.env.RESORT_WORKFLOW_BASE_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const response = await fetchImpl(`${baseUrl}/api/workflows/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `workflow canary read returned ${response.status}`);
    if (payload.run?.status === 'completed') return payload.run;
    if (['failed', 'blocked'].includes(payload.run?.status)) {
      throw new Error(`workflow canary ${runId} ${payload.run.status}: ${payload.run.error_message || 'no detail'}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`workflow canary ${runId} did not complete within ${timeoutMs}ms`);
}

async function main(args = process.argv.slice(2)) {
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
  const submissions = [
    run(process.execPath, ['crm/scripts/workflow-trigger.js', 'marketing.report.daily', '--bucket', 'day']),
    run(process.execPath, ['crm/scripts/workflow-trigger.js', 'meta.audience.sync', '--bucket', 'day']),
  ].map(result => JSON.parse(String(result.stdout || '{}')));
  const canaries = await Promise.all(submissions.map(submission => waitForWorkflowRun(submission.run?.id)));
  return { ok: true, configured, installed, retired, canaries, gatewayRestarted: true };
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`[cutover-social-autonomy] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  LAUNCHAGENTS,
  RETIRED_LAUNCHAGENTS,
  installLaunchAgent,
  main,
  retireLaunchAgent,
  run,
  waitForWorkflowRun,
};
