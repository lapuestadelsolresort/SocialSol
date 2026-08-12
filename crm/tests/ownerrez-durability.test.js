'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { buildRouter } = require('../routes/ownerrez');

async function request(app, body) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/api/ownerrez/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from('hook-user:hook-pass').toString('base64')}`,
      },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerrez-durable-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('OwnerRez acknowledges only after durable storage and deduplicates provider retries', async () => {
  await withDb(async db => {
    const app = express();
    app.use(express.json());
    app.use('/api/ownerrez', buildRouter(() => db, {
      loadCredentials: () => ({ user: 'hook-user', pass: 'hook-pass' }),
    }));
    const event = { event_type: 'booking_created', entity_id: 42, arrival: '2026-09-01' };
    assert.equal((await request(app, event)).status, 200);
    assert.equal((await request(app, event)).status, 200);
    const rows = await db.query(sql`SELECT payload_hash, processing_status, processed
      FROM ownerrez_events`);
    assert.equal(rows.length, 1);
    assert.match(rows[0].payload_hash, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].processing_status, 'pending');
    assert.equal(rows[0].processed, 0);
  });
});

test('OwnerRez returns a retryable error when the database is unavailable', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ownerrez', buildRouter(() => null, {
    loadCredentials: () => ({ user: 'hook-user', pass: 'hook-pass' }),
  }));
  assert.equal((await request(app, { event_type: 'inquiry_created' })).status, 503);
});
