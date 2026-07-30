#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, loadQueries, runDir, todayISODate } = require('./lib/config');
const { makeBraveClient, isExcluded } = require('./lib/brave');

function parseArgs(argv) {
  const args = { persona: null, runDate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persona') args.persona = argv[++i];
    else if (a.startsWith('--persona=')) args.persona = a.slice('--persona='.length);
    else if (a === '--run-date') args.runDate = argv[++i];
    else if (a.startsWith('--run-date=')) args.runDate = a.slice('--run-date='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const queries = loadQueries();
  const research = cfg.research;
  const runDate = args.runDate || todayISODate();
  const dir = runDir(runDate);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, '01-searches.jsonl');
  const out = fs.createWriteStream(outPath, { flags: 'w' });

  const personasToRun = args.persona && args.persona !== 'all'
    ? [args.persona]
    : Object.keys(queries.personas);
  for (const p of personasToRun) {
    if (!queries.personas[p]) {
      console.error(`Unknown persona: ${p}. Available: ${Object.keys(queries.personas).join(', ')}`);
      process.exit(2);
    }
  }

  const client = makeBraveClient(research);
  const excludeDomains = research.exclude_domains || [];
  const excludeExts = research.exclude_extensions || [];
  const maxResults = research.max_results_per_query || 10;

  let totalIn = 0;
  let totalOut = 0;
  const counts = {};

  for (const personaKey of personasToRun) {
    const persona = queries.personas[personaKey];
    counts[personaKey] = { searched: 0, kept: 0 };
    for (const q of persona.queries) {
      let results;
      try {
        results = await client.search(q, { count: maxResults });
      } catch (e) {
        if (e.fatal) {
          console.error(`[01-search] FATAL: ${e.message}`);
          process.exit(3);
        }
        console.error(`[01-search] error on "${q}": ${e.message}`);
        continue;
      }
      counts[personaKey].searched += results.length;
      totalIn += results.length;
      for (let rank = 0; rank < results.length; rank++) {
        const r = results[rank];
        const url = r.url;
        if (!url) continue;
        if (isExcluded(url, excludeDomains, excludeExts)) continue;
        const row = {
          persona: personaKey,
          query: q,
          rank: rank + 1,
          url,
          title: r.title || '',
          description: r.description || '',
          fetched_at: new Date().toISOString(),
        };
        out.write(JSON.stringify(row) + '\n');
        counts[personaKey].kept++;
        totalOut++;
      }
      console.error(`[01-search] ${personaKey} | "${q}" | got ${results.length}, kept ${counts[personaKey].kept}`);
    }
  }

  out.end();
  await new Promise(res => out.on('close', res));

  console.error(`[01-search] DONE wrote ${outPath} (in: ${totalIn}, kept: ${totalOut})`);
  console.error(`[01-search] per-persona: ${JSON.stringify(counts)}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };
