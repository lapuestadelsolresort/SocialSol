#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, runDir, todayISODate } = require('./lib/config');
const { fetchAll } = require('./lib/fetcher');

function parseArgs(argv) {
  const args = { runDate: null, forceRefetch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-date') args.runDate = argv[++i];
    else if (a.startsWith('--run-date=')) args.runDate = a.slice('--run-date='.length);
    else if (a === '--force-refetch') args.forceRefetch = true;
  }
  return args;
}

async function readJSONL(p) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (e) {
      console.error(`[02-fetch] skipping malformed line in ${p}: ${e.message}`);
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const research = cfg.research;
  const runDate = args.runDate || todayISODate();
  const dir = runDir(runDate);
  const inPath = path.join(dir, '01-searches.jsonl');
  if (!fs.existsSync(inPath)) {
    console.error(`[02-fetch] missing input ${inPath}`);
    process.exit(2);
  }

  const rows = await readJSONL(inPath);
  // Dedup by URL within this run; preserve first occurrence's metadata
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.url)) seen.set(r.url, r);
  }
  const unique = [...seen.values()];

  const urls = unique.map(r => r.url);
  const fetchOpts = {
    userAgent: research.user_agent,
    timeoutMs: research.fetch_timeout_ms || 30000,
    cacheTtlDays: research.fetch_cache_ttl_days || 7,
    concurrency: research.fetch_concurrency || 3,
    respectRobots: true,
    bypassCache: !!args.forceRefetch,
    onProgress: (done, total, last) => {
      if (done % 5 === 0 || done === total) {
        console.error(`[02-fetch] ${done}/${total} (last: ${last.status} ${last.url})`);
      }
    },
  };
  if (args.forceRefetch) console.error(`[02-fetch] --force-refetch enabled; bypassing 7-day page cache`);

  console.error(`[02-fetch] fetching ${urls.length} unique URLs (concurrency=${fetchOpts.concurrency})`);
  const fetched = await fetchAll(urls, fetchOpts);

  const byUrl = new Map();
  fetched.forEach(f => byUrl.set(f.url, f));

  const outPath = path.join(dir, '02-fetches.jsonl');
  const out = fs.createWriteStream(outPath, { flags: 'w' });
  let okCount = 0;
  let errCount = 0;
  let cachedCount = 0;
  for (const r of unique) {
    const f = byUrl.get(r.url);
    const merged = {
      url: r.url,
      persona: r.persona,
      query: r.query,
      status: f.status,
      cached: !!f.cached,
      title: f.title || r.title || null,
      text: f.text || '',
      html_length: f.html_length || 0,
      text_length: f.text_length || 0,
      discovered_emails: f.discovered_emails || [],
      discovered_phones: f.discovered_phones || [],
      error: f.error || null,
      fetched_at: f.fetched_at,
    };
    if (merged.status === 200) okCount++;
    else errCount++;
    if (merged.cached) cachedCount++;
    out.write(JSON.stringify(merged) + '\n');
  }
  out.end();
  await new Promise(res => out.on('close', res));

  console.error(`[02-fetch] DONE wrote ${outPath} (ok: ${okCount}, errors: ${errCount}, cached: ${cachedCount})`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };
