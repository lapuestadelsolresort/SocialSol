#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const LOCK_PATH = path.join(RUNTIME_DIR, 'production-release.lock');
const DEPLOYMENT_DIR = path.join(RUNTIME_DIR, 'deployments');
const REQUIRED_BRANCH = 'main';
const CORE_SERVICES = [
  'com.lapuestadelsolresort.crm',
  'com.lapuestadelsolresort.workflow-worker',
];

function command(program, args, {
  cwd = ROOT,
  env = process.env,
  allowFailure = false,
  inherit = false,
  timeout = 30 * 60_000,
} = {}) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${program} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function git(args, options = {}) {
  return command('git', args, options);
}

function gitText(args) {
  return String(git(args).stdout || '').trim();
}

function parseGithubRemote(remote) {
  const value = String(remote || '').trim();
  const match = value.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error('origin must be a github.com repository URL');
  return { owner: match[1], repo: match[2] };
}

function latestVerifyRun(payload) {
  const checks = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const candidates = checks
    .filter(check => check.name === 'verify' && check.app?.slug === 'github-actions')
    .sort((left, right) => String(right.started_at || '').localeCompare(String(left.started_at || '')));
  if (!candidates.length) throw new Error('no GitHub Actions verify check exists for origin/main');
  const latest = candidates[0];
  if (latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error(`latest GitHub Actions verify check is ${latest.status}/${latest.conclusion || 'pending'}`);
  }
  return {
    id: latest.id,
    status: latest.status,
    conclusion: latest.conclusion,
    detailsUrl: latest.details_url,
    startedAt: latest.started_at,
    completedAt: latest.completed_at,
  };
}

function githubVerification(remote, sha) {
  const repository = parseGithubRemote(remote);
  const response = command('gh', [
    'api',
    `repos/${repository.owner}/${repository.repo}/commits/${sha}/check-runs`,
    '--method', 'GET',
    '-f', 'per_page=100',
  ]);
  let payload;
  try { payload = JSON.parse(response.stdout); } catch { throw new Error('GitHub check response was not valid JSON'); }
  return { repository: `${repository.owner}/${repository.repo}`, verify: latestVerifyRun(payload) };
}

function primaryCheckout() {
  const gitDirectory = path.resolve(gitText(['rev-parse', '--path-format=absolute', '--git-dir']));
  const commonDirectory = path.resolve(gitText(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return { gitDirectory, commonDirectory, primary: gitDirectory === commonDirectory };
}

function validateCheckoutState({ branch, primary, status, head, remoteHead }) {
  if (branch !== REQUIRED_BRANCH) {
    throw new Error(`production release requires branch ${REQUIRED_BRANCH}; found ${branch || 'detached HEAD'}`);
  }
  if (!primary) throw new Error('production release must run from the primary checkout, not a linked worktree');
  if (status) throw new Error(`production checkout is dirty:\n${status}`);
  if (head !== remoteHead) {
    throw new Error(`local main ${head} is not the exact origin/main commit ${remoteHead}; fast-forward it before deployment`);
  }
  return true;
}

function inspectCheckout({ fetch = true, verifyGithub = true } = {}) {
  if (fetch) git(['fetch', '--prune', 'origin', REQUIRED_BRANCH]);
  const branch = gitText(['branch', '--show-current']);
  const checkout = primaryCheckout();
  const status = gitText(['status', '--porcelain=v1', '--untracked-files=all']);
  const head = gitText(['rev-parse', 'HEAD']);
  const remoteHead = gitText(['rev-parse', `origin/${REQUIRED_BRANCH}`]);
  validateCheckoutState({ branch, primary: checkout.primary, status, head, remoteHead });
  const remote = gitText(['remote', 'get-url', 'origin']);
  const github = verifyGithub ? githubVerification(remote, head) : null;
  return {
    ok: true,
    root: ROOT,
    branch,
    head,
    remoteHead,
    remote,
    primaryCheckout: checkout.primary,
    clean: true,
    github,
  };
}

function acquireLock(targetSha) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const lock = {
    token,
    pid: process.pid,
    targetSha,
    startedAt: new Date().toISOString(),
  };
  let descriptor;
  try {
    descriptor = fs.openSync(LOCK_PATH, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`another production release lock exists at ${LOCK_PATH}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return lock;
}

function releaseLock(lock) {
  try {
    const current = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (current.token === lock.token) fs.unlinkSync(LOCK_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function clearStaleLock(args) {
  if (!args.includes('--confirm-stale-lock')) {
    throw new Error('refusing to remove a release lock without --confirm-stale-lock');
  }
  if (!fs.existsSync(LOCK_PATH)) return { ok: true, removed: false, reason: 'no lock exists' };
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  if (processIsAlive(Number(lock.pid))) throw new Error(`release process ${lock.pid} is still running`);
  fs.unlinkSync(LOCK_PATH);
  return { ok: true, removed: true, lock };
}

const INSTALL_REPORT_PATH = path.join(RUNTIME_DIR, 'launchagents-install-report.json');

// The install step writes a report of what it restarted; the core-service
// kickstarts must skip those labels so each daemon restarts exactly once per
// deploy. A missing or stale report means the install step did not complete.
function readFreshInstallReport(deployStartedAt, reportPath = INSTALL_REPORT_PATH) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`launchagent install report unreadable at ${reportPath}: ${error.message}`);
  }
  if (!Array.isArray(report.restarted) || String(report.completedAt || '') < deployStartedAt) {
    throw new Error('launchagent install report is stale or malformed; install step did not complete');
  }
  return report;
}

function writeDeploymentRecord(record) {
  fs.mkdirSync(DEPLOYMENT_DIR, { recursive: true, mode: 0o700 });
  const stamp = record.startedAt.replace(/[:.]/g, '-');
  const destination = path.join(DEPLOYMENT_DIR, `${stamp}-${record.targetSha.slice(0, 12)}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return destination;
}

function runStep(record, name, program, args, options = {}) {
  const step = { name, startedAt: new Date().toISOString(), status: 'running' };
  record.steps.push(step);
  try {
    command(program, args, { ...options, inherit: true });
    step.status = 'completed';
  } catch (error) {
    step.status = 'failed';
    step.error = error.message;
    throw error;
  } finally {
    step.completedAt = new Date().toISOString();
  }
}

function deploy(args) {
  if (!args.includes('--confirm-production')) {
    throw new Error('refusing production deployment without --confirm-production');
  }
  const checkout = inspectCheckout();
  const lock = acquireLock(checkout.head);
  const record = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    targetSha: checkout.head,
    repository: checkout.github.repository,
    verify: checkout.github.verify,
    steps: [],
  };
  let recordPath = null;
  try {
    runStep(record, 'encrypted_backup', 'python3', ['automation/crm_backup.py', '--force']);
    runStep(record, 'restore_drill', 'python3', ['automation/backup_restore_drill.py']);
    runStep(record, 'install_dependencies', 'npm', ['ci'], {
      env: { ...process.env, PYTHON: '/usr/bin/python3' },
    });
    runStep(record, 'full_stack_validation', 'npm', ['run', 'check:stack'], {
      env: {
        ...process.env,
        RESORT_WORKFLOW_POLICY_PATH: path.join(os.tmpdir(), `socialsol-ci-policy-${process.pid}-does-not-exist.json`),
      },
    });
    runStep(record, 'render_launchagents', 'npm', ['run', 'render:launchagents']);
    runStep(record, 'install_launchagents', process.execPath, ['scripts/install-launchagents.js', 'apply', '--confirm-production']);
    const installReport = readFreshInstallReport(record.startedAt);
    record.launchagents = {
      restarted: installReport.restarted,
      applied: Array.isArray(installReport.executed) ? installReport.executed.length : null,
    };
    const domain = `gui/${process.getuid()}`;
    for (const label of CORE_SERVICES) {
      if (installReport.restarted.includes(label)) continue;
      runStep(record, `restart_${label}`, '/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`]);
    }
    runStep(record, 'service_convergence', process.execPath, ['scripts/install-launchagents.js', 'check']);
    runStep(record, 'crm_health', 'curl', [
      '--fail', '--silent', '--show-error', '--retry', '20', '--retry-delay', '1',
      '--retry-connrefused', '--max-time', '30', 'http://127.0.0.1:3456/healthz',
    ]);
    runStep(record, 'workflow_health', 'python3', ['automation/workflow_health.py', '--check-only'], {
      env: { ...process.env, PYTHONPATH: 'automation' },
    });
    inspectCheckout({ fetch: false, verifyGithub: false });
    record.status = 'completed';
    return record;
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    throw error;
  } finally {
    record.completedAt = new Date().toISOString();
    try {
      recordPath = writeDeploymentRecord(record);
      record.recordPath = recordPath;
      process.stderr.write(`[production-release] deployment record: ${recordPath}\n`);
    } finally {
      releaseLock(lock);
    }
  }
}

/**
 * Non-fatal summary of the runtime policy fingerprint (F-055). Reported, not
 * enforced: `check` also runs where workflow/policy.json is deliberately
 * absent (CI points RESORT_WORKFLOW_POLICY_PATH at a nonexistent file), and a
 * legitimate hand-install that skipped the record step should be visible
 * rather than blocking.
 */
function policyFingerprintSummary() {
  try {
    // eslint-disable-next-line global-require
    const { checkFingerprint } = require('./policy-fingerprint');
    const result = checkFingerprint();
    return {
      status: result.status,
      agreement: result.agreement?.status || null,
      agreementViolations: result.agreement?.violations?.length ? result.agreement.violations : undefined,
      currentSha: result.current?.sha256?.slice(0, 16) || null,
      recordedSha: result.recorded?.sha256?.slice(0, 16) || null,
      recordedAt: result.recorded?.recorded_at || null,
    };
  } catch (error) {
    return { status: 'check_error', error: error.message };
  }
}

function main(args = process.argv.slice(2)) {
  const action = args[0] || 'check';
  if (action === 'check') return { ...inspectCheckout(), policyFingerprint: policyFingerprintSummary() };
  if (action === 'deploy') return deploy(args.slice(1));
  if (action === 'unlock') return clearStaleLock(args.slice(1));
  throw new Error('usage: production-release.js check | deploy --confirm-production | unlock --confirm-stale-lock');
}

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[production-release] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  acquireLock,
  clearStaleLock,
  inspectCheckout,
  readFreshInstallReport,
  latestVerifyRun,
  main,
  parseGithubRemote,
  primaryCheckout,
  processIsAlive,
  releaseLock,
  validateCheckoutState,
};
