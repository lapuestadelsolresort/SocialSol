#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, runDir, todayISODate } = require('./lib/config');
const { openReadOnly, classifyCandidate, sortAndCap } = require('./lib/dedup');

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

function expandToCandidates(extractRow) {
  const out = [];
  const ext = extractRow.extracted || {};
  const evidence = extractRow.evidence || ext.evidence || {};
  const persona_fit = ext.persona_fit || null;
  const quality_score = ext.quality_score || null;
  const namedContacts = Array.isArray(ext.named_contacts) ? ext.named_contacts : [];
  for (const nc of namedContacts) {
    if (nc && nc.email) {
      out.push({
        url: extractRow.url,
        persona: extractRow.persona,
        named_contact: nc,
        email: nc.email,
        extracted: ext,
        evidence,
        persona_fit,
        quality_score,
        page_type:                  ext.page_type || null,
        rejection_reason:           ext.rejection_reason || null,
        destination_work_evidence:  ext.destination_work_evidence || null,
        mexico_or_latam_evidence:   ext.mexico_or_latam_evidence || null,
        group_size_signal:          ext.group_size_signal || null,
        budget_signal:              ext.budget_signal || null,
        portfolio_recency_signal:   ext.portfolio_recency_signal || null,
      });
    }
  }
  const roleEmails = Array.isArray(ext.role_based_emails) ? ext.role_based_emails : [];
  for (const re of roleEmails) {
    if (typeof re === 'string' && re.includes('@')) {
      out.push({
        url: extractRow.url,
        persona: extractRow.persona,
        named_contact: null,
        email: re,
        extracted: ext,
        evidence,
        persona_fit,
        quality_score,
        page_type:                  ext.page_type || null,
        rejection_reason:           ext.rejection_reason || null,
        destination_work_evidence:  ext.destination_work_evidence || null,
        mexico_or_latam_evidence:   ext.mexico_or_latam_evidence || null,
        group_size_signal:          ext.group_size_signal || null,
        budget_signal:              ext.budget_signal || null,
        portfolio_recency_signal:   ext.portfolio_recency_signal || null,
      });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const research = cfg.research;
  const runDate = args.runDate || todayISODate();
  const dir = runDir(runDate);
  const inPath = path.join(dir, '03-extracts.jsonl');
  if (!fs.existsSync(inPath)) {
    console.error(`[04-dedup] missing input ${inPath}`);
    process.exit(2);
  }

  const rows = await readJSONL(inPath);
  const okRows = rows.filter(r =>
    r.extract_status === 'ok' &&
    r.extracted &&
    (r.extracted.quality_score || 0) >= 3 &&
    r.extracted.page_type === 'real_planner'
  );

  // Expand to candidates, dedup duplicates within the run by lower(email)
  const seen = new Set();
  const candidates = [];
  for (const r of okRows) {
    for (const c of expandToCandidates(r)) {
      const key = (c.email || '').toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
    }
  }

  const db = await openReadOnly();
  try {
    const classified = [];
    for (const c of candidates) {
      const cls = await classifyCandidate(db, c.email);
      classified.push({ ...c, ...cls });
    }
    // Sort by quality + persona_fit; cap at row_cap_per_run.
    const cap = research.row_cap_per_run || 50;
    const survivors = sortAndCap(classified, cap);

    const outPath = path.join(dir, '04-deduped.jsonl');
    const out = fs.createWriteStream(outPath, { flags: 'w' });
    const counts = { new: 0, existing_email: 0, existing_domain: 0, suppressed: 0, invalid: 0 };
    for (const c of survivors) {
      counts[c.dedup_status] = (counts[c.dedup_status] || 0) + 1;
      out.write(JSON.stringify(c) + '\n');
    }
    out.end();
    await new Promise(res => out.on('close', res));

    console.error(`[04-dedup] DONE wrote ${outPath} | total=${survivors.length} ${JSON.stringify(counts)} (pre-cap=${classified.length})`);
  } finally {
    if (db && db.dispose) await db.dispose();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };
