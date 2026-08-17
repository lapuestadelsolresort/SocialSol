'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  latestVerifyRun,
  parseGithubRemote,
  readFreshInstallReport,
  validateCheckoutState,
} = require('./production-release');

test('production release accepts only explicit GitHub origin shapes', () => {
  assert.deepEqual(parseGithubRemote('https://github.com/example/resort.git'), {
    owner: 'example', repo: 'resort',
  });
  assert.deepEqual(parseGithubRemote('git@github.com:example/resort.git'), {
    owner: 'example', repo: 'resort',
  });
  assert.throws(() => parseGithubRemote('https://example.com/example/resort.git'), /github\.com/);
});

test('production release requires the newest GitHub Actions verify run to pass', () => {
  const passed = {
    id: 2,
    name: 'verify',
    app: { slug: 'github-actions' },
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-08-12T12:00:00Z',
    completed_at: '2026-08-12T12:01:00Z',
    details_url: 'https://github.test/check/2',
  };
  const result = latestVerifyRun({
    check_runs: [
      { ...passed, id: 1, started_at: '2026-08-12T11:00:00Z' },
      passed,
      { ...passed, id: 3, name: 'unrelated' },
    ],
  });
  assert.equal(result.id, 2);
  assert.equal(result.conclusion, 'success');

  assert.throws(() => latestVerifyRun({
    check_runs: [{ ...passed, status: 'in_progress', conclusion: null }],
  }), /in_progress\/pending/);
  assert.throws(() => latestVerifyRun({ check_runs: [] }), /no GitHub Actions verify/);
});

test('deploy trusts only a fresh, well-formed launchagent install report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-report-test-'));
  const reportPath = path.join(dir, 'report.json');
  const deployStartedAt = '2026-08-17T10:00:00.000Z';

  fs.writeFileSync(reportPath, JSON.stringify({
    completedAt: '2026-08-17T10:05:00.000Z',
    restarted: ['com.lapuestadelsolresort.crm'],
    executed: [],
  }));
  const report = readFreshInstallReport(deployStartedAt, reportPath);
  assert.deepEqual(report.restarted, ['com.lapuestadelsolresort.crm']);

  fs.writeFileSync(reportPath, JSON.stringify({
    completedAt: '2026-08-17T09:00:00.000Z', restarted: [],
  }));
  assert.throws(() => readFreshInstallReport(deployStartedAt, reportPath), /stale or malformed/);

  fs.writeFileSync(reportPath, JSON.stringify({ completedAt: '2026-08-17T10:05:00.000Z' }));
  assert.throws(() => readFreshInstallReport(deployStartedAt, reportPath), /stale or malformed/);

  assert.throws(() => readFreshInstallReport(deployStartedAt, path.join(dir, 'missing.json')), /unreadable/);
});

test('production release checkout gate requires clean primary main at origin', () => {
  const valid = {
    branch: 'main', primary: true, status: '', head: 'abc', remoteHead: 'abc',
  };
  assert.equal(validateCheckoutState(valid), true);
  assert.throws(() => validateCheckoutState({ ...valid, branch: 'codex/change' }), /requires branch main/);
  assert.throws(() => validateCheckoutState({ ...valid, primary: false }), /primary checkout/);
  assert.throws(() => validateCheckoutState({ ...valid, status: '?? local.txt' }), /checkout is dirty/);
  assert.throws(() => validateCheckoutState({ ...valid, remoteHead: 'def' }), /not the exact origin\/main/);
});
