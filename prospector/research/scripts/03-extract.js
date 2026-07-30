#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, loadQueries, runDir, todayISODate } = require('./lib/config');
const { Extractor, CostCapExceeded } = require('./lib/extractor');

function parseArgs(argv) {
  const args = { runDate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-date') args.runDate = argv[++i];
    else if (a.startsWith('--run-date=')) args.runDate = a.slice('--run-date='.length);
  }
  return args;
}

async function readJSONL(p) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) {}
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const queries = loadQueries();
  const research = cfg.research;
  const runDate = args.runDate || todayISODate();
  const dir = runDir(runDate);
  const inPath = path.join(dir, '02-fetches.jsonl');
  if (!fs.existsSync(inPath)) {
    console.error(`[03-extract] missing input ${inPath}`);
    process.exit(2);
  }

  // Cost cap can be overridden by env for fire-drill verification.
  const costCap = process.env.COST_CAP_OVERRIDE_USD
    ? parseFloat(process.env.COST_CAP_OVERRIDE_USD)
    : (research.cost_cap_usd || 5.00);
  const minTextChars = research.min_text_chars || 800;

  const rows = await readJSONL(inPath);
  const extractor = new Extractor({ model: research.model, costCapUsd: costCap });

  const outPath = path.join(dir, '03-extracts.jsonl');
  const out = fs.createWriteStream(outPath, { flags: 'w' });

  let calls = 0;
  let okCount = 0;
  let parseErrors = 0;
  let apiErrors = 0;
  let belowThreshold = 0;
  let nonOkFetches = 0;
  let costCapHit = false;

  for (const r of rows) {
    if (r.status !== 200) {
      out.write(JSON.stringify({
        url: r.url, persona: r.persona, extract_status: 'fetch_failed',
        fetch_status: r.status, fetch_error: r.error,
        extracted_at: new Date().toISOString(),
      }) + '\n');
      nonOkFetches++;
      continue;
    }
    if (!r.text || r.text_length < minTextChars) {
      out.write(JSON.stringify({
        url: r.url, persona: r.persona, extract_status: 'low_text',
        text_length: r.text_length, threshold: minTextChars,
        extracted_at: new Date().toISOString(),
      }) + '\n');
      belowThreshold++;
      continue;
    }
    const personaCfg = queries.personas[r.persona];
    const personaLabel = personaCfg ? personaCfg.label : r.persona;

    let result;
    try {
      result = await extractor.extract({
        personaLabel,
        url: r.url,
        title: r.title,
        text: r.text,
      });
    } catch (e) {
      if (e instanceof CostCapExceeded) {
        console.error(`[03-extract] COST CAP HIT: ${e.message}. Aborting stage.`);
        costCapHit = true;
        out.write(JSON.stringify({
          url: r.url, persona: r.persona, extract_status: 'cost_cap_hit',
          running_cost_usd: extractor.cost(),
          extracted_at: new Date().toISOString(),
        }) + '\n');
        break;
      }
      throw e;
    }
    calls++;
    if (result.extract_status === 'ok') okCount++;
    else if (result.extract_status === 'parse_error') parseErrors++;
    else if (result.extract_status === 'api_error') apiErrors++;

    out.write(JSON.stringify({
      url: r.url,
      persona: r.persona,
      ...result,
    }) + '\n');

    if (calls % 10 === 0) {
      console.error(`[03-extract] ${calls} calls, $${extractor.cost().toFixed(4)} so far`);
    }
  }

  out.end();
  await new Promise(res => out.on('close', res));

  // Persist running cost + cap status to the meta sidecar so the orchestrator can read it.
  const sidecar = path.join(dir, '03-extract.meta.json');
  fs.writeFileSync(sidecar, JSON.stringify({
    calls,
    cost_usd: extractor.cost(),
    cost_cap_usd: costCap,
    cost_cap_hit: costCapHit,
    ok: okCount,
    parse_errors: parseErrors,
    api_errors: apiErrors,
    below_threshold: belowThreshold,
    non_ok_fetches: nonOkFetches,
    model: research.model,
  }, null, 2));

  console.error(`[03-extract] DONE wrote ${outPath} | calls=${calls} ok=${okCount} parse_err=${parseErrors} api_err=${apiErrors} low_text=${belowThreshold} cost=$${extractor.cost().toFixed(4)} cap_hit=${costCapHit}`);
  if (costCapHit) process.exitCode = 4;
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };
