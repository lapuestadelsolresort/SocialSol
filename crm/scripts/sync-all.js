#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, SOCIALSOL_ROOT: ROOT },
      timeout: 15 * 60_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        const wrapped = new Error(`${script} failed: ${String(stderr || error.message).trim()}`);
        wrapped.code = 'crm_source_sync_failed';
        reject(wrapped);
      } else {
        resolve({ script, stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

function lastJson(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

async function main() {
  // Fixed sequence: each source has its own watermark/dedup semantics. A
  // failed source stops the graph so the durable worker can retry it.
  const ownerrez = await run('crm/scripts/ownerrez-sync.js');
  const squarespace = await run('crm/scripts/squarespace-sync.js', ['--json']);
  const result = {
    ok: true,
    sources: {
      ownerrez: lastJson(ownerrez.stdout),
      squarespace: lastJson(squarespace.stdout),
    },
  };
  if (!result.sources.ownerrez || !result.sources.squarespace?.ok) {
    throw new Error('CRM sync sources did not return machine-verifiable summaries');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[sync-all] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { lastJson, main, run };
