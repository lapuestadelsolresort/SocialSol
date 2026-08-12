'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { executeGraph, startGraph } = require('../lib/workflow-engine');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { tokenMatches } = require('../routes/workflows');
const { getDefinition, listDefinitions } = require('../workflows/registry');
const { runVerifiedCommand } = require('../workflows/paulina-prepare');
const { matchingPost } = require('../workflows/social-publish');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-domains-'));
  const db = createDB(path.join(directory, 'crm.db'));
  const priorPolicyPath = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: false,
    live_workflows: [],
    autonomous_workflows: [],
    always_on_effects: [],
    channels: {
      'RECEIPT-A': { name: 'receipt-a', capabilities: ['receipts.write'] },
      'RECEIPT-B': { name: 'receipt-b', capabilities: ['receipts.write'] },
      'PAULINA': { name: 'prospector-paulina', capabilities: ['paulina.send'] },
    },
    restricted_capabilities: {},
    write_notifications: { user_ids: [], channel_ids: [] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
      platform TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT,
      message_id TEXT UNIQUE, message_text TEXT, raw_payload TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    if (priorPolicyPath === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = priorPolicyPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('registry exposes fixed domain graphs instead of arbitrary command execution', () => {
  const definitions = new Map(listDefinitions().map(item => [item.name, item]));
  for (const expected of [
    'whatsapp.reply', 'whatsapp.inbound.process', 'meta.dm.reply', 'receipt.ingest', 'receipt.annotate', 'receipt.reconcile',
    'social.content.upsert', 'social.content.publish', 'social.publish_routine',
    'paulina.daily', 'paulina.prepare_daily', 'paulina.performance.read', 'regina.daily', 'regina.campaign',
    'guest.reply.draft', 'crm.sync', 'crm.pipeline.read',
    'ownerrez.occupancy.read', 'squarespace.summary.read',
    'ownerrez.mutation.propose', 'ownerrez.mutation.confirm',
    'qbo.write', 'qbo.bank_balances.read', 'qbo.report.read', 'business.snapshot.read',
  ]) assert.equal(definitions.has(expected), true, expected);
  assert.equal(definitions.get('business.snapshot.read').mutates, false);
  assert.equal(definitions.get('qbo.write').autonomous, true);
  assert.equal(definitions.has('shell.exec'), false);
});

test('durable shell jobs retry only before dispatch and require review after dispatch', async () => {
  const execute = getDefinition('squarespace.crm.sync').steps
    .find(step => step.key === 'execute');
  assert.equal(execute.maxAttempts, 2);
  let commandCalls = 0;
  const base = {
    run: { id: '11111111-1111-4111-8111-111111111111' },
    input: {},
    state: { register_effect: { effectId: 'effect-1' } },
    stepKey: 'execute',
    services: {
      shadowMode: false,
      runCommand: async () => {
        commandCalls += 1;
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    },
  };

  await assert.rejects(() => execute.run({
    ...base,
    db: { query: async () => { throw new Error('SQLITE_BUSY: database is locked'); } },
    store: {},
  }), error => (
    error.code === 'pre_dispatch_state_unavailable'
    && error.retryable === true
    && error.requiresManualReview !== true
  ));
  assert.equal(commandCalls, 0);

  await assert.rejects(() => execute.run({
    ...base,
    db: { query: async () => [{ id: 'effect-1', status: 'requested', provider_ref: null }] },
    store: {
      sha256: () => 'hash',
      transitionEffect: async () => { throw new Error('SQLITE_BUSY: database is locked'); },
    },
  }), error => (
    error.code === 'post_dispatch_projection_failed'
    && error.retryable === false
    && error.requiresManualReview === true
  ));
  assert.equal(commandCalls, 1);
});

test('inbound WhatsApp CRM enrichment is resumable and idempotent', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, source TEXT,
      campaign_name TEXT, status TEXT, inquiry_message TEXT, notes TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT
    )`);
    await db.query(sql`CREATE TABLE page_sessions (
      id TEXT PRIMARY KEY, whatsapp_ref TEXT, page_slug TEXT, utm_source TEXT,
      utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, lead_id INTEGER,
      converted INTEGER DEFAULT 0, last_seen TEXT
    )`);
    await db.query(sql`CREATE TABLE attribution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, lead_id INTEGER,
      event_type TEXT, channel TEXT, campaign TEXT, utm_source TEXT,
      utm_medium TEXT, utm_campaign TEXT, meta TEXT
    )`);
    await db.query(sql`INSERT INTO meta_messages (
      received_at, platform, sender_id, sender_name, message_id, message_text,
      raw_payload, direction, delivery_status, processing_status
    ) VALUES (
      '2026-08-11T17:00:00.000Z', 'whatsapp', '+14155550123', 'Test Guest',
      'SM-DURABLE-INBOUND', 'Do you have availability?', '{}', 'inbound', 'delivered', 'queued'
    )`);
    const [message] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='SM-DURABLE-INBOUND'`);
    const request = {
      idempotencyKey: 'whatsapp:inbound:SM-DURABLE-INBOUND:process',
      triggerType: 'system', triggerRef: `whatsapp-message:${message.id}`,
      input: { messageId: message.id },
    };
    const first = await startGraph(db, getDefinition('whatsapp.inbound.process'), request);
    const replay = await startGraph(db, getDefinition('whatsapp.inbound.process'), request);
    assert.equal(first.status, 'completed', first.error_message);
    assert.equal(replay.id, first.id);
    assert.ok(first.output.leadId);
    const [processed] = await db.query(sql`SELECT processing_status, crm_lead_id, lead_created
      FROM meta_messages WHERE id=${message.id}`);
    assert.equal(processed.processing_status, 'completed');
    assert.equal(processed.crm_lead_id, first.output.leadId);
    assert.equal(processed.lead_created, 1);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM leads WHERE phone='+14155550123'`);
    assert.equal(count, 1);
  });
});

test('Meta DM replies use a command-only durable effect and never claim delivery', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, raw_payload, direction)
      VALUES ('2026-08-11T17:00:00Z', 'instagram', 'IG-RECIPIENT', 'Guest', 'MID-IN', 'Hello', '{}', 'inbound')`);
    const [message] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='MID-IN'`);
    let sends = 0;
    const request = {
      idempotencyKey: 'slack:C-SOCIAL:meta-reply', triggerType: 'slack_meta_dm_command',
      channelId: 'C-SOCIAL', actorUserId: 'U-JASON',
      input: { dmId: message.id, message: 'Welcome', actorName: 'Jason' },
    };
    const services = {
      sendMetaDm: async () => { sends += 1; return { message_id: 'MID-OUT' }; },
    };
    const first = await startGraph(db, getDefinition('meta.dm.reply'), request, services);
    const replay = await startGraph(db, getDefinition('meta.dm.reply'), request, services);
    assert.equal(first.status, 'completed');
    assert.equal(first.output.status, 'accepted_by_provider');
    assert.equal(first.output.deliveryConfirmed, undefined);
    assert.equal(replay.id, first.id);
    assert.equal(sends, 1);
  });
});

test('Meta acceptance survives a local projection failure without a second provider send', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO meta_messages
      (received_at, platform, sender_id, sender_name, message_id, message_text, raw_payload, direction)
      VALUES ('2026-08-11T17:00:00Z', 'instagram', 'IG-PROJECTION', 'Guest',
        'MID-IN-PROJECTION', 'Hello', '{}', 'inbound')`);
    const [message] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id='MID-IN-PROJECTION'`);
    await db.query(sql`CREATE TRIGGER fail_meta_projection BEFORE INSERT ON meta_messages
      WHEN NEW.direction='outbound' BEGIN SELECT RAISE(FAIL, 'injected projection failure'); END`);
    let sends = 0;
    const definition = getDefinition('meta.dm.reply');
    const services = {
      sendMetaDm: async () => { sends += 1; return { message_id: 'MID-OUT-PROJECTION' }; },
    };
    const first = await startGraph(db, definition, {
      idempotencyKey: 'meta-projection-one-send', triggerType: 'slack_meta_dm_command',
      channelId: 'C-SOCIAL', actorUserId: 'U-JASON',
      input: { dmId: message.id, message: 'One Meta message', actorName: 'Jason' },
    }, services);
    assert.equal(first.status, 'retry');
    assert.equal(first.effects[0].status, 'accepted_by_provider');
    assert.equal(first.effects[0].verification_mode, 'provider_acceptance');
    assert.equal(sends, 1);
    await db.query(sql`DROP TRIGGER fail_meta_projection`);
    await db.query(sql`UPDATE workflow_steps SET available_at='1970-01-01T00:00:00.000Z'
      WHERE run_id=${first.id} AND step_key='persist_outbound_projection'`);
    const completed = await executeGraph(db, definition, first.id, services);
    assert.equal(completed.status, 'completed', completed.error_message);
    assert.equal(sends, 1);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM meta_messages
      WHERE message_id='MID-OUT-PROJECTION'`);
    assert.equal(count, 1);
  });
});

test('receipt ingestion is idempotent, hash-verified, and channel-scoped', async () => {
  await withDb(async db => {
    const definition = getDefinition('receipt.ingest');
    const request = {
      idempotencyKey: 'slack:RECEIPT-A:171.2:receipt.ingest',
      triggerType: 'slack', triggerRef: '171.2', channelId: 'RECEIPT-A', actorUserId: 'TEST-WORKER',
      input: { slackMessageId: '171.2', messageText: 'Materials 1250 MXN', fileRefs: [{ id: 'F1', name: 'receipt.jpg' }] },
    };
    const first = await startGraph(db, definition, request);
    const replay = await startGraph(db, definition, request);
    assert.equal(first.id, replay.id);
    assert.equal(first.output.status, 'verified_by_readback');
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM accounting_receipts`);
    assert.equal(count, 1);

    const annotate = getDefinition('receipt.annotate');
    const annotated = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-A:171.3:receipt.annotate',
      triggerType: 'slack', channelId: 'RECEIPT-A', actorUserId: 'TEST-WORKER',
      input: { receiptId: first.output.receiptId, amount: 1250, currency: 'MXN', transactionDate: '2026-08-10', vendor: 'Hardware' },
    });
    assert.equal(annotated.status, 'completed', annotated.error_message);
    assert.equal(annotated.output.receiptStatus, 'extracted');

    const denied = await startGraph(db, annotate, {
      idempotencyKey: 'slack:RECEIPT-B:171.4:receipt.annotate',
      triggerType: 'slack', channelId: 'RECEIPT-B', actorUserId: 'TEST-OTHER',
      input: { receiptId: first.output.receiptId, amount: 1, currency: 'MXN' },
    });
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error_code, 'receipt_scope_violation');
  });
});

test('business snapshot names authorities and refuses to imply unqueried occupancy or cash', async () => {
  await withDb(async db => {
    const run = await startGraph(db, getDefinition('business.snapshot.read'), {
      idempotencyKey: 'snapshot-1', triggerType: 'slack', channelId: 'BI-CHANNEL', actorUserId: 'TEST-OWNER', input: {},
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.output.authorityContract.occupancyAvailability.authority, 'OwnerRez');
    assert.equal(run.output.authorityContract.occupancyAvailability.queried, false);
    assert.equal(run.output.authorityContract.bankCash.queried, false);
    assert.ok(run.output._evidence.payloadHash);
  });
});

test('channel-owned social content can be approved and the due dispatcher no-ops safely', async () => {
  await withDb(async db => {
    const scheduledFor = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const content = await startGraph(db, getDefinition('social.content.upsert'), {
      idempotencyKey: 'social-content-approved-1',
      triggerType: 'slack', channelId: 'SOCIAL-CHANNEL', actorUserId: 'TEST-EDITOR',
      input: { caption: 'Approved future content', status: 'approved', scheduledFor, mediaRefs: [] },
    });
    assert.equal(content.status, 'completed');
    assert.equal(content.output.contentStatus, 'approved');

    const due = await startGraph(db, getDefinition('social.publish_due'), {
      idempotencyKey: 'social-due-empty-window-1',
      triggerType: 'system', input: {},
    });
    assert.equal(due.status, 'completed');
    assert.equal(due.output.scheduled, 0);
    assert.ok(due.output.evidenceId);
  });
});

test('Postiz preflight recovery matches exact provider id or caption/date, not caption alone', () => {
  const posts = [
    { id: 'p1', content: 'Sunset view', publishDate: '2026-08-12T17:00:00.000Z' },
    { id: 'p2', content: 'Sunset view', publishDate: '2026-08-15T17:00:00.000Z' },
  ];
  assert.equal(matchingPost(posts, { id: 'p2', caption: 'different', scheduledFor: '2026-08-12T17:00:00.000Z' }).id, 'p2');
  assert.equal(matchingPost(posts, { caption: 'Sunset   view', scheduledFor: '2026-08-12T17:00:30.000Z' }).id, 'p1');
  assert.equal(matchingPost(posts, { caption: 'Sunset view', scheduledFor: '2026-08-13T17:00:00.000Z' }), null);
});

test('Postiz ambiguity and readback lag never create a second post', async () => {
  await withDb(async db => {
    const contentId = '11111111-1111-4111-8111-111111111111';
    await db.query(sql`INSERT INTO social_content
      (id, status, caption, media_refs_json, scheduled_for, created_by, updated_by)
      VALUES (${contentId}, 'approved', 'One post only',
        ${JSON.stringify([{ id: 'media-1', path: 'https://example.test/media.jpg' }])},
        '2026-08-20T17:00:00.000Z', 'U-JASON', 'U-JASON')`);
    let creates = 0;
    const services = {
      listPostizPosts: async () => [],
      createPostizPost: async () => {
        creates += 1;
        const error = new Error('provider accepted but connection closed');
        error.code = 'ambiguous_external_result';
        error.retryable = false;
        throw error;
      },
    };
    const definition = getDefinition('social.content.publish');
    const first = await startGraph(db, definition, {
      idempotencyKey: 'social-ambiguous-first', triggerType: 'model_tool',
      input: { contentId, scheduledFor: '2026-08-20T17:00:00.000Z' },
    }, services);
    assert.equal(first.status, 'failed');
    assert.equal(first.manualReviews[0].status, 'open');
    assert.equal(creates, 1);

    await assert.rejects(() => startGraph(db, definition, {
      idempotencyKey: 'social-ambiguous-second', triggerType: 'model_tool',
      input: { contentId, scheduledFor: '2026-08-20T17:00:00.000Z' },
    }, services), error => error.code === 'workflow_manual_review_open');
    assert.equal(creates, 1);
  });
});

test('a definitive Postiz rejection restores approved content for a corrected retry', async () => {
  await withDb(async db => {
    const contentId = '22222222-2222-4222-8222-222222222222';
    await db.query(sql`INSERT INTO social_content
      (id, status, caption, media_refs_json, scheduled_for, created_by, updated_by)
      VALUES (${contentId}, 'approved', 'Correctable post',
        ${JSON.stringify([{ id: 'media-2', path: 'https://example.test/media.jpg' }])},
        '2026-08-21T17:00:00.000Z', 'U-JASON', 'U-JASON')`);
    const error = new Error('Postiz rejected the request');
    error.code = 'postiz_api_error';
    error.status = 400;
    error.retryable = false;
    const run = await startGraph(db, getDefinition('social.content.publish'), {
      idempotencyKey: 'social-definitive-rejection', triggerType: 'model_tool',
      input: { contentId, scheduledFor: '2026-08-21T17:00:00.000Z' },
    }, {
      listPostizPosts: async () => [],
      createPostizPost: async () => { throw error; },
    });
    assert.equal(run.status, 'failed');
    assert.equal(run.manualReviews.length, 0);
    assert.equal(run.effects[0].status, 'failed');
    const [content] = await db.query(sql`SELECT status, workflow_run_id FROM social_content WHERE id=${contentId}`);
    assert.equal(content.status, 'approved');
    assert.equal(content.workflow_run_id, null);
  });
});

test('Paulina verification counts only rows attributed to its workflow run', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.daily'), {
      idempotencyKey: 'paulina-attribution-test', triggerType: 'system', input: {},
    }, {
      runCommand: async command => {
        commandCalls += 1;
        if (commandCalls === 1) {
          assert.match(command.env.WORKFLOW_RUN_ID, /^[0-9a-f-]{36}$/);
          await db.query(sql`INSERT INTO outreach_sends (status, sent_at, workflow_run_id)
            VALUES ('sent','2026-08-11T18:00:00Z',${command.env.WORKFLOW_RUN_ID}),
                   ('sent','2026-08-11T18:00:00Z','another-run')`);
          return {
            exitCode: 0,
            stdout: '[orchestrator] exit ok: {"processed":1,"sent":1,"failed":0,"ambiguous":0}\n',
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            generated_at: '2026-08-11T18:01:00Z',
            scope: { owner: 'paulina', active_campaign_slug: 'planner' },
            active_queue: { verified_ready: 2 },
          }),
          stderr: '',
        };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.sent, 1);
    assert.equal(run.state.verify_readback.evidence.attributedRows.sent, 1);
    const [evidence] = await db.query(sql`SELECT payload_json FROM workflow_evidence
      WHERE run_id=${run.id} AND source='crm.outreach_sends'`);
    assert.equal(JSON.parse(evidence.payload_json).attributedRows.sent, 1);
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    assert.match(JSON.parse(notification.payload_json).message,
      /processed 1, sent 1, failed 0, verified queue ready 2/);
  });
});

test('Paulina verified no-op runs do not post misleading Resend write notifications', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.daily'), {
      idempotencyKey: 'paulina-noop-notification-test', triggerType: 'system', input: {},
    }, {
      runCommand: async () => {
        commandCalls += 1;
        if (commandCalls === 1) {
          return {
            exitCode: 0,
            stdout: '[orchestrator] exit ok: {"processed":0,"sent":0,"failed":0,"ambiguous":0}\n',
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            generated_at: '2026-08-12T14:30:00Z',
            scope: { owner: 'paulina', active_campaign_slug: 'planner' },
            active_queue: { verified_ready: 11 },
          }),
          stderr: '',
        };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.sent, 0);
    assert.equal(run.state.notify_humans.queued, 0);
    assert.equal(run.state.notify_humans.reason, 'verified no-op notification suppressed');
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    assert.equal(count, 0);
  });
});

test('Paulina preparation is a run-scoped graph with verified stage effects', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY, slug TEXT, status TEXT, persona TEXT
    )`);
    await db.query(sql`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, email TEXT, email_status TEXT, do_not_contact INTEGER,
      status TEXT, source_query TEXT
    )`);
    await db.query(sql`CREATE TABLE campaign_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, contact_id INTEGER,
      attached_by TEXT, attached_at TEXT DEFAULT (datetime('now')),
      UNIQUE(campaign_id, contact_id)
    )`);
    await db.query(sql`CREATE TABLE suppressions (email TEXT)`);
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER,
      workflow_run_id TEXT, status TEXT, sent_at TEXT
    )`);
    await db.query(sql`INSERT INTO outreach_campaigns (id, slug, status, persona)
      VALUES (7, 'planner_partner_program_v1', 'active', 'wedding_planner')`);
    await db.query(sql`INSERT INTO contacts
      (id, email, email_status, do_not_contact, status, source_query)
      VALUES (1, 'one@example.test', 'verified', 0, 'new', 'run_wedding_planner'),
             (2, 'two@example.test', 'verified', 0, 'new', 'run_wedding_planner')`);

    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.prepare_daily'), {
      idempotencyKey: 'paulina-prepare-2026-08-12', triggerType: 'system', input: {},
    }, {
      now: '2026-08-12T15:30:00.000Z',
      paulinaConfig: {
        reporting: { active_campaign_slug: 'planner_partner_program_v1' },
        email_verification: { queue_buffer_days: 2, max_per_daily_run: 25 },
      },
      paulinaState: { paused: false },
      runCommand: async command => {
        commandCalls += 1;
        const script = path.basename(command.args[0]);
        if (script === 'engagement-analysis.js') {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true,
            recent: { window_days: 14, production_sent: 4, external_replies: 1 },
          }) };
        }
        if (script === 'daily-capacity.js') {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, batch_size: 2, daily_target: 10, weekly_cap: 50, campaign_week: 1,
          }) };
        }
        if (script === 'run-research.js') {
          assert.equal(command.env.PAULINA_WORKFLOW_NO_SLACK, '1');
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, status: 'completed', inserted: 2, import_errors: 0,
          }) };
        }
        if (script === 'preverify-queue.js') {
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, checked: 0, verified_available_before: 2,
            verified_available_after: 2, target_met: false,
          }) };
        }
        if (script === 'composer.js') {
          assert.match(command.env.WORKFLOW_RUN_ID, /^[0-9a-f-]{36}$/);
          await db.query(sql`INSERT INTO outreach_sends
            (campaign_id, workflow_run_id, status)
            VALUES (7, ${command.env.WORKFLOW_RUN_ID}, 'pending_approval'),
                   (7, ${command.env.WORKFLOW_RUN_ID}, 'pending_approval')`);
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({
            ok: true, already_composed: 0,
            composed: [{ draft_id: 1 }, { draft_id: 2 }], failed: [],
          }) };
        }
        throw new Error(`unexpected command ${script}`);
      },
    });

    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(commandCalls, 5);
    assert.equal(run.output.batchSize, 2);
    assert.equal(run.output.attached, 2);
    assert.equal(run.output.composition.attributed_drafts, 2);
    const effects = await db.query(sql`SELECT status FROM workflow_effects
      WHERE run_id=${run.id} ORDER BY requested_at, id`);
    assert.equal(effects.length, 4);
    assert.deepEqual(new Set(effects.map(effect => effect.status)), new Set(['verified_by_readback']));
    const [notification] = await db.query(sql`SELECT payload_json FROM workflow_outbox
      WHERE run_id=${run.id} AND topic='slack.notification'`);
    assert.match(JSON.parse(notification.payload_json).message, /composed 2 new drafts/);
  });
});

test('Paulina preparation records a weekend no-op without external effects', async () => {
  await withDb(async db => {
    let commandCalls = 0;
    const run = await startGraph(db, getDefinition('paulina.prepare_daily'), {
      idempotencyKey: 'paulina-prepare-weekend', triggerType: 'system', input: {},
    }, {
      now: '2026-08-16T15:30:00.000Z',
      paulinaConfig: { reporting: { active_campaign_slug: 'planner_partner_program_v1' } },
      paulinaState: { paused: false },
      runCommand: async () => { commandCalls += 1; throw new Error('must not run'); },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.status, 'skipped');
    assert.equal(run.output.reason, 'weekend');
    assert.equal(commandCalls, 0);
    assert.equal(run.effects.length, 0);
    const [{ count }] = await db.query(sql`SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE run_id=${run.id}`);
    assert.equal(count, 0);
  });
});

test('Paulina preparation distinguishes safe pre-dispatch retry from post-command review', async () => {
  const base = {
    db: {},
    run: { id: '11111111-1111-4111-8111-111111111111' },
    state: { preflight: { campaignSlug: 'planner' } },
    stepKey: 'research',
    services: { runCommand: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }) },
  };
  const options = {
    provider: 'research', operation: 'test', request: {}, command: {},
    readback: async () => ({ ok: true }),
  };
  await assert.rejects(() => runVerifiedCommand({
    ...base,
    store: { createEffect: async () => { throw new Error('database locked'); } },
  }, options), error => error.retryable === true && error.requiresManualReview !== true);

  await assert.rejects(() => runVerifiedCommand({
    ...base,
    store: {
      createEffect: async () => ({ id: 'effect-1', status: 'requested' }),
      transitionEffect: async () => { throw new Error('projection failed'); },
    },
  }, options), error => error.retryable === false && error.requiresManualReview === true);
});

test('Regina verification excludes concurrent outreach rows from another producer', async () => {
  await withDb(async db => {
    await db.query(sql`CREATE TABLE outreach_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, sent_at TEXT, workflow_run_id TEXT
    )`);
    const run = await startGraph(db, getDefinition('regina.daily'), {
      idempotencyKey: 'regina-attribution-test', triggerType: 'system', input: {},
    }, {
      runCommand: async command => {
        assert.match(command.env.WORKFLOW_RUN_ID, /^[0-9a-f-]{36}$/);
        await db.query(sql`INSERT INTO outreach_sends (status, sent_at, workflow_run_id)
          VALUES ('sent','2026-08-11T18:00:00Z',${command.env.WORKFLOW_RUN_ID}),
                 ('sent','2026-08-11T18:00:00Z','legacy-producer')`);
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });
    assert.equal(run.status, 'completed', run.error_message);
    assert.equal(run.output.report.created, 1);
    assert.equal(run.output.report.sent, 1);
  });
});

test('workflow control token is length-checked and compared exactly', () => {
  const token = 'a'.repeat(32);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, 'a'.repeat(31)), false);
  assert.equal(tokenMatches('short', 'short'), false);
});
