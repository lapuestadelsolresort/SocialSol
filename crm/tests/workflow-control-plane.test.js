'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { authorizationDecision, validatePolicy } = require('../lib/channel-policy');
const { executeGraph, startGraph } = require('../lib/workflow-engine');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const workflowStore = require('../lib/workflow-store');
const {
  beginStep, completeStep, createRun, enqueueOutbox, getRun,
  renewStepLease, resolveManualReview, transitionEffect,
} = workflowStore;
const { claimNext, completeOutbox, drainOutbox } = require('../lib/workflow-outbox');
const { recoverStaleRuns } = require('../scripts/workflow-worker');
const { definition } = require('../workflows/whatsapp-reply');
const { policySnapshot, stepExecutionDecision, submissionDecision } = require('../lib/workflow-execution-policy');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
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

test('workflow schema is additive and includes durable run/effect/outbox state', async () => {
  await withDb(async db => {
    const tables = await db.query(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = new Set(tables.map(row => row.name));
    for (const expected of [
      'workflow_runs', 'workflow_steps', 'workflow_events', 'workflow_effects',
      'workflow_evidence', 'workflow_outbox', 'workflow_manual_reviews',
    ]) {
      assert.equal(names.has(expected), true, expected);
    }
    const runColumns = new Set((await db.query(sql`PRAGMA table_info(workflow_runs)`)).map(row => row.name));
    assert.equal(runColumns.has('input_hash'), true);
    assert.equal(runColumns.has('policy_snapshot_hash'), true);
    assert.equal(runColumns.has('serialization_key'), true);
    const stepColumns = new Set((await db.query(sql`PRAGMA table_info(workflow_steps)`)).map(row => row.name));
    assert.equal(stepColumns.has('lease_token'), true);
    assert.equal(stepColumns.has('lease_version'), true);
    const effectColumns = new Set((await db.query(sql`PRAGMA table_info(workflow_effects)`)).map(row => row.name));
    assert.equal(effectColumns.has('verification_mode'), true);
    assert.equal(effectColumns.has('verification_deadline_at'), true);
    const reviewColumns = new Set((await db.query(sql`PRAGMA table_info(workflow_manual_reviews)`)).map(row => row.name));
    assert.equal(reviewColumns.has('resolution_provider_ref'), true);
    assert.equal(reviewColumns.has('review_channel_id'), true);
    const columns = await db.query(sql`PRAGMA table_info(meta_messages)`);
    const columnNames = new Set(columns.map(row => row.name));
    for (const expected of ['slack_thread_ts', 'delivery_status', 'delivered_at', 'read_at', 'workflow_effect_id']) {
      assert.equal(columnNames.has(expected), true, expected);
    }
  });
});

test('WhatsApp graph is idempotent and distinguishes provider acceptance, delivery, and read', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, slack_thread_ts, direction)
      VALUES ('2026-08-11T12:00:00Z', 'whatsapp', '+14155550100', 'Guest', 'SM-IN', 'Hello', '123.456', 'inbound')`);
    let sends = 0;
    const request = {
      idempotencyKey: 'slack:C-WA:message-1:whatsapp.reply',
      triggerType: 'slack',
      triggerRef: 'message-1',
      channelId: 'C-WA',
      actorUserId: 'U-JASON',
      input: { threadTs: '123.456', message: 'Welcome!', actorName: 'Jason' },
    };
    const services = {
      sendWhatsApp: async ({ toPhone, message }) => {
        sends += 1;
        assert.equal(toPhone, '+14155550100');
        assert.equal(message, 'Welcome!');
        return { sid: 'SM-OUT', status: 'queued', date_created: 'today' };
      },
    };

    const first = await startGraph(db, definition, request, services);
    assert.equal(first.status, 'completed');
    assert.equal(first.output.status, 'queued');
    assert.equal(first.output.deliveryConfirmed, false);
    assert.equal(first.output.readConfirmed, false);
    assert.equal(sends, 1);

    const replay = await startGraph(db, definition, request, services);
    assert.equal(replay.id, first.id);
    assert.equal(sends, 1, 'same Slack event must not send twice');

    const delivered = await transitionEffect(db, {
      provider: 'twilio', providerRef: 'SM-OUT', status: 'delivered', providerStatus: 'delivered',
    });
    assert.equal(delivered.changed, true);
    const stale = await transitionEffect(db, {
      provider: 'twilio', providerRef: 'SM-OUT', status: 'sent', providerStatus: 'sent',
    });
    assert.equal(stale.changed, false, 'out-of-order callback must not regress delivery');
    const read = await transitionEffect(db, {
      provider: 'twilio', providerRef: 'SM-OUT', status: 'read', providerStatus: 'read',
    });
    assert.equal(read.changed, true);
    const finalRun = await getRun(db, first.id);
    assert.equal(finalRun.effects[0].status, 'read');
  });
});

test('channel capabilities allow members by channel and restrict OwnerRez writes by user', () => {
  const policy = {
    version: 1,
    channels: {
      'C-WA': { name: 'whatsapp', capabilities: ['whatsapp.read', 'whatsapp.send'] },
      'C-BI': { name: 'business-intel', capabilities: ['business.read_all'] },
      'C-RES': { name: 'reservations', capabilities: ['ownerrez.read', 'ownerrez.write'] },
    },
    restricted_capabilities: { 'ownerrez.write': { users: ['U-JASON'] } },
    autonomous_workflows: ['paulina.daily'],
  };
  const slack = (channelId, actorUserId) => ({ origin: 'slack', originVerified: true, channelId, actorUserId });
  assert.equal(authorizationDecision({ policy, capability: 'whatsapp.send', workflowName: 'whatsapp.reply', context: slack('C-WA', 'U-SARAH') }).allowed, true);
  assert.equal(authorizationDecision({ policy, capability: 'qbo.write', workflowName: 'qbo.write', context: slack('C-WA', 'U-SARAH') }).allowed, false);
  assert.equal(authorizationDecision({ policy, capability: 'qbo.read', workflowName: 'qbo.query', context: slack('C-BI', 'U-JASON') }).allowed, true);
  assert.equal(authorizationDecision({ policy, capability: 'ownerrez.write', workflowName: 'ownerrez.write', context: slack('C-RES', 'U-SARAH') }).allowed, false);
  assert.equal(authorizationDecision({ policy, capability: 'ownerrez.write', workflowName: 'ownerrez.write', context: slack('C-RES', 'U-JASON') }).allowed, true);
  assert.equal(authorizationDecision({ policy, capability: 'paulina.send', workflowName: 'paulina.daily', context: { origin: 'system' } }).allowed, true);
  assert.equal(validatePolicy(policy), policy);
  assert.throws(() => validatePolicy({
    ...policy, restricted_capabilities: {},
  }), /must restrict ownerrez\.write/);
});

test('central policy enforces command triggers and exact always-on effects', () => {
  const policy = {
    shadow_mode: true,
    live_workflows: ['whatsapp.reply'],
    always_on_effects: ['whatsapp.inbound.process:send_conversion'],
  };
  assert.equal(submissionDecision({
    policy, definition, triggerType: 'model_tool',
  }).reason, 'workflow_trigger_forbidden');
  assert.equal(submissionDecision({
    policy, definition, triggerType: 'slack_whatsapp_command',
  }).allowed, true);

  const inbound = require('../workflows/registry').getDefinition('whatsapp.inbound.process');
  const snapshot = policySnapshot(policy, inbound);
  const conversion = inbound.steps.find(step => step.key === 'send_conversion');
  const crm = inbound.steps.find(step => step.key === 'sync_crm');
  assert.equal(stepExecutionDecision({ policy, definition: inbound, step: conversion, creationSnapshot: snapshot }).allowed, true);
  assert.equal(stepExecutionDecision({ policy, definition: inbound, step: crm, creationSnapshot: snapshot }).allowed, true);
  const killed = { ...policy, always_on_effects: [] };
  const decision = stepExecutionDecision({ policy: killed, definition: inbound, step: conversion, creationSnapshot: snapshot });
  assert.equal(decision.allowed, false);
  assert.equal(decision.skip, true);
});

test('engine suppresses an unapproved autonomous external effect in shadow', async () => {
  await withDb(async db => {
    let externalCalls = 0;
    const mixed = {
      name: 'test.mixed', version: 1, capability: 'crm.write', mutates: true,
      autonomous: true, allowInShadow: true,
      steps: [
        { key: 'local', effectClass: 'local_write', maxAttempts: 1, run: async () => ({ stored: true }) },
        {
          key: 'external', effectClass: 'external_idempotent', maxAttempts: 1,
          run: async () => { externalCalls += 1; return { sent: true }; },
        },
      ],
      output: ({ state }) => state,
    };
    const policy = { shadow_mode: true, live_workflows: [], always_on_effects: [] };
    const run = await startGraph(db, mixed, {
      idempotencyKey: 'mixed-shadow-run', triggerType: 'system', input: {},
      policySnapshot: policySnapshot(policy, mixed),
    }, {
      enforcePolicy: true,
      policyProvider: () => policy,
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.state.local.stored, true);
    assert.equal(run.state.external.skipped, true);
    assert.equal(externalCalls, 0);
  });
});

test('an expired WhatsApp step lease fails for review instead of being replayed', async () => {
  await withDb(async db => {
    const created = await createRun(db, {
      definition,
      idempotencyKey: 'stale-whatsapp-run',
      triggerType: 'slack',
      triggerRef: 'message-1',
      channelId: 'C-WA',
      actorUserId: 'U-JASON',
      input: { dmId: 1, message: 'Do not duplicate this' },
    });
    await beginStep(db, created.run.id, 'send_via_twilio', {}, 'dead-worker', -1000);
    const result = await recoverStaleRuns(db);
    assert.equal(result.manualReview, 1);
    const run = await getRun(db, created.run.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'ambiguous_external_result');
    const sendStep = run.steps.find(step => step.step_key === 'send_via_twilio');
    assert.equal(sendStep.attempts, 1);
  });
});

test('ambiguous Twilio acceptance is never automatically retried and opens review', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, slack_thread_ts, direction)
      VALUES ('2026-08-11T12:00:00Z', 'whatsapp', '+14155550100', 'Guest', 'SM-IN-AMB', 'Hello', '456.789', 'inbound')`);
    let sends = 0;
    const request = {
      idempotencyKey: 'slack:C-WA:ambiguous:whatsapp.reply',
      triggerType: 'slack_whatsapp_command',
      triggerRef: 'ambiguous', channelId: 'C-WA', actorUserId: 'U-JASON',
      input: { threadTs: '456.789', message: 'One message only', actorName: 'Jason' },
    };
    const services = {
      sendWhatsApp: async () => {
        sends += 1;
        const error = new Error('socket closed after request dispatch');
        error.code = 'ambiguous_external_result';
        error.retryable = false;
        throw error;
      },
    };
    const first = await startGraph(db, definition, request, services);
    assert.equal(first.status, 'failed');
    assert.equal(first.error_code, 'ambiguous_external_result');
    assert.equal(first.effects[0].status, 'manual_review');
    assert.equal(first.manualReviews.length, 1);
    assert.equal(first.manualReviews[0].status, 'open');
    assert.equal(sends, 1);
    const replay = await startGraph(db, definition, request, services);
    assert.equal(replay.id, first.id);
    assert.equal(sends, 1);
    await resolveManualReview(db, {
      reviewId: first.manualReviews[0].id,
      resolution: 'confirmed_not_sent',
      resolvedBy: 'U-JASON',
    });
    const resolved = await getRun(db, first.id);
    assert.equal(resolved.manualReviews[0].status, 'resolved');
    assert.equal(resolved.effects[0].status, 'failed');
  });
});

test('post-acceptance projection retries never call Twilio a second time', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, slack_thread_ts, direction)
      VALUES ('2026-08-11T12:00:00Z', 'whatsapp', '+14155550100', 'Guest',
        'SM-IN-PROJECTION', 'Hello', '567.890', 'inbound')`);
    await db.query(sql`CREATE TRIGGER fail_outbound_projection BEFORE INSERT ON meta_messages
      WHEN NEW.direction='outbound' BEGIN SELECT RAISE(FAIL, 'injected projection failure'); END`);
    let sends = 0;
    const services = {
      sendWhatsApp: async () => {
        sends += 1;
        return { sid: 'SM-PROJECTION', status: 'queued' };
      },
    };
    const first = await startGraph(db, definition, {
      idempotencyKey: 'projection-retry-one-send', triggerType: 'slack_whatsapp_command',
      channelId: 'C-WA', actorUserId: 'U-JASON',
      input: { threadTs: '567.890', message: 'Only once', actorName: 'Jason' },
    }, services);
    assert.equal(first.status, 'retry');
    assert.equal(first.effects[0].status, 'queued');
    assert.equal(sends, 1);
    await assert.rejects(() => startGraph(db, definition, {
      idempotencyKey: 'projection-concurrent-send', triggerType: 'slack_whatsapp_command',
      channelId: 'C-WA', actorUserId: 'U-SARAH',
      input: { threadTs: '567.890', message: 'Accidental duplicate', actorName: 'Sarah' },
    }, services), error => error.code === 'workflow_mutation_in_progress');

    await db.query(sql`DROP TRIGGER fail_outbound_projection`);
    await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
      WHERE run_id=${first.id} AND step_key='persist_outbound_projection'`);
    const completed = await executeGraph(db, definition, first.id, services);
    assert.equal(completed.status, 'completed', completed.error_message);
    assert.equal(sends, 1);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM meta_messages
      WHERE platform='whatsapp' AND message_id='SM-PROJECTION'`);
    assert.equal(count, 1);
  });
});

test('persistent post-acceptance projection failure opens review and blocks a human resend', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, slack_thread_ts, direction)
      VALUES ('2026-08-11T12:00:00Z', 'whatsapp', '+14155550100', 'Guest',
        'SM-IN-PERSISTENT', 'Hello', '678.901', 'inbound')`);
    await db.query(sql`CREATE TRIGGER fail_outbound_projection_forever BEFORE INSERT ON meta_messages
      WHEN NEW.direction='outbound' BEGIN SELECT RAISE(FAIL, 'persistent projection failure'); END`);
    let sends = 0;
    const services = {
      sendWhatsApp: async () => { sends += 1; return { sid: 'SM-PERSISTENT', status: 'queued' }; },
    };
    let run = await startGraph(db, definition, {
      idempotencyKey: 'projection-persistent-one-send', triggerType: 'slack_whatsapp_command',
      channelId: 'C-WA', actorUserId: 'U-JASON',
      input: { threadTs: '678.901', message: 'Only once', actorName: 'Jason' },
    }, services);
    for (let attempt = 1; attempt < 4 && run.status === 'retry'; attempt += 1) {
      await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
        WHERE run_id=${run.id} AND step_key='persist_outbound_projection'`);
      run = await executeGraph(db, definition, run.id, services);
    }
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'post_acceptance_persistence_failed');
    assert.equal(run.manualReviews.length, 1);
    assert.equal(run.manualReviews[0].reason_code, 'post_acceptance_persistence_failed');
    assert.equal(run.effects[0].status, 'queued');
    assert.equal(sends, 1);
    await assert.rejects(() => startGraph(db, definition, {
      idempotencyKey: 'projection-persistent-human-retry', triggerType: 'slack_whatsapp_command',
      channelId: 'C-WA', actorUserId: 'U-SARAH',
      input: { threadTs: '678.901', message: 'Only once', actorName: 'Sarah' },
    }, services), error => error.code === 'workflow_manual_review_open');
    assert.equal(sends, 1);
  });
});

test('conflicting manual-review resolutions have exactly one atomic winner', async () => {
  await withDb(async db => {
    const custom = {
      name: 'test.review-race', version: 1, capability: 'test.write', mutates: true,
      steps: [{
        key: 'register', effectClass: 'local_write', maxAttempts: 1,
        async run({ db: connection, run, store, stepKey }) {
          const effect = await store.createEffect(connection, {
            runId: run.id, stepKey, effectType: 'message_delivery', provider: 'test',
            operation: 'send', idempotencyKey: `${run.id}:send`, request: {},
            verificationMode: 'provider_acceptance',
          });
          const error = new Error('ambiguous');
          error.code = 'ambiguous_external_result';
          error.retryable = false;
          error.effectId = effect.id;
          throw error;
        },
      }],
    };
    const run = await startGraph(db, custom, {
      idempotencyKey: 'review-race', triggerType: 'slack', channelId: 'C-WA', input: {},
    });
    const reviewId = run.manualReviews[0].id;
    const results = await Promise.allSettled([
      resolveManualReview(db, {
        reviewId, resolution: 'confirmed_sent', providerRef: 'PROVIDER-1', resolvedBy: 'U-A',
      }),
      resolveManualReview(db, {
        reviewId, resolution: 'confirmed_not_sent', resolvedBy: 'U-B',
      }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejection = results.find(result => result.status === 'rejected');
    assert.equal(rejection.reason.code, 'manual_review_resolution_conflict');
    const final = await getRun(db, run.id);
    const review = final.manualReviews[0];
    const effect = final.effects[0];
    if (review.resolution === 'confirmed_sent') {
      assert.equal(effect.status, 'sent');
      assert.equal(effect.provider_ref, 'PROVIDER-1');
    } else {
      assert.equal(review.resolution, 'confirmed_not_sent');
      assert.equal(effect.status, 'failed');
    }
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_evidence
      WHERE run_id=${run.id} AND source='human.provider_console_review'`);
    assert.equal(count, 1);
  });
});

test('workflow idempotency collision fails closed when the input changes', async () => {
  await withDb(async db => {
    const first = await createRun(db, {
      definition, idempotencyKey: 'collision-key', triggerType: 'slack_whatsapp_command',
      input: { dmId: 1, message: 'first' },
    });
    assert.equal(first.created, true);
    await assert.rejects(() => createRun(db, {
      definition, idempotencyKey: 'collision-key', triggerType: 'slack_whatsapp_command',
      input: { dmId: 1, message: 'different' },
    }), error => error.code === 'idempotency_collision');
  });
});

test('a queued run cannot execute under a different registry workflow version', async () => {
  await withDb(async db => {
    const versionOne = {
      name: 'test.versioned', version: 1, capability: 'test.read', mutates: false,
      steps: [{ key: 'read', effectClass: 'read', run: async () => ({ version: 1 }) }],
    };
    const created = await createRun(db, {
      definition: versionOne, idempotencyKey: 'version-mismatch', triggerType: 'system', input: {},
    });
    const versionTwo = { ...versionOne, version: 2 };
    const failed = await executeGraph(db, versionTwo, created.run.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'workflow_version_mismatch');
    assert.equal(failed.steps[0].status, 'failed');
  });
});

test('a stale lease holder is fenced out after another worker acquires the step', async () => {
  await withDb(async db => {
    const inbound = require('../workflows/registry').getDefinition('whatsapp.inbound.process');
    const created = await createRun(db, {
      definition: inbound, idempotencyKey: 'lease-fence-run', triggerType: 'system', input: { messageId: 1 },
    });
    const first = await beginStep(db, created.run.id, 'load_message', {}, 'worker-one', -1_000);
    const recovery = await recoverStaleRuns(db);
    assert.equal(recovery.retried, 1);
    const second = await beginStep(db, created.run.id, 'load_message', {}, 'worker-two', 60_000);
    assert.ok(second.leaseToken);
    await assert.rejects(
      () => completeStep(db, created.run.id, 'load_message', { worker: 1 }, { load_message: { worker: 1 } }, { leaseToken: first.leaseToken }),
      error => error.code === 'workflow_lease_lost',
    );
    await completeStep(
      db, created.run.id, 'load_message', { worker: 2 }, { load_message: { worker: 2 } },
      { leaseToken: second.leaseToken },
    );
    const run = await getRun(db, created.run.id);
    assert.equal(run.steps[0].status, 'completed');
    assert.equal(run.state.load_message.worker, 2);
  });
});

test('stale recovery loses a renewal race without creating a spurious review or crashing', async () => {
  await withDb(async db => {
    const created = await createRun(db, {
      definition, idempotencyKey: 'recovery-renewal-race', triggerType: 'slack_whatsapp_command',
      channelId: 'C-WA', input: { dmId: 1, message: 'still in flight' },
    });
    const lease = await beginStep(db, created.run.id, 'send_via_twilio', {}, 'live-worker', -1_000);
    const original = workflowStore.failExpiredStepForManualReview;
    workflowStore.failExpiredStepForManualReview = async (connection, args) => {
      await renewStepLease(connection, args.runId, args.stepKey, args.leaseToken, 60_000);
      return original(connection, args);
    };
    try {
      const recovery = await recoverStaleRuns(db);
      assert.equal(recovery.raced, 1);
      assert.equal(recovery.manualReview, 0);
      const run = await getRun(db, created.run.id);
      assert.equal(run.status, 'running');
      assert.equal(run.manualReviews.length, 0);
      assert.equal(run.steps.find(step => step.step_key === 'send_via_twilio').lease_token, lease.leaseToken);
    } finally {
      workflowStore.failExpiredStepForManualReview = original;
    }
  });
});

test('outbox dead-lettering and expired-lease fencing are durable', async () => {
  await withDb(async db => {
    await enqueueOutbox(db, {
      topic: 'slack.notification', idempotencyKey: 'outbox-dead-test',
      payload: { channelId: 'C-OPS', message: 'alert' }, maxAttempts: 1,
    });
    const drained = await drainOutbox(db, {
      workerId: 'worker-one',
      services: { postToChannel: async () => ({ ok: false, error: 'Slack unavailable' }) },
    });
    assert.deepEqual(drained, { claimed: 1, completed: 0, failed: 1 });
    const [dead] = await db.query(sql`SELECT status FROM workflow_outbox WHERE idempotency_key='outbox-dead-test'`);
    assert.equal(dead.status, 'dead');

    await enqueueOutbox(db, {
      topic: 'slack.notification', idempotencyKey: 'outbox-fence-test',
      payload: { channelId: 'C-OPS', message: 'fenced' },
    });
    const first = await claimNext(db, { workerId: 'worker-old', leaseSeconds: -1 });
    const second = await claimNext(db, { workerId: 'worker-new', leaseSeconds: 60 });
    assert.equal(first.id, second.id);
    await assert.rejects(() => completeOutbox(db, first), error => error.code === 'outbox_lease_lost');
    await completeOutbox(db, second);
    const [completed] = await db.query(sql`SELECT status FROM workflow_outbox WHERE id=${second.id}`);
    assert.equal(completed.status, 'completed');

    await enqueueOutbox(db, {
      topic: 'slack.notification', idempotencyKey: 'outbox-drain-race-test',
      payload: { channelId: 'C-OPS', message: 'race' },
    });
    const raced = await drainOutbox(db, {
      workerId: 'worker-stale',
      services: {
        postToChannel: async () => {
          await db.query(sql`UPDATE workflow_outbox SET lease_token='new-owner-token', lease_owner='worker-new'
            WHERE idempotency_key='outbox-drain-race-test'`);
          return { ok: false, error: 'stale delivery result' };
        },
      },
    });
    assert.deepEqual(raced, { claimed: 1, completed: 0, failed: 0 });
  });
});
