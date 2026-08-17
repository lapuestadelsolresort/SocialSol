#!/usr/bin/env node
'use strict';

// Manifest-driven LaunchAgent installer — the single sanctioned install path
// for every com.lapuestadelsolresort.* service (F-016). The authoritative list
// of labels and their expected states lives in deploy/launchagents/service-manifest.json:
//   loaded   — installed from the current render and bootstrapped in launchd
//   disabled — no active plist, never loaded (a .plist.disabled file may remain)
//   retired  — no plist files at all, never loaded, launchd override disabled
//              (reboot-durable retirement, F-041)
//
// Modes:
//   plan                        read-only: print the action plan as JSON
//   check                       read-only: exit 1 when any drift exists
//   apply --confirm-production  execute the plan (backup → atomic install →
//                               bootout/bootstrap → retire → disable)

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../lib/runtime-paths');

const MANIFEST_PATH = path.join(ROOT, 'deploy', 'launchagents', 'service-manifest.json');
const RENDERED_DIR = path.join(ROOT, 'deploy', 'launchagents', 'generated');
const INSTALLED_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const REPORT_PATH = path.join(ROOT, 'runtime', 'launchagents-install-report.json');
const VALID_STATES = new Set(['loaded', 'disabled', 'retired']);

function loadManifest(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || typeof manifest.label_prefix !== 'string' || !manifest.services) {
    throw new Error('service manifest must be version 1 with label_prefix and services');
  }
  for (const [name, entry] of Object.entries(manifest.services)) {
    if (!VALID_STATES.has(entry.state)) {
      throw new Error(`service manifest ${name}: invalid state ${entry.state}`);
    }
  }
  return manifest;
}

function fileKind(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'absent';
  }
}

function contentEquals(leftPath, rightPath) {
  try {
    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
  } catch {
    return false;
  }
}

// Pure planning: derives every action from manifest + rendered dir + installed
// dir + the set of currently loaded labels. No side effects.
function computePlan({ manifest, renderedDir, installedDir, loadedLabels }) {
  const prefix = manifest.label_prefix;
  const actions = [];
  const errors = [];
  const owned = new Set();

  for (const [name, entry] of Object.entries(manifest.services)) {
    const label = `${prefix}${name}`;
    const plistName = `${label}.plist`;
    const disabledName = `${plistName}.disabled`;
    owned.add(plistName);
    owned.add(disabledName);
    const renderedPath = path.join(renderedDir, plistName);
    const installedPath = path.join(installedDir, plistName);
    const disabledPath = path.join(installedDir, disabledName);
    const installedKind = fileKind(installedPath);
    const disabledKind = fileKind(disabledPath);
    const isLoaded = loadedLabels.has(label);

    if (entry.state === 'loaded') {
      if (fileKind(renderedPath) !== 'file') {
        errors.push({ label, problem: 'rendered-plist-missing', path: renderedPath });
        continue;
      }
      let reason = null;
      if (installedKind === 'absent') reason = 'not-installed';
      else if (installedKind === 'symlink') reason = 'symlink-definition';
      else if (!contentEquals(renderedPath, installedPath)) reason = 'content-drift';
      if (reason) {
        actions.push({
          type: 'install', label, name, reason,
          source: renderedPath, target: installedPath,
          bootout: isLoaded, bootstrap: true,
        });
      } else if (!isLoaded) {
        actions.push({ type: 'bootstrap', label, name, reason: 'not-loaded', target: installedPath });
      }
      if (disabledKind !== 'absent') {
        actions.push({ type: 'remove-stray-disabled', label, name, target: disabledPath });
      }
    } else if (entry.state === 'disabled') {
      if (isLoaded) actions.push({ type: 'bootout', label, name, reason: 'disabled-service-loaded' });
      if (installedKind !== 'absent') {
        actions.push({ type: 'remove-file', label, name, reason: 'disabled-service-active-plist', target: installedPath });
      }
      // a .plist.disabled remnant is the coherent representation — leave it.
    } else { // retired
      if (isLoaded) actions.push({ type: 'bootout', label, name, reason: 'retired-service-loaded' });
      if (installedKind !== 'absent') {
        actions.push({ type: 'remove-file', label, name, reason: 'retired', target: installedPath });
      }
      if (disabledKind !== 'absent') {
        actions.push({ type: 'remove-file', label, name, reason: 'retired', target: disabledPath });
      }
      actions.push({ type: 'disable', label, name, reason: 'retired-reboot-durability' });
    }
  }

  // Unmanaged com.lapuestadelsolresort.* files are drift, never auto-deleted.
  const strays = [];
  for (const existing of fs.readdirSync(installedDir)) {
    if (!existing.startsWith(prefix)) continue;
    if (fileKind(path.join(installedDir, existing)) === 'other') continue;
    if (!/\.plist(\.disabled)?$/.test(existing)) continue;
    if (!owned.has(existing)) strays.push(existing);
  }
  // Loaded labels in our namespace that the manifest does not own at all.
  const strayLoaded = [...loadedLabels]
    .filter(label => label.startsWith(prefix))
    .filter(label => !(label.slice(prefix.length) in manifest.services));

  return { actions, errors, strays, strayLoaded };
}

// `disable` actions are only reboot-durability hardening: when the retired
// label has no plist left and is not loaded, the plan is convergent even if
// the override was never written (print-disabled cannot be read atomically),
// so drift excludes them.
function planHasDrift(plan) {
  const material = plan.actions.filter(action => action.type !== 'disable');
  return material.length > 0 || plan.errors.length > 0
    || plan.strays.length > 0 || plan.strayLoaded.length > 0;
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 60_000 });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function loadedResortLabels(prefix) {
  const result = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}`], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('launchctl print gui domain failed');
  // Only the services section lists loaded jobs; the disabled section and
  // other references would produce false positives, so probe each candidate.
  const candidates = new Set(String(result.stdout).match(new RegExp(`${prefix.replaceAll('.', '\\.')}[a-z0-9-]+`, 'g')) || []);
  const loaded = new Set();
  for (const label of candidates) {
    if (launchctl(['print', `gui/${process.getuid()}/${label}`], { allowFailure: true }).status === 0) {
      loaded.add(label);
    }
  }
  return loaded;
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

function backupFile(sourcePath, backupsDir) {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupsDir, `${path.basename(sourcePath)}.${stamp}.bak`);
  fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

function executePlan(plan, { installedDir = INSTALLED_DIR } = {}) {
  const domain = `gui/${process.getuid()}`;
  const backupsDir = path.join(installedDir, 'socialsol-backups');
  const executed = [];
  const restarted = [];
  if (plan.errors.length) {
    throw new Error(`refusing to apply with plan errors: ${JSON.stringify(plan.errors)}`);
  }
  const byType = type => plan.actions.filter(action => action.type === type);

  // 1. Retirements and disabled-state cleanup first: bootout, remove, disable.
  for (const action of [...byType('bootout')]) {
    launchctl(['bootout', `${domain}/${action.label}`]);
    pause(500);
    executed.push(action);
  }
  for (const action of [...byType('remove-file'), ...byType('remove-stray-disabled')]) {
    const backup = backupFile(action.target, backupsDir);
    fs.unlinkSync(action.target);
    executed.push({ ...action, backup });
  }
  for (const action of byType('disable')) {
    launchctl(['disable', `${domain}/${action.label}`]);
    executed.push(action);
  }

  // 2. Installs / replacements, then (re)bootstrap.
  for (const action of byType('install')) {
    let backup = null;
    if (fileKind(action.target) !== 'absent') backup = backupFile(action.target, backupsDir);
    const temp = `${action.target}.${crypto.randomUUID()}.tmp`;
    fs.copyFileSync(action.source, temp);
    if (fileKind(action.target) === 'symlink') fs.unlinkSync(action.target);
    fs.renameSync(temp, action.target);
    if (action.bootout) {
      launchctl(['bootout', `${domain}/${action.label}`]);
      pause(500);
    }
    launchctl(['enable', `${domain}/${action.label}`]);
    bootstrapWithRetry(domain, action.target);
    if (action.bootout) restarted.push(action.label);
    executed.push({ ...action, backup });
  }
  for (const action of byType('bootstrap')) {
    launchctl(['enable', `${domain}/${action.label}`]);
    bootstrapWithRetry(domain, action.target);
    executed.push(action);
  }
  return { executed, restarted };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true, mode: 0o700 });
  const temp = `${REPORT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, REPORT_PATH);
  return REPORT_PATH;
}

function main(args = process.argv.slice(2)) {
  const mode = args[0] || 'plan';
  const manifest = loadManifest();
  const loadedLabels = loadedResortLabels(manifest.label_prefix);
  const plan = computePlan({
    manifest,
    renderedDir: RENDERED_DIR,
    installedDir: INSTALLED_DIR,
    loadedLabels,
  });
  if (mode === 'plan') {
    return { ok: true, drift: planHasDrift(plan), ...plan };
  }
  if (mode === 'check') {
    const drift = planHasDrift(plan);
    if (drift) {
      process.exitCode = 1;
      return { ok: false, drift, ...plan };
    }
    return { ok: true, drift: false, services: Object.keys(manifest.services).length };
  }
  if (mode === 'apply') {
    if (!args.includes('--confirm-production')) {
      throw new Error('refusing LaunchAgent install without --confirm-production');
    }
    const { executed, restarted } = executePlan(plan);
    const report = {
      version: 1,
      completedAt: new Date().toISOString(),
      executed,
      restarted,
      strays: plan.strays,
      strayLoaded: plan.strayLoaded,
    };
    writeReport(report);
    return { ok: true, applied: executed.length, restarted, reportPath: REPORT_PATH };
  }
  throw new Error('usage: install-launchagents.js plan | check | apply --confirm-production');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
  } catch (error) {
    console.error(`[install-launchagents] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  computePlan,
  contentEquals,
  executePlan,
  fileKind,
  loadManifest,
  planHasDrift,
  MANIFEST_PATH,
  REPORT_PATH,
};
