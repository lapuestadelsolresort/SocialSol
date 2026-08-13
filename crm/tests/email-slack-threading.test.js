'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { deliverSlackNotification } = require('../lib/workflow-outbox');
const { ensureSchemaAsync } = require('../lib/workflow-schema');

test('multiple messages discovered together share one Slack root deterministically', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-slack-threading-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await ensureSchemaAsync(db, sql);
    const events = await db.query(sql`INSERT INTO email_threads (
      direction, provider, provider_message_id, provider_thread_id,
      processing_status, slack_channel_id
    ) VALUES
      ('inbound', 'gmail', 'm1', 't1', 'processed', 'CEMAIL'),
      ('inbound', 'gmail', 'm2', 't1', 'processed', 'CEMAIL')
    RETURNING id`);
    const posts = [];
    const services = {
      postToChannel: async (_channel, _message, options) => {
        posts.push(options);
        return { ok: true, ts: posts.length === 1 ? '100.1' : '100.2' };
      },
    };
    const payload = id => ({
      channelId: 'CEMAIL', message: `event ${id}`, emailThreadId: id,
      emailConversation: { provider: 'gmail', providerThreadId: 't1' },
    });
    await deliverSlackNotification(db, {}, payload(events[0].id), services);
    await deliverSlackNotification(db, {}, payload(events[1].id), services);
    assert.equal(posts[0].threadTs, null);
    assert.equal(posts[1].threadTs, '100.1');
    const rows = await db.query(sql`SELECT slack_thread_ts, slack_message_ts
      FROM email_threads ORDER BY id`);
    assert.equal(rows[0].slack_thread_ts, '100.1');
    assert.equal(rows[1].slack_thread_ts, '100.1');
    assert.deepEqual(rows.map(row => row.slack_message_ts), ['100.1', '100.2']);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
