'use strict';

// F-064: SQLite write-lock contention on the shared CRM file.
//
// Every historical SQLITE_BUSY failure landed in a local projection write
// after the provider command had already run, and each one opened a
// cadence-blocking manual review. These tests pin the repair: local writes
// retry a lost lock with bounded backoff, provider-effect steps still fail
// closed, and a provider command is never re-run because its projection lost
// the race.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const store = require('../lib/workflow-store');
const { executeGraph, startGraph, BUSY_LOCAL_STEP_MAX_ATTEMPTS } = require('../lib/workflow-engine');
const durable = require('../workflows/durable-job');
const {
  DEFAULT_BUSY_TIMEOUT_MS,
  betterSqliteOptions,
  busyRetryDelayMs,
  busyTimeoutMs,
  connectionOptions,
  isSqliteBusy,
  withBusyRetry,
} = require('../lib/sqlite-busy');

const makeDurableJob = durable.makeDurableJob || durable;

function busyError(message = 'SQLITE_BUSY: database is locked') {
  return Object.assign(new Error(message), { code: 'SQLITE_BUSY', errno: 5 });
}

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-busy-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// The worker resumes a `retry` step once available_at passes; the test pulls
// that moment forward instead of sleeping through the backoff.
async function settle(db, definition, runId, services = {}) {
  for (let round = 0; round < 12; round += 1) {
    const run = await store.getRun(db, runId);
    if (run.status === 'completed' || run.status === 'failed') return run;
    await db.query(sql`UPDATE workflow_steps SET available_at='2000-01-01T00:00:00.000Z'
      WHERE run_id=${runId} AND status='retry'`);
    await executeGraph(db, definition, runId, services);
  }
  throw new Error('run did not settle');
}

async function reviews(db, runId) {
  return db.query(sql`SELECT reason_code, status FROM workflow_manual_reviews WHERE run_id=${runId}`);
}

async function events(db, runId, type) {
  return db.query(sql`SELECT payload_json FROM workflow_events WHERE run_id=${runId} AND event_type=${type} ORDER BY id`);
}

test('isSqliteBusy recognises driver busy/locked errors and nothing else', () => {
  assert.equal(isSqliteBusy(busyError()), true);
  assert.equal(isSqliteBusy(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' })), true);
  assert.equal(isSqliteBusy(new Error('SQLITE_BUSY: database is locked')), true);
  assert.equal(isSqliteBusy(new Error('database is locked')), true);
  assert.equal(isSqliteBusy(Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT' })), false);
  assert.equal(isSqliteBusy(new Error('workflow command failed')), false);
  assert.equal(isSqliteBusy(null), false);
});

test('busy backoff grows, is capped, and carries bounded jitter', () => {
  assert.equal(busyRetryDelayMs(1, { random: () => 0 }), 250);
  assert.equal(busyRetryDelayMs(2, { random: () => 0 }), 500);
  assert.equal(busyRetryDelayMs(3, { random: () => 0 }), 1000);
  assert.equal(busyRetryDelayMs(9, { random: () => 0 }), 4000);
  assert.equal(busyRetryDelayMs(9, { random: () => 0.999 }), 4000 + 999);
  assert.equal(busyRetryDelayMs(1, { random: () => 0.999 }), 250 + 249);
});

test('withBusyRetry repeats only busy failures and stops at the budget', async () => {
  const sleeps = [];
  const sleep = ms => { sleeps.push(ms); return Promise.resolve(); };
  let calls = 0;
  const value = await withBusyRetry(async () => {
    calls += 1;
    if (calls < 3) throw busyError();
    return 'done';
  }, { sleep, random: () => 0 });
  assert.equal(value, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 500]);

  calls = 0;
  await assert.rejects(
    withBusyRetry(async () => { calls += 1; throw Object.assign(new Error('boom'), { code: 'SQLITE_CONSTRAINT' }); }, { sleep }),
    /boom/,
  );
  assert.equal(calls, 1, 'a non-busy error is never retried');

  calls = 0;
  const retries = [];
  await assert.rejects(
    withBusyRetry(async () => { calls += 1; throw busyError(); }, { sleep, attempts: 3, onRetry: info => retries.push(info.attempt) }),
    error => isSqliteBusy(error) && error.busyAttempts === 3,
  );
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test('connection helpers hand every writer a real busy timeout', () => {
  assert.equal(DEFAULT_BUSY_TIMEOUT_MS, 15_000);
  assert.deepEqual(connectionOptions({}), { busyTimeout: 15_000 });
  assert.deepEqual(connectionOptions({ SQLITE_BUSY_TIMEOUT_MS: '2500' }), { busyTimeout: 2500 });
  assert.equal(busyTimeoutMs({ SQLITE_BUSY_TIMEOUT_MS: 'nonsense' }), 15_000);
  assert.deepEqual(betterSqliteOptions({ readonly: true }, {}), { readonly: true, timeout: 15_000 });
  assert.ok(DEFAULT_BUSY_TIMEOUT_MS > 1000, 'must exceed the node-sqlite3 default that produced the failures');
});

test('a local-only step that loses the write lock is retried and completes', async () => {
  await withDb(async db => {
    let calls = 0;
    const definition = {
      name: 'test.busy.local',
      version: 1,
      capability: 'crm.write',
      mutates: true,
      steps: [{
        key: 'project',
        effectClass: 'local_write',
        maxAttempts: 1,
        async run() {
          calls += 1;
          if (calls <= 2) throw busyError();
          return { ok: true, calls };
        },
      }],
    };
    const started = await startGraph(db, definition, {
      idempotencyKey: 'busy:local:1', triggerType: 'system', triggerRef: 'test', input: {},
    });
    assert.equal(started.status, 'retry', 'first loss schedules a retry instead of failing the run');
    const run = await settle(db, definition, started.id);
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(calls, 3);
    const [step] = await db.query(sql`SELECT attempts, status FROM workflow_steps WHERE run_id=${run.id}`);
    assert.equal(step.status, 'completed');
    assert.equal(Number(step.attempts), 3, 'busy budget applies beyond the declared maxAttempts of 1');
    const scheduled = await events(db, run.id, 'step_retry_scheduled');
    assert.equal(scheduled.length, 2);
    for (const row of scheduled) assert.equal(JSON.parse(row.payload_json).code, 'SQLITE_BUSY');
    assert.deepEqual(await reviews(db, run.id), []);
  });
});

test('the local busy budget is bounded and exhaustion fails the run without a review', async () => {
  await withDb(async db => {
    let calls = 0;
    const definition = {
      name: 'test.busy.exhaust',
      version: 1,
      capability: 'crm.write',
      mutates: true,
      steps: [{ key: 'project', effectClass: 'local_write', maxAttempts: 1, async run() { calls += 1; throw busyError(); } }],
    };
    const started = await startGraph(db, definition, { idempotencyKey: 'busy:exhaust:1', triggerType: 'system', input: {} });
    const run = await settle(db, definition, started.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'SQLITE_BUSY');
    assert.equal(calls, BUSY_LOCAL_STEP_MAX_ATTEMPTS);
    assert.deepEqual(await reviews(db, run.id), []);
  });
});

test('a provider-effect step that loses the write lock still fails closed with no retry', async () => {
  await withDb(async db => {
    let calls = 0;
    const definition = {
      name: 'test.busy.external',
      version: 1,
      capability: 'crm.write',
      mutates: true,
      steps: [{ key: 'send', effectClass: 'external_non_idempotent', maxAttempts: 3, async run() { calls += 1; throw busyError(); } }],
    };
    const started = await startGraph(db, definition, { idempotencyKey: 'busy:external:1', triggerType: 'system', input: {} });
    assert.equal(started.status, 'failed');
    assert.equal(calls, 1, 'a provider-effect step is never repeated on a busy error');
    const [step] = await db.query(sql`SELECT attempts, status FROM workflow_steps WHERE run_id=${started.id}`);
    assert.equal(Number(step.attempts), 1);
    assert.equal(step.status, 'failed');
  });
});

test('a non-busy error on a local step keeps the declared budget', async () => {
  await withDb(async db => {
    let calls = 0;
    const definition = {
      name: 'test.busy.plain',
      version: 1,
      capability: 'crm.write',
      mutates: true,
      steps: [{ key: 'project', effectClass: 'local_write', maxAttempts: 1, async run() { calls += 1; throw new Error('plain failure'); } }],
    };
    const started = await startGraph(db, definition, { idempotencyKey: 'busy:plain:1', triggerType: 'system', input: {} });
    assert.equal(started.status, 'failed');
    assert.equal(calls, 1);
  });
});

function testJob(name) {
  return makeDurableJob({
    name,
    capability: 'crm.write',
    provider: 'test-provider',
    executeEffectClass: 'external_idempotent',
    notifyOnWrite: false,
    buildCommand: () => ({ program: 'node', args: ['-e', '0'] }),
    verify: async () => ({ verified: true, source: 'test.readback', evidence: { ok: true } }),
  });
}

test('durable job: a lost write lock on the post-dispatch projection is retried and the command is never re-run', async () => {
  await withDb(async db => {
    const original = store.transitionEffect;
    let projectionAttempts = 0;
    let commands = 0;
    store.transitionEffect = async (connection, args) => {
      if (args.status === 'accepted_by_provider') {
        projectionAttempts += 1;
        if (projectionAttempts === 1) throw busyError();
      }
      return original(connection, args);
    };
    try {
      const definition = testJob('test.job.projection');
      const services = {
        shadowMode: false,
        runCommand: async () => { commands += 1; return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }; },
      };
      const run = await startGraph(db, definition, { idempotencyKey: 'busy:job:1', triggerType: 'system', input: {} }, services);
      assert.equal(run.status, 'completed', run.error_message);
      assert.equal(commands, 1, 'the provider command ran exactly once');
      assert.equal(projectionAttempts, 2, 'the projection write was retried after the lost lock');
      const [effect] = await db.query(sql`SELECT status, provider_ref FROM workflow_effects WHERE run_id=${run.id}`);
      assert.equal(effect.status, 'verified_by_readback');
      assert.equal(effect.provider_ref, `job:${run.id}`);
      const [execute] = await db.query(sql`SELECT attempts FROM workflow_steps WHERE run_id=${run.id} AND step_key='execute'`);
      assert.equal(Number(execute.attempts), 1, 'the step itself did not need a second attempt');
      assert.deepEqual(await reviews(db, run.id), []);
    } finally {
      store.transitionEffect = original;
    }
  });
});

test('durable job: when the projection keeps losing the lock the step still opens a manual review and the command is not repeated', async () => {
  await withDb(async db => {
    const original = store.transitionEffect;
    let projectionAttempts = 0;
    let commands = 0;
    store.transitionEffect = async (connection, args) => {
      if (args.status === 'accepted_by_provider') {
        projectionAttempts += 1;
        throw busyError();
      }
      return original(connection, args);
    };
    try {
      const definition = testJob('test.job.exhausted');
      const services = {
        shadowMode: false,
        runCommand: async () => { commands += 1; return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }; },
      };
      const run = await startGraph(db, definition, { idempotencyKey: 'busy:job:2', triggerType: 'system', input: {} }, services);
      assert.equal(run.status, 'failed');
      assert.equal(run.error_code, 'SQLITE_BUSY');
      assert.equal(commands, 1, 'exhausting the projection budget never re-runs the provider command');
      assert.equal(projectionAttempts, 5, 'five bounded attempts before giving up');
      const opened = await reviews(db, run.id);
      assert.equal(opened.length, 1);
      assert.equal(opened[0].reason_code, 'manual_review_required');
      assert.equal(opened[0].status, 'open');
    } finally {
      store.transitionEffect = original;
    }
  });
});
