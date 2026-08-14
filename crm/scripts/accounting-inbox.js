#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');
const { loadControlToken } = require('../lib/workflow-auth');
const { loadPolicy } = require('../lib/channel-policy');
const { workflowIsLive } = require('../lib/workflow-execution-policy');
const { findCsvByHash } = require('../lib/accounting-slack-inbox');

const INBOX = path.join(ROOT, 'accounting', 'inbox');
const PROCESSED = path.join(INBOX, 'processed');

function accountingWorkflowsLive(policy) {
  return workflowIsLive(policy, 'accounting.classify')
    && workflowIsLive(policy, 'receipt.reconcile')
    && workflowIsLive(policy, 'qbo.write');
}

function archiveProcessedFile(file, hash, processedDirectory = PROCESSED) {
  fs.mkdirSync(processedDirectory, { recursive: true, mode: 0o700 });
  const parsed = path.parse(file);
  const candidates = [
    path.join(processedDirectory, parsed.base),
    path.join(processedDirectory, `${parsed.name}.${hash.slice(0, 12)}${parsed.ext}`),
    path.join(processedDirectory, `${parsed.name}.${hash.slice(0, 12)}.${Date.now()}${parsed.ext}`),
  ];
  const destination = candidates.find(candidate => !fs.existsSync(candidate));
  fs.renameSync(file, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

async function execute(workflow, input, idempotencyKey, fetchImpl = fetch) {
  const token = loadControlToken();
  if (!token) throw new Error('workflow control token is unavailable');
  const base = String(process.env.RESORT_WORKFLOW_BASE_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/api/workflows/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workflow,
      input,
      context: { origin: 'system' },
      idempotency_key: idempotencyKey,
    }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${workflow} returned ${response.status}`);
  let run = payload.run;
  const deadline = Date.now() + 30 * 60_000;
  while (run && ['queued', 'running', 'retry'].includes(run.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const statusResponse = await fetchImpl(`${base}/api/workflows/runs/${encodeURIComponent(run.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const statusPayload = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) throw new Error(statusPayload.error || `${workflow} status returned ${statusResponse.status}`);
    run = statusPayload.run;
  }
  if (run?.status !== 'completed') throw new Error(`${workflow} is ${run?.status || 'unknown'}`);
  return run;
}

async function main(fetchImpl = fetch, {
  inboxDirectory = INBOX,
  processedDirectory = PROCESSED,
  executeWorkflow = execute,
  policy = null,
} = {}) {
  fs.mkdirSync(inboxDirectory, { recursive: true });
  const files = fs.readdirSync(inboxDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map(entry => path.join(inboxDirectory, entry.name))
    .sort()
    .slice(0, 25);
  if (!accountingWorkflowsLive(policy || loadPolicy({ fresh: true }))) {
    console.log(JSON.stringify({ ok: true, shadow: true, candidates: files.map(file => path.basename(file)) }));
    return;
  }
  const results = [];
  for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const previous = findCsvByHash(hash, processedDirectory);
    if (previous) {
      const archived = archiveProcessedFile(file, hash, processedDirectory);
      results.push({
        file: path.basename(file),
        archived: path.relative(ROOT, archived),
        hash,
        duplicate: true,
        matchedProcessed: path.relative(ROOT, previous),
      });
      continue;
    }
    const relative = path.relative(ROOT, file);
    const classification = await executeWorkflow(
      'accounting.classify', { csvPath: relative }, `accounting:${hash}:classify`, fetchImpl,
    );
    const reconciliation = await executeWorkflow(
      'receipt.reconcile', {}, `accounting:${hash}:receipt-reconcile`, fetchImpl,
    );
    const qbo = await executeWorkflow('qbo.write', { csvPath: relative }, `accounting:${hash}:qbo`, fetchImpl);
    const archived = archiveProcessedFile(file, hash, processedDirectory);
    results.push({
      file: path.basename(file),
      archived: path.relative(ROOT, archived),
      hash,
      classificationRunId: classification.id,
      reconciliationRunId: reconciliation.id,
      qboRunId: qbo.id,
    });
  }
  console.log(JSON.stringify({ ok: true, processed: results.length, results }));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[accounting-inbox] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  INBOX,
  PROCESSED,
  accountingWorkflowsLive,
  archiveProcessedFile,
  execute,
  main,
};
