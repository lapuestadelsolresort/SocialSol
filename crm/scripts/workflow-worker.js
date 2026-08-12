#!/usr/bin/env node
'use strict';

const os = require('node:os');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { DB_PATH } = require('../../lib/runtime-paths');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { executeGraph } = require('../lib/workflow-engine');
const workflowStore = require('../lib/workflow-store');
const { createRun } = workflowStore;
const { drainOutbox } = require('../lib/workflow-outbox');
const { sendWhatsApp } = require('../lib/twilio-whatsapp');
const { sendMetaDm } = require('../lib/meta-dm');
const { requestOwnerRez } = require('../lib/ownerrez-api');
const { runCommand } = require('../lib/workflow-command');
const { authorize, loadPolicy } = require('../lib/channel-policy');
const { effectClass, policySnapshot, reviewChannelId } = require('../lib/workflow-execution-policy');
const { getDefinition } = require('../workflows/registry');

const once = process.argv.includes('--once');
const intervalMs = Math.max(500, Number(process.env.WORKFLOW_POLL_INTERVAL_MS || 2000));
const workerId = `${os.hostname()}:${process.pid}`;
let stopping = false;
let running = false;

function executionServices() {
  return {
    workerId,
    enforcePolicy: true,
    policyProvider: () => loadPolicy({ fresh: true }),
    sendWhatsApp: params => sendWhatsApp(params),
    sendMetaDm: params => sendMetaDm(params),
    ownerRezRequest: params => requestOwnerRez(params),
    runCommand,
  };
}

function authorizeSystemRun(definition) {
  const policy = loadPolicy({ fresh: true });
  authorize({
    capability: definition.capability,
    workflowName: definition.name,
    context: { origin: 'system' },
    policy,
  });
  return { policy, snapshot: policySnapshot(policy, definition) };
}

async function resumeDueRuns(db) {
  const now = new Date().toISOString();
  const rows = await db.query(sql`SELECT DISTINCT r.id, r.workflow_name
    FROM workflow_runs r
    JOIN workflow_steps s ON s.run_id=r.id
    WHERE r.status='retry' AND s.status='retry' AND s.available_at <= ${now}
    ORDER BY r.updated_at LIMIT 25`);
  let resumed = 0;
  let unsupported = 0;
  let failed = 0;
  for (const row of rows) {
    const definition = getDefinition(row.workflow_name);
    if (!definition) {
      unsupported += 1;
      continue;
    }
    try {
      await executeGraph(db, definition, row.id, executionServices());
      resumed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[workflow-worker] resume retry ${row.id} failed: ${error.message}`);
    }
  }
  return { candidates: rows.length, resumed, unsupported, failed };
}

async function queueOwnerRezEvents(db) {
  const rows = await db.query(sql`SELECT id, payload_hash FROM ownerrez_events
    WHERE processing_status='pending' AND processed=0
    ORDER BY received_at, id LIMIT 25`);
  if (!rows.length) return { candidates: 0, queued: 0 };
  const definition = getDefinition('ownerrez.webhook.process');
  if (!definition) return { candidates: rows.length, queued: 0, unsupported: rows.length };
  const { snapshot } = authorizeSystemRun(definition);
  let queued = 0;
  for (const row of rows) {
    const created = await createRun(db, {
      definition,
      idempotencyKey: `ownerrez:webhook:${row.id}:${row.payload_hash || 'unhashed'}`,
      triggerType: 'system',
      triggerRef: `ownerrez-event:${row.id}`,
      input: { eventId: row.id },
      policySnapshot: snapshot,
    });
    await db.query(sql`UPDATE ownerrez_events SET processing_status='queued',
      workflow_run_id=${created.run.id} WHERE id=${row.id} AND processing_status='pending'`);
    queued += 1;
  }
  return { candidates: rows.length, queued };
}

async function queueWhatsAppInbound(db) {
  const rows = await db.query(sql`SELECT id, message_id FROM meta_messages
    WHERE platform='whatsapp' AND direction='inbound' AND processing_status='pending'
    ORDER BY received_at, id LIMIT 25`);
  if (!rows.length) return { candidates: 0, queued: 0 };
  const definition = getDefinition('whatsapp.inbound.process');
  if (!definition) return { candidates: rows.length, queued: 0, unsupported: rows.length };
  const { snapshot } = authorizeSystemRun(definition);
  let queued = 0;
  for (const row of rows) {
    const created = await createRun(db, {
      definition,
      idempotencyKey: `whatsapp:inbound:${row.message_id || row.id}:process`,
      triggerType: 'system',
      triggerRef: `whatsapp-message:${row.id}`,
      input: { messageId: row.id },
      policySnapshot: snapshot,
    });
    await db.query(sql`UPDATE meta_messages SET processing_status='queued',
      workflow_run_id=${created.run.id}, processing_error=NULL
      WHERE id=${row.id} AND processing_status='pending'`);
    queued += 1;
  }
  return { candidates: rows.length, queued };
}

async function recoverStaleRuns(db) {
  const now = new Date().toISOString();
  const rows = await db.query(sql`SELECT r.id, r.workflow_name, r.channel_id,
      s.step_key, s.lease_token
    FROM workflow_runs r
    JOIN workflow_steps s ON s.run_id=r.id
    WHERE r.status='running' AND s.status='running'
      AND s.lease_expires_at IS NOT NULL AND s.lease_expires_at < ${now}
    ORDER BY r.updated_at LIMIT 25`);
  const summary = { candidates: rows.length, retried: 0, manualReview: 0, raced: 0, unsupported: 0, failed: 0 };
  for (const row of rows) {
    const definition = getDefinition(row.workflow_name);
    if (!definition) {
      summary.unsupported += 1;
      continue;
    }
    const step = definition.steps.find(candidate => candidate.key === row.step_key);
    if (!step) {
      summary.unsupported += 1;
      continue;
    }
    const manualBoundary = ['external_non_idempotent', 'guest_message'].includes(effectClass(definition, step));
    try {
      if (manualBoundary) {
        const policy = row.channel_id ? {} : loadPolicy({ fresh: true });
        const channelId = reviewChannelId(policy, definition, row);
        const message = 'worker lease expired across a non-idempotent external-effect boundary; inspect provider state before retrying';
        const review = await workflowStore.failExpiredStepForManualReview(db, {
          runId: row.id,
          stepKey: row.step_key,
          leaseToken: row.lease_token,
          expiredBefore: now,
          reasonMessage: message,
          reviewChannelId: channelId,
        });
        if (channelId) {
          await workflowStore.enqueueOutbox(db, {
            runId: row.id,
            topic: 'slack.notification',
            idempotencyKey: `${row.id}:manual-review:${row.step_key}:slack`,
            payload: {
              channelId,
              message: `⚠️ Workflow ${row.id} stopped after an expired non-idempotent step lease. Do not repeat the mutation until review ${review.id} is resolved. After checking the provider console, use \`!review resolve ${review.id} sent <provider-id>\`, \`!review resolve ${review.id} not-sent\`, or \`!review resolve ${review.id} abandon\`.`,
            },
          });
        }
        summary.manualReview += 1;
      } else {
        const retried = await workflowStore.retryExpiredStep(db, {
          runId: row.id,
          stepKey: row.step_key,
          leaseToken: row.lease_token,
          expiredBefore: now,
        });
        if (retried) summary.retried += 1;
        else summary.raced += 1;
      }
    } catch (error) {
      if (error.code === 'workflow_lease_lost') summary.raced += 1;
      else {
        summary.failed += 1;
        console.error(`[workflow-worker] stale recovery ${row.id}/${row.step_key} failed: ${error.message}`);
      }
    }
  }
  return summary;
}

async function resumeQueuedRuns(db) {
  const rows = await db.query(sql`SELECT DISTINCT r.id, r.workflow_name
    FROM workflow_runs r JOIN workflow_steps s ON s.run_id=r.id
    WHERE r.status IN ('queued','running') AND s.status='pending'
      AND NOT EXISTS (SELECT 1 FROM workflow_steps active
        WHERE active.run_id=r.id AND active.status='running')
    ORDER BY r.updated_at LIMIT 25`);
  let resumed = 0;
  let unsupported = 0;
  let failed = 0;
  for (const row of rows) {
    const definition = getDefinition(row.workflow_name);
    if (!definition) { unsupported += 1; continue; }
    try {
      await executeGraph(db, definition, row.id, executionServices());
      resumed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[workflow-worker] resume queued ${row.id} failed: ${error.message}`);
    }
  }
  return { candidates: rows.length, resumed, unsupported, failed };
}

async function isolate(name, operation) {
  try {
    return await operation();
  } catch (error) {
    console.error(`[workflow-worker] ${name} subsystem failed: ${error.stack || error.message}`);
    return { failed: 1, error: error.code || error.name || 'workflow_subsystem_error' };
  }
}

async function tick(db) {
  if (running) return null;
  running = true;
  try {
    const recovery = await isolate('recovery', () => recoverStaleRuns(db));
    const ownerrez = await isolate('ownerrez-ingress', () => queueOwnerRezEvents(db));
    const whatsapp = await isolate('whatsapp-ingress', () => queueWhatsAppInbound(db));
    const queued = await isolate('queued-runs', () => resumeQueuedRuns(db));
    const workflows = await isolate('retry-runs', () => resumeDueRuns(db));
    const outbox = await isolate('outbox', () => drainOutbox(db, { limit: 100, workerId }));
    return { recovery, ownerrez, whatsapp, queued, workflows, outbox };
  } finally {
    running = false;
  }
}

async function main() {
  const db = createDB(DB_PATH);
  await db.query(sql`PRAGMA journal_mode = WAL`);
  await db.query(sql`PRAGMA foreign_keys = ON`);
  await ensureSchemaAsync(db, sql);

  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    do {
      const result = await tick(db);
      if (once) console.log(JSON.stringify({ ok: true, ...result }));
      if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, intervalMs));
    } while (!once && !stopping);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[workflow-worker] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  queueOwnerRezEvents,
  queueWhatsAppInbound,
  recoverStaleRuns,
  resumeDueRuns,
  resumeQueuedRuns,
  authorizeSystemRun,
  executionServices,
  isolate,
  tick,
};
