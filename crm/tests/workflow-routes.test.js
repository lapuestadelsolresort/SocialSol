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
const { createEffect, createManualReview } = require('../lib/workflow-store');
const { buildRouter } = require('../routes/workflows');

async function request(app, endpoint, options) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, options);
    return { status: response.status, payload: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('workflow HTTP route authorizes and queues without executing provider effects inline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-route-'));
  const previousPolicy = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: true,
    live_workflows: ['whatsapp.reply'],
    channels: { 'C-WA': { name: 'whatsapp', capabilities: ['whatsapp.send'] } },
    autonomous_workflows: [],
    write_notifications: { user_ids: ['U-JASON'] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
      platform TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT,
      message_id TEXT UNIQUE, message_text TEXT, raw_payload TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    let sends = 0;
    const token = 'route-test-control-token-that-is-long-enough';
    const app = express();
    app.use('/api/workflows', buildRouter(() => db, {
      controlPlaneToken: token,
      sendWhatsApp: async () => { sends += 1; },
    }));
    const body = {
      workflow: 'whatsapp.reply',
      input: { dmId: 1, message: 'Queue only' },
      context: {
        origin: 'slack', channel_id: 'C-WA', actor_user_id: 'U-JASON',
        message_id: '100.1', entrypoint: 'slack_whatsapp_command',
      },
      idempotency_key: 'route-queue-test',
    };
    const queued = await request(app, '/api/workflows/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.payload.run.status, 'queued');
    assert.equal(sends, 0);
    const [step] = await db.query(sql`SELECT attempts, status FROM workflow_steps
      WHERE run_id=${queued.payload.run.id} ORDER BY ordinal LIMIT 1`);
    assert.equal(step.attempts, 0);
    assert.equal(step.status, 'pending');

    const modelAttempt = await request(app, '/api/workflows/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ...body,
        idempotency_key: 'route-model-bypass-test',
        context: { ...body.context, entrypoint: 'model_tool' },
      }),
    });
    assert.equal(modelAttempt.status, 403);
    assert.equal(modelAttempt.payload.code, 'workflow_trigger_forbidden');
    assert.equal(sends, 0);

    const effect = await createEffect(db, {
      runId: queued.payload.run.id, stepKey: 'register_effect',
      effectType: 'message_delivery', provider: 'twilio', operation: 'whatsapp.send',
      idempotencyKey: 'route-review-effect', request: { body: 'Queue only' },
      verificationMode: 'callback_optional',
    });
    const review = await createManualReview(db, {
      runId: queued.payload.run.id, stepKey: 'send_via_twilio', effectId: effect.id,
      reviewChannelId: 'C-WA', reasonMessage: 'test review',
    });
    const unauthorized = await request(app, `/api/workflows/manual-reviews/${review.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        resolution: 'confirmed_not_sent',
        context: { channel_id: 'C-WA', actor_user_id: 'U-NOT-REVIEWER', entrypoint: 'slack_manual_review_command' },
      }),
    });
    assert.equal(unauthorized.status, 403);
    const resolved = await request(app, `/api/workflows/manual-reviews/${review.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        resolution: 'confirmed_not_sent',
        context: { channel_id: 'C-WA', actor_user_id: 'U-JASON', entrypoint: 'slack_manual_review_command' },
      }),
    });
    assert.equal(resolved.status, 200);
    const conflict = await request(app, `/api/workflows/manual-reviews/${review.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        resolution: 'confirmed_sent', provider_ref: 'SM-CONFLICT',
        context: { channel_id: 'C-WA', actor_user_id: 'U-JASON', entrypoint: 'slack_manual_review_command' },
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.code, 'manual_review_resolution_conflict');
  } finally {
    await db.dispose();
    if (previousPolicy === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = previousPolicy;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the definitions endpoint answers per channel so the help surface need not guess (F-058)', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-definitions-'));
  const previousPolicy = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: true,
    live_workflows: ['whatsapp.reply', 'qbo.write'],
    channels: {
      'C-WA': { name: 'whatsapp', capabilities: ['whatsapp.send', 'whatsapp.read'] },
      'C-IDLE': { name: 'random-ops', capabilities: [] },
    },
    autonomous_workflows: [],
    write_notifications: { user_ids: ['U-JASON'] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  const token = 'definitions-test-control-token-long-enough';
  try {
    const app = express();
    app.use('/api/workflows', buildRouter(() => null, { controlPlaneToken: token }));
    const headers = { Authorization: `Bearer ${token}` };

    const plain = await request(app, '/api/workflows/definitions', { headers });
    assert.equal(plain.status, 200);
    assert.equal(plain.payload.shadow_mode, true);
    assert.deepEqual(plain.payload.live_workflows, ['whatsapp.reply', 'qbo.write']);
    assert.ok(plain.payload.definitions.length > 40);
    // an unrequested channel is absent rather than null — the shape says "not asked"
    assert.equal('channel' in plain.payload, false);

    const scoped = await request(app, '/api/workflows/definitions?channel=C-WA', { headers });
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.payload.channel, {
      id: 'C-WA', name: 'whatsapp', capabilities: ['whatsapp.send', 'whatsapp.read'],
    });
    assert.deepEqual(scoped.payload.live_workflows, plain.payload.live_workflows);

    // the gateway's `channel:` conversation-id prefix is accepted (F-051 lesson)
    const prefixed = await request(app, `/api/workflows/definitions?channel=${encodeURIComponent('channel:C-WA')}`, { headers });
    assert.equal(prefixed.payload.channel.id, 'C-WA');

    const capabilityless = await request(app, '/api/workflows/definitions?channel=C-IDLE', { headers });
    assert.deepEqual(capabilityless.payload.channel, { id: 'C-IDLE', name: 'random-ops', capabilities: [] });

    const unknown = await request(app, '/api/workflows/definitions?channel=C-NOWHERE', { headers });
    assert.equal(unknown.payload.channel, null);

    const unauthorized = await request(app, '/api/workflows/definitions?channel=C-WA', {});
    assert.equal(unauthorized.status, 401);
  } finally {
    if (previousPolicy === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = previousPolicy;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
