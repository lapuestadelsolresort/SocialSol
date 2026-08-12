#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');
const { loadControlToken } = require('../lib/workflow-auth');
const { loadPolicy } = require('../lib/channel-policy');

const INBOX = path.join(ROOT, 'accounting', 'inbox');

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

async function main(fetchImpl = fetch) {
  fs.mkdirSync(INBOX, { recursive: true });
  const files = fs.readdirSync(INBOX, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map(entry => path.join(INBOX, entry.name))
    .sort()
    .slice(0, 25);
  if (loadPolicy().shadow_mode === true) {
    console.log(JSON.stringify({ ok: true, shadow: true, candidates: files.map(file => path.basename(file)) }));
    return;
  }
  const results = [];
  for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const relative = path.relative(ROOT, file);
    const classification = await execute(
      'accounting.classify', { csvPath: relative }, `accounting:${hash}:classify`, fetchImpl,
    );
    const qbo = await execute('qbo.write', { csvPath: relative }, `accounting:${hash}:qbo`, fetchImpl);
    results.push({ file: path.basename(file), hash, classificationRunId: classification.id, qboRunId: qbo.id });
  }
  console.log(JSON.stringify({ ok: true, processed: results.length, results }));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[accounting-inbox] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { INBOX, execute, main };
