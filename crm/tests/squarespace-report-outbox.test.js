'use strict';

//
// F-043 — squarespace-report never recorded outbox delivery failures. On a
// failed Slack post the run aborted: rows stayed pending, attempts stayed 0,
// last_error was never written, and the only evidence of the failure was job
// stderr. Retry semantics were fine (at-least-once with deterministic event
// keys); the observability was not.
//
// F-042 — the same script opened the CRM write-capable for preview runs that
// only read.
//

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// The module reads its Slack account and channel map at import time.
process.env.OPENCLAW_SLACK_ACCOUNT = 'qc-test-account';
process.env.RESORT_BIZEVENT_CHANNEL = 'CBIZEVENT1';

const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');
const { run } = require('../scripts/squarespace-report');

const AUDIENCE = 'business-intel';

function seedOutbox(db) {
  ensureSchemaBetterSqlite(db);
  const columns = db.prepare('PRAGMA table_info(squarespace_notification_outbox)').all().map(c => c.name);
  assert.ok(columns.includes('attempts') && columns.includes('last_error'));
  db.prepare(`INSERT INTO squarespace_notification_outbox
    (audience, event_key, event_type, order_id, payload_json, status)
    VALUES (?, 'evt-1', 'order_created', 'order-1', ?, 'pending')`)
    .run(AUDIENCE, JSON.stringify({ headline: 'Direct booking', lines: ['one'] }));
  return db.prepare('SELECT id FROM squarespace_notification_outbox').all().map(row => row.id);
}

function outboxRow(db) {
  return db.prepare('SELECT status, attempts, last_error, delivered_at FROM squarespace_notification_outbox').get();
}

test('a failed Slack post records the attempt and the error on the row', () => {
  const db = new Database(':memory:');
  try {
    seedOutbox(db);
    process.env.SQUARESPACE_SLACK_ENABLED = '1';
    const failure = new Error('slack post failed: channel_not_found');

    assert.throws(() => run(['--audience', AUDIENCE, '--post'], {
      db,
      post: () => { throw failure; },
    }), /channel_not_found/);

    const row = outboxRow(db);
    assert.equal(row.status, 'pending', 'the row stays pending so the next run retries');
    assert.equal(row.attempts, 1, 'the attempt is now counted');
    assert.match(row.last_error, /channel_not_found/, 'the reason is recorded, not only in stderr');
    assert.equal(row.delivered_at, null);
  } finally {
    delete process.env.SQUARESPACE_SLACK_ENABLED;
    db.close();
  }
});

test('a successful post marks delivered and clears any prior error', () => {
  const db = new Database(':memory:');
  try {
    seedOutbox(db);
    db.prepare("UPDATE squarespace_notification_outbox SET attempts=1, last_error='previous failure'").run();
    process.env.SQUARESPACE_SLACK_ENABLED = '1';
    const posted = [];

    run(['--audience', AUDIENCE, '--post'], { db, post: (channel, message) => posted.push({ channel, message }) });

    assert.equal(posted.length, 1);
    const row = outboxRow(db);
    assert.equal(row.status, 'delivered');
    assert.equal(row.attempts, 2);
    assert.equal(row.last_error, null, 'a stale error does not linger on a delivered row');
    assert.notEqual(row.delivered_at, null);
  } finally {
    delete process.env.SQUARESPACE_SLACK_ENABLED;
    db.close();
  }
});

test('preview mode neither posts nor touches the outbox', () => {
  const db = new Database(':memory:');
  try {
    seedOutbox(db);
    const posted = [];
    run(['--audience', AUDIENCE], { db, post: (...args) => posted.push(args) });
    assert.equal(posted.length, 0);
    const row = outboxRow(db);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
  } finally {
    db.close();
  }
});

test('a preview run opens the database read-only (F-042)', () => {
  // Proven against a real file: an in-memory DB cannot express readonly.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-report-ro-'));
  const file = path.join(directory, 'crm.db');
  const seed = new Database(file);
  seedOutbox(seed);
  seed.close();

  const readonly = new Database(file, { readonly: true });
  try {
    // The handle the preview path now takes cannot write, whatever it runs.
    assert.throws(
      () => readonly.prepare('UPDATE squarespace_notification_outbox SET attempts=99').run(),
      /readonly/i,
    );
    // …and the report still renders from it.
    const report = run(['--audience', AUDIENCE], { db: readonly, post: () => { throw new Error('must not post'); } });
    assert.equal(report, undefined);
  } finally {
    readonly.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
