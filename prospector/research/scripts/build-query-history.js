#!/usr/bin/env node
// build-query-history.js
// Scans all run directories, builds query-history.json tracking every search query ever used.
// Run any time after a research run to keep history current.

const fs = require('fs');
const path = require('path');

const runsDir = path.join(__dirname, '../runs');
const outFile = path.join(__dirname, '../query-history.json');

const history = {};

const runDirs = fs.readdirSync(runsDir).filter(d => !d.startsWith('.')).sort();

for (const runName of runDirs) {
  const runDir = path.join(runsDir, runName);
  const metaPath = path.join(runDir, 'meta.json');
  const searchesPath = path.join(runDir, '01-searches.jsonl');
  const dedupedPath = path.join(runDir, '04-deduped.jsonl');

  if (!fs.existsSync(metaPath) || !fs.existsSync(searchesPath)) continue;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.dry_run) continue;

  const queries = fs.readFileSync(searchesPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
    .filter(Boolean);

  let newCount = 0;
  if (fs.existsSync(dedupedPath)) {
    const deduped = fs.readFileSync(dedupedPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
      .filter(Boolean);
    newCount = deduped.filter(r => r.dedup_status === 'new').length;
  }

  const queryResults = {};
  for (const row of queries) {
    if (!queryResults[row.query]) queryResults[row.query] = 0;
    queryResults[row.query]++;
  }

  const runDate = meta.run_date || runName;
  const persona = meta.persona || 'unknown';

  for (const [query, serpCount] of Object.entries(queryResults)) {
    if (!history[query]) history[query] = { query, persona, runs: [] };
    history[query].runs.push({
      run_date: runDate,
      run_id: runName,
      persona,
      serp_results: serpCount,
      run_new_contacts: newCount
    });
  }
}

const summary = Object.values(history).map(q => ({
  query: q.query,
  persona: q.persona,
  times_run: q.runs.length,
  last_run: q.runs[q.runs.length - 1]?.run_date,
  runs: q.runs
})).sort((a, b) => a.query.localeCompare(b.query));

fs.writeFileSync(outFile, JSON.stringify({ generated_at: new Date().toISOString(), queries: summary }, null, 2));
console.log(`Written ${summary.length} query records to query-history.json`);
summary.forEach(q => {
  const flag = q.times_run > 1 ? ' ⚠️  ALREADY RUN' : '';
  console.log(`  [x${q.times_run}] last=${q.last_run} — ${q.query}${flag}`);
});
