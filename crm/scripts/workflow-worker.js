#!/usr/bin/env node
'use strict';

const os = require('node:os');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { DB_PATH } = require('../../lib/runtime-paths');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { executeGraph } = require('../lib/workflow-engine');
const { createRun } = require('../lib/workflow-store');
const { drainOutbox } = require('../lib/workflow-outbox');
const { sendWhatsApp } = require('../lib/twilio-whatsapp');
const { requestOwnerRez } = require('../lib/ownerrez-api');
const { runCommand } = require('../lib/workflow-command');
const { loadPolicy } = require('../lib/channel-policy');
const { getDefinition } = require('../workflows/registry');

const once = process.argv.includes('--once');
const intervalMs = Math.max(500, Number(process.env.WORKFLOW_POLL_INTERVAL_MS || 2000));
const workerId = `${os.hostname()}:${process.pid}`;
let stopping = false;
let running = false;

async function resumeDueRuns(db) {
  const now = new Date().toISOString();
  const rows = await db.query(sql`SELECT DISTINCT r.id, r.workflow_name
    FROM workflow_runs r
    JOIN workflow_steps s ON s.run_id=r.id
    WHERE r.status='retry' AND s.status='retry' AND s.available_at <= ${now}
    ORDER BY r.updated_at LIMIT 25`);
  let resumed = 0;
  let unsupported = 0;
  for (const row of rows) {
    const definition = getDefinition(row.workflow_name);
    if (!definition) {
      unsupported += 1;
      continue;
    }
    await executeGraph(db, definition, row.id, {
      workerId,
      shadowMode: loadPolicy().shadow_mode === true,
      sendWhatsApp: params => sendWhatsApp(params),
      ownerRezRequest: params => requestOwnerRez(params),
      runCommand,
    });
    resumed += 1;
  }
  return { candidates: rows.length, resumed, unsupported };
}

async function queueOwnerRezEvents(db) {
  const rows = await db.query(sql`SELECT id, payload_hash FROM ownerrez_events
    WHERE processing_status='pending' AND processed=0
    ORDER BY received_at, id LIMIT 25`);
  const definition = getDefinition('ownerrez.webhook.process');
  if (!definition) return { candidates: rows.length, queued: 0, unsupported: rows.length };
  let queued = 0;
  for (const row of rows) {
    const created = await createRun(db, {
      definition,
      idempotencyKey: `ownerrez:webhook:${row.id}:${row.payload_hash || 'unhashed'}`,
      triggerType: 'system',
      triggerRef: `ownerrez-event:${row.id}`,
      input: { eventId: row.id },
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
  const definition = getDefinition('whatsapp.inbound.process');
  if (!definition) return { candidates: rows.length, queued: 0, unsupported: rows.length };
  let queued = 0;
  for (const row of rows) {
    const created = await createRun(db, {
      definition,
      idempotencyKey: `whatsapp:inbound:${row.message_id || row.id}:process`,
      triggerType: 'system',
      triggerRef: `whatsapp-message:${row.id}`,
      input: { messageId: row.id },
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
  const rows = await db.query(sql`SELECT r.id, r.workflow_name, s.step_key
    FROM workflow_runs r
    JOIN workflow_steps s ON s.run_id=r.id
    WHERE r.status='running' AND s.status='running'
      AND s.lease_expires_at IS NOT NULL AND s.lease_expires_at < ${now}
    ORDER BY r.updated_at LIMIT 25`);
  const summary = { candidates: rows.length, retried: 0, manualReview: 0, unsupported: 0 };
  for (const row of rows) {
    const definition = getDefinition(row.workflow_name);
    if (!definition) {
      summary.unsupported += 1;
      continue;
    }
    if (definition.crashRecovery === 'manual') {
      const error = new Error('worker lease expired across a non-idempotent external-effect boundary; inspect provider state before retrying');
      error.code = 'ambiguous_external_result';
      await require('../lib/workflow-store').failStep(db, row.id, row.step_key, error);
      summary.manualReview += 1;
      continue;
    }
    await db.tx(async tx => {
      await tx.query(sql`UPDATE workflow_steps SET status='retry', available_at=${now},
          lease_owner=NULL, lease_expires_at=NULL, error_code='worker_lease_expired',
          error_message='recovered after worker lease expiration', updated_at=${now}
        WHERE run_id=${row.id} AND step_key=${row.step_key} AND status='running'`);
      await tx.query(sql`UPDATE workflow_runs SET status='retry',
          error_code='worker_lease_expired', error_message='safe retry scheduled after worker lease expiration',
          updated_at=${now} WHERE id=${row.id} AND status='running'`);
    });
    summary.retried += 1;
  }
  return summary;
}

async function resumeQueuedRuns(db) {
  const rows = await db.query(sql`SELECT DISTINCT r.id, r.workflow_name
    FROM workflow_runs r JOIN workflow_steps s ON s.run_id=r.id
    WHERE r.status='running' AND s.status='pending'
      AND NOT EXISTS (SELECT 1 FROM workflow_steps active
        WHERE active.run_id=r.id AND active.status='running')
    ORDER BY r.updated_at LIMIT 25`);
  let resumed = 0;
  let unsupported = 0;
  for (const row of rows) {
    const definition = getDefinition(row.workflow_name);
    if (!definition) { unsupported += 1; continue; }
    await executeGraph(db, definition, row.id, {
      workerId,
      shadowMode: loadPolicy().shadow_mode === true,
      sendWhatsApp: params => sendWhatsApp(params),
      ownerRezRequest: params => requestOwnerRez(params),
      runCommand,
    });
    resumed += 1;
  }
  return { candidates: rows.length, resumed, unsupported };
}

async function tick(db) {
  if (running) return null;
  running = true;
  try {
    const recovery = await recoverStaleRuns(db);
    const ownerrez = await queueOwnerRezEvents(db);
    const whatsapp = await queueWhatsAppInbound(db);
    const queued = await resumeQueuedRuns(db);
    const workflows = await resumeDueRuns(db);
    const outbox = await drainOutbox(db, { limit: 100, workerId });
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
  tick,
};
