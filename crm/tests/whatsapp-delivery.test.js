'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const { sendWhatsApp } = require('../lib/twilio-whatsapp');
const { buildRouter } = require('../routes/whatsapp');
const { queueWhatsAppInbound } = require('../scripts/workflow-worker');

function signTwilio(url, params, token) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + String(params[key]);
  return crypto.createHmac('sha1', token).update(payload).digest('base64');
}

async function request(app, endpoint, options = {}) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, options);
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-status-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      platform TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT UNIQUE,
      message_text TEXT,
      raw_payload TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('Twilio send request registers the delivery/read callback and returns provider state', async () => {
  let form;
  const result = await sendWhatsApp({
    toPhone: '+14155550100',
    message: 'Hello',
    callbackUrl: 'https://example.test/whatsapp/status',
    secrets: {
      account_sid: 'AC-TEST',
      api_key_sid: 'SK-TEST',
      api_key_secret: 'secret',
      whatsapp_number: '+15550001111',
    },
    fetchImpl: async (_url, options) => {
      form = new URLSearchParams(options.body);
      return { ok: true, status: 201, json: async () => ({ sid: 'SM-OUT', status: 'queued' }) };
    },
  });
  assert.equal(result.sid, 'SM-OUT');
  assert.equal(form.get('StatusCallback'), 'https://example.test/whatsapp/status');
  assert.equal(form.get('To'), 'whatsapp:+14155550100');
});

test('Twilio transport ambiguity is marked non-retryable', async () => {
  await assert.rejects(() => sendWhatsApp({
    toPhone: '+14155550100',
    message: 'One attempt',
    secrets: {
      account_sid: 'AC-TEST', api_key_sid: 'SK-TEST', api_key_secret: 'secret',
      whatsapp_number: '+15550001111',
    },
    fetchImpl: async () => { throw new Error('connection reset'); },
  }), error => error.code === 'ambiguous_external_result' && error.retryable === false);
});

test('legacy HTTP send endpoints cannot bypass the #whatsapp control plane', async () => {
  await withDb(async db => {
    const app = express();
    app.use('/api/whatsapp', buildRouter(() => db));
    for (const endpoint of ['/api/whatsapp/reply', '/api/whatsapp/thread-reply']) {
      const response = await request(app, endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dm_id: 1, thread_ts: '1.2', message: 'must not send' }),
      });
      assert.equal(response.status, 410);
      assert.equal(JSON.parse(response.text).code, 'whatsapp_slack_only');
    }
  });
});

test('signed Twilio callbacks persist monotonic delivered/read facts and queue durable Slack reports', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, slack_thread_ts, direction)
      VALUES
      ('2026-08-11T12:00:00Z', 'whatsapp', '+14155550100', 'Guest', 'SM-IN', 'Hi', '123.456', 'inbound'),
      ('2026-08-11T12:01:00Z', 'whatsapp', 'outbound', 'Jason', 'SM-OUT', 'Hello', '123.456', 'outbound')`);

    const callbackUrl = 'https://example.test/webhook/twilio-whatsapp/status';
    process.env.TWILIO_STATUS_CALLBACK_URL = callbackUrl;
    const secrets = { account_sid: 'AC-TEST', auth_token: 'auth-token' };
    const slack = [];
    const app = express();
    app.use('/webhook/twilio-whatsapp', buildRouter(() => db, {
      loadTwilioSecrets: () => secrets,
      postToSlack: async (message, threadTs) => { slack.push({ message, threadTs }); return '999.1'; },
    }));

    for (const providerStatus of ['delivered', 'read']) {
      const params = { AccountSid: 'AC-TEST', MessageSid: 'SM-OUT', MessageStatus: providerStatus };
      const signature = signTwilio(callbackUrl, params, secrets.auth_token);
      const response = await request(app, '/webhook/twilio-whatsapp/status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': signature,
        },
        body: new URLSearchParams(params).toString(),
      });
      assert.equal(response.status, 200);
    }

    const [row] = await db.query(sql`SELECT delivery_status, delivered_at, read_at FROM meta_messages WHERE message_id='SM-OUT'`);
    assert.equal(row.delivery_status, 'read');
    assert.ok(row.delivered_at);
    assert.ok(row.read_at);
    assert.equal(slack.length, 0, 'status notifications must never bypass the outbox');
    const outbox = await db.query(sql`SELECT idempotency_key, payload_json FROM workflow_outbox
      WHERE idempotency_key LIKE 'whatsapp:status:SM-OUT:%' ORDER BY idempotency_key`);
    assert.equal(outbox.length, 2);
    assert.match(outbox.map(row => row.payload_json).join('\n'), /delivered.*Twilio-confirmed/i);
    assert.match(outbox.map(row => row.payload_json).join('\n'), /read.*Twilio-confirmed/i);

    const staleParams = { AccountSid: 'AC-TEST', MessageSid: 'SM-OUT', MessageStatus: 'sent' };
    const staleResponse = await request(app, '/webhook/twilio-whatsapp/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signTwilio(callbackUrl, staleParams, secrets.auth_token),
      },
      body: new URLSearchParams(staleParams).toString(),
    });
    assert.equal(staleResponse.status, 200);
    const [afterStale] = await db.query(sql`SELECT delivery_status FROM meta_messages WHERE message_id='SM-OUT'`);
    assert.equal(afterStale.delivery_status, 'read');
    delete process.env.TWILIO_STATUS_CALLBACK_URL;
  });
});

test('inbound WhatsApp is stored with a durable Slack outbox intent before Twilio is acknowledged', async () => {
  await withDb(async db => {
    const webhookUrl = 'https://example.test/webhook/twilio-whatsapp/webhook';
    const secrets = { account_sid: 'AC-TEST', auth_token: 'auth-token', twilio_webhook_url: webhookUrl };
    let directSlackCalls = 0;
    const app = express();
    app.use('/webhook/twilio-whatsapp', buildRouter(() => db, {
      loadTwilioSecrets: () => secrets,
      postToSlack: async () => { directSlackCalls += 1; throw new Error('inbound must use durable outbox'); },
    }));
    const params = {
      AccountSid: 'AC-TEST', MessageSid: 'SM-INBOUND',
      From: 'whatsapp:+14155550100', To: 'whatsapp:+15550001111',
      Body: 'Hello from a guest', ProfileName: 'Guest', NumMedia: '0',
    };
    const response = await request(app, '/webhook/twilio-whatsapp/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signTwilio(webhookUrl, params, secrets.auth_token),
      },
      body: new URLSearchParams(params).toString(),
    });
    assert.equal(response.status, 200);
    const [message] = await db.query(sql`SELECT direction, delivery_status, processing_status
      FROM meta_messages WHERE message_id='SM-INBOUND'`);
    assert.equal(message.direction, 'inbound');
    assert.equal(message.delivery_status, 'delivered');
    assert.equal(message.processing_status, 'pending');
    const [outbox] = await db.query(sql`SELECT topic, status, payload_json FROM workflow_outbox
      WHERE idempotency_key='whatsapp:inbound:SM-INBOUND:slack'`);
    assert.equal(outbox.topic, 'slack.notification');
    assert.equal(outbox.status, 'pending');
    assert.match(outbox.payload_json, /Plain Slack replies are not sent/);
    assert.equal(directSlackCalls, 0);

    const firstQueue = await queueWhatsAppInbound(db);
    const replayQueue = await queueWhatsAppInbound(db);
    assert.equal(firstQueue.queued, 1);
    assert.equal(replayQueue.queued, 0);
    const [queued] = await db.query(sql`SELECT processing_status, workflow_run_id
      FROM meta_messages WHERE message_id='SM-INBOUND'`);
    assert.equal(queued.processing_status, 'queued');
    assert.ok(queued.workflow_run_id);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_runs
      WHERE workflow_name='whatsapp.inbound.process'`);
    assert.equal(count, 1);
  });
});
