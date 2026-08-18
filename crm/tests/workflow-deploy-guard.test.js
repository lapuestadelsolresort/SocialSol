'use strict';

//
// Tests for the deploy-window guard on scheduled workflow triggers (F-053).
//
// A production deploy reinstalls node_modules in place. A 5-minute trigger
// that fires inside that window started a run whose steps died loading native
// bindings; the failure was classified ambiguous, which opened a durable
// manual review and paused the workflow even though nothing had reached a
// provider. The trigger now skips the tick while a release is in progress —
// and, critically, refuses to treat a crashed deploy's abandoned lock as a
// reason to stop triggering forever.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deployInProgress, main } = require('../scripts/workflow-trigger');

function lockFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-lock-'));
  const file = path.join(dir, 'production-release.lock');
  if (contents !== undefined) {
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  }
  return file;
}

test('no lock file → triggers run normally', () => {
  assert.equal(deployInProgress(lockFile()), null);
});

test('a live deploy holds triggers off', () => {
  const file = lockFile({
    token: 'abc', pid: process.pid, targetSha: 'deadbeef', startedAt: new Date().toISOString(),
  });
  const result = deployInProgress(file);
  assert.equal(result.reason, 'release_in_progress');
  assert.equal(result.pid, process.pid);
  assert.equal(result.targetSha, 'deadbeef');
});

test('a dead owner inside the window still holds triggers off', () => {
  // The deploy shells out; the recorded pid can exit before the lock clears.
  const file = lockFile({ pid: 2 ** 30, startedAt: new Date().toISOString() });
  assert.equal(deployInProgress(file).reason, 'release_in_progress');
});

test('an abandoned lock is ignored so scheduling recovers', () => {
  // Dead owner AND older than the window: a crashed deploy must not silently
  // disable every scheduled graph.
  const file = lockFile({
    pid: 2 ** 30,
    startedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
  });
  assert.equal(deployInProgress(file), null);
});

test('a live owner holds triggers off however old the lock is', () => {
  const file = lockFile({
    pid: process.pid,
    startedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
  });
  assert.equal(deployInProgress(file).reason, 'release_in_progress');
});

test('a malformed lock with no usable owner or age is ignored', () => {
  assert.equal(deployInProgress(lockFile('{not json')), null);
});

test('the trigger skips its tick and exits cleanly during a release', async () => {
  const file = lockFile({ pid: process.pid, startedAt: new Date().toISOString() });
  let fetched = 0;
  const result = await main(['paulina.daily', '--bucket', '5m'], async () => {
    fetched += 1;
    throw new Error('the trigger must not reach the control plane during a release');
  }, { lockPath: file });

  assert.equal(result.skipped, true);
  assert.equal(result.workflow, 'paulina.daily');
  assert.equal(result.reason, 'release_in_progress');
  assert.equal(fetched, 0, 'no run is created, so none can fail ambiguously');
});
