#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runDir, todayISODate, loadConfig } = require('./lib/config');
const { postToChannel } = require('./lib/slack');

function parseArgs(argv) {
  const args = { persona: null, dryRun: false, runDate: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persona') args.persona = argv[++i];
    else if (a.startsWith('--persona=')) args.persona = a.slice('--persona='.length);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--run-date') args.runDate = argv[++i];
    else if (a.startsWith('--run-date=')) args.runDate = a.slice('--run-date='.length);
    else if (a === '--json') args.json = true;
  }
  return args;
}

function readRunSummary(dir) {
  try {
    const line = fs.readFileSync(path.join(dir, 'summary.jsonl'), 'utf8')
      .split(/\r?\n/)
      .find(Boolean);
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function chooseRunDate(initial) {
  let date = initial;
  let dir = runDir(date);
  if (!fs.existsSync(dir)) return date;
  // If today's directory already exists with content, append -2, -3...
  for (let n = 2; n < 100; n++) {
    const cand = `${initial}-${n}`;
    if (!fs.existsSync(runDir(cand))) return cand;
  }
  return date;
}

function runStage(scriptPath, extraArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('close', code => resolve(code));
    child.on('error', err => {
      console.error(`[run-research] spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.persona) {
    console.error(`Usage: run-research.js --persona <wedding_planner|all> [--dry-run]`);
    process.exit(2);
  }

  const startISO = todayISODate();
  const runDate = args.runDate || chooseRunDate(startISO);
  const dir = runDir(runDate);
  const workflowRunId = /^[0-9a-f-]{36}$/i.test(process.env.WORKFLOW_RUN_ID || '')
    ? process.env.WORKFLOW_RUN_ID
    : null;
  if (args.runDate && fs.existsSync(path.join(dir, 'meta.json'))) {
    const previous = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (workflowRunId && previous.workflow_run_id === workflowRunId && previous.status === 'completed') {
      const summary = readRunSummary(dir);
      if (!summary) throw new Error(`completed research run ${runDate} has no summary readback`);
      if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, replayed: true, ...summary })}\n`);
      return;
    }
    throw new Error(`explicit research run directory already exists and is not a completed replay: ${runDate}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const meta = {
    persona: args.persona,
    run_date: runDate,
    dry_run: args.dryRun,
    workflow_run_id: workflowRunId,
    started_at: new Date().toISOString(),
    status: 'running',
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const scriptsDir = __dirname;
  const stageArgs = ['--run-date', runDate];
  const personaArgs = ['--persona', args.persona];

  // ── Query overlap check ───────────────────────────────────────────────────
  const queriesPath = path.join(__dirname, '../queries.json');
  const historyPath = path.join(__dirname, '../query-history.json');
  if (fs.existsSync(queriesPath) && fs.existsSync(historyPath)) {
    const personaDef = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const historyMap = {};
    for (const q of (history.queries || [])) historyMap[q.query] = q;

    const personasToCheck = args.persona === 'all'
      ? Object.keys(personaDef.personas)
      : [args.persona];

    const warnings = [];
    for (const p of personasToCheck) {
      const def = personaDef.personas[p];
      if (!def) continue;
      for (const q of def.queries) {
        if (historyMap[q]) {
          const h = historyMap[q];
          warnings.push(`  ⚠️  Already run x${h.times_run} (last: ${h.last_run}): "${q}"`);
        }
      }
    }
    if (warnings.length > 0) {
      const msg = `🔍 Query overlap detected for persona=${args.persona} — ${warnings.length} of the planned queries have been run before and are likely exhausted:\n${warnings.join('\n')}\n\nContinuing anyway (dedup will prevent re-imports). To get better yield, add new queries to research/queries.json first.`;
      console.error('[run-research] ' + msg);
      const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
      const target = cfg.channel_id ? `channel:${cfg.channel_id}` : '#prospector-paulina';
      if (process.env.PAULINA_WORKFLOW_NO_SLACK !== '1') await postToChannel(target, msg);
    }
  }

  const stages = [
    { name: '01-search', file: path.join(scriptsDir, '01-search.js'), args: [...stageArgs, ...personaArgs] },
    { name: '02-fetch', file: path.join(scriptsDir, '02-fetch.js'), args: stageArgs },
    { name: '03-extract', file: path.join(scriptsDir, '03-extract.js'), args: stageArgs },
    { name: '04-dedup', file: path.join(scriptsDir, '04-dedup.js'), args: stageArgs },
    { name: '05-import', file: path.join(scriptsDir, '05-import.js'), args: [...stageArgs, ...(args.dryRun ? ['--dry-run'] : [])] },
  ];

  for (const stage of stages) {
    const t0 = Date.now();
    console.error(`\n=== ${stage.name} ===`);
    const code = await runStage(stage.file, stage.args, {
      PAULINA_WORKFLOW_NO_SLACK: process.env.PAULINA_WORKFLOW_NO_SLACK || '',
      WORKFLOW_RUN_ID: workflowRunId || '',
    });
    const dt = Date.now() - t0;
    if (code !== 0) {
      // Stage 3 returns code 4 when cost cap hits — partial run; continue to dedup/import on what we have.
      const isCostCap = stage.name === '03-extract' && code === 4;
      if (!isCostCap) {
        meta.status = 'failed';
        meta.failed_stage = stage.name;
        meta.failed_exit_code = code;
        meta.failed_after_ms = dt;
        meta.finished_at = new Date().toISOString();
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
        const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
        const target = cfg.channel_id ? `channel:${cfg.channel_id}` : '#prospector-paulina';
        if (process.env.PAULINA_WORKFLOW_NO_SLACK !== '1') {
          await postToChannel(target, `❌ Research run ${runDate} (${args.persona}) failed at ${stage.name} (exit ${code}). See runs/${runDate}/`);
        }
        console.error(`[run-research] FAILED at ${stage.name}, exit ${code}`);
        process.exit(code || 1);
      } else {
        meta.cost_cap_hit_in_extract = true;
        console.error(`[run-research] cost cap hit during 03-extract; continuing with partial extracts.`);
      }
    }
  }

  meta.status = 'completed';
  meta.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  // ── Auto-update query history after every successful run ────────────────────────
  if (!args.dryRun) {
    try {
      const histScript = path.join(__dirname, 'build-query-history.js');
      if (fs.existsSync(histScript)) {
        await new Promise((resolve) => {
          const child = spawn(process.execPath, [histScript], { stdio: 'inherit' });
          child.on('close', resolve);
          child.on('error', resolve);
        });
      }
    } catch (e) {
      console.error('[run-research] query-history update failed (non-fatal):', e.message);
    }
  }

  console.error(`\n[run-research] DONE: runs/${runDate}/ (status=${meta.status}, dry_run=${args.dryRun})`);
  if (args.json) {
    const summary = readRunSummary(dir);
    if (!summary) throw new Error(`research run ${runDate} completed without summary readback`);
    process.stdout.write(`${JSON.stringify({ ok: true, replayed: false, ...summary })}\n`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { chooseRunDate, main, parseArgs, readRunSummary };
