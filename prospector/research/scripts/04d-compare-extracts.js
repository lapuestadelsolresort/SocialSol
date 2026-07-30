#!/usr/bin/env node
'use strict';

// 04d-compare-extracts.js — diff v1 baseline vs v2 re-extract by URL.
//
// PURE FILE I/O. No API calls. No DB writes.
//
// Reads runs/<date>/03-extracts.jsonl + 03-extracts-v2.jsonl, joins on URL,
// emits one consolidated CSV at research/extract-compare.csv plus a
// distributions summary at research/extract-compare-summary.md.
//
// CLI: node 04d-compare-extracts.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { stringify } = require('csv-stringify/sync');
const { RESEARCH_ROOT } = require('./lib/config');

const CSV_PATH = path.join(RESEARCH_ROOT, 'extract-compare.csv');
const SUMMARY_PATH = path.join(RESEARCH_ROOT, 'extract-compare-summary.md');

const CSV_COLUMNS = [
  'run_date', 'persona', 'url',
  'named_contact_old', 'named_contact_new',
  'email_old', 'email_new',
  'quality_old', 'quality_new', 'quality_delta',
  'fit_old', 'fit_new',
  'page_type_new', 'rejection_reason_new',
  'destination_work_evidence_new', 'mexico_or_latam_evidence_new',
  'group_size_signal_new', 'budget_signal_new', 'portfolio_recency_signal_new',
  'judgment_change',
];

async function readJSONL(p) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) {}
  }
  return rows;
}

function isRunDateDir(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function eligibleDates() {
  const runsRoot = path.join(RESEARCH_ROOT, 'runs');
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot)
    .filter(isRunDateDir)
    .filter((d) => {
      const dir = path.join(runsRoot, d);
      return fs.existsSync(path.join(dir, '03-extracts.jsonl'))
          && fs.existsSync(path.join(dir, '03-extracts-v2.jsonl'));
    })
    .sort();
}

// Pick a representative named-contact name from an `extracted` blob.
function firstNamedContactName(extracted) {
  if (!extracted || !Array.isArray(extracted.named_contacts)) return '';
  for (const nc of extracted.named_contacts) {
    if (nc && nc.name) return nc.name;
  }
  return '';
}

// Pick a representative email: first named-contact email, else first role-based.
function firstEmail(extracted) {
  if (!extracted) return '';
  if (Array.isArray(extracted.named_contacts)) {
    for (const nc of extracted.named_contacts) {
      if (nc && nc.email) return nc.email;
    }
  }
  if (Array.isArray(extracted.role_based_emails) && extracted.role_based_emails.length > 0) {
    return extracted.role_based_emails[0];
  }
  return '';
}

function isOk(row) {
  return row && row.extract_status === 'ok' && row.extracted;
}

function numOrEmpty(v) {
  return (typeof v === 'number') ? v : '';
}

function judgmentChange({ v1, v2 }) {
  const ok1 = isOk(v1);
  const ok2 = isOk(v2);
  if (!ok1 && !ok2) return 'lost';        // both missing — treat as v2 unavailable
  if (ok1 && !ok2) return 'lost';
  if (!ok1 && ok2) return 'new_only';
  const q1 = v1.extracted.quality_score;
  const q2 = v2.extracted.quality_score;
  if (typeof q1 !== 'number' || typeof q2 !== 'number') {
    // missing scores — fall back to unchanged unless one side missing
    if (q1 === q2) return 'unchanged';
  }
  if (q2 === 1 && q1 >= 3) return 'downgraded_to_floor';
  if (q2 > q1) return 'upgraded';
  if (q2 === q1) return 'unchanged';
  return 'downgraded';
}

function buildCsvRow({ runDate, persona, url, v1, v2 }) {
  const ext1 = v1 && v1.extracted ? v1.extracted : null;
  const ext2 = v2 && v2.extracted ? v2.extracted : null;

  const q1 = ext1 && typeof ext1.quality_score === 'number' ? ext1.quality_score : '';
  const q2 = ext2 && typeof ext2.quality_score === 'number' ? ext2.quality_score : '';
  const qDelta = (typeof q1 === 'number' && typeof q2 === 'number') ? (q2 - q1) : '';

  return {
    run_date: runDate,
    persona: persona || '',
    url: url || '',
    named_contact_old: ext1 ? firstNamedContactName(ext1) : '',
    named_contact_new: ext2 ? firstNamedContactName(ext2) : '',
    email_old: ext1 ? firstEmail(ext1) : '',
    email_new: ext2 ? firstEmail(ext2) : '',
    quality_old: numOrEmpty(q1),
    quality_new: numOrEmpty(q2),
    quality_delta: qDelta,
    fit_old: (ext1 && ext1.persona_fit) || '',
    fit_new: (ext2 && ext2.persona_fit) || '',
    page_type_new: (ext2 && ext2.page_type) || '',
    rejection_reason_new: (ext2 && ext2.rejection_reason) || '',
    destination_work_evidence_new: (ext2 && ext2.destination_work_evidence) || '',
    mexico_or_latam_evidence_new: (ext2 && ext2.mexico_or_latam_evidence) || '',
    group_size_signal_new: (ext2 && ext2.group_size_signal) || '',
    budget_signal_new: (ext2 && ext2.budget_signal) || '',
    portfolio_recency_signal_new: (ext2 && ext2.portfolio_recency_signal) || '',
    judgment_change: judgmentChange({ v1, v2 }),
  };
}

function distribution(rows, key, filter = null) {
  const counts = new Map();
  let total = 0;
  for (const r of rows) {
    if (filter && !filter(r)) continue;
    const k = r[key] == null || r[key] === '' ? '(empty)' : String(r[key]);
    counts.set(k, (counts.get(k) || 0) + 1);
    total++;
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return { entries, total };
}

function mdTable(title, dist) {
  const lines = [];
  lines.push(`### ${title}`);
  lines.push('');
  if (dist.total === 0) {
    lines.push('_No rows._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| value | count | % |');
  lines.push('|---|---:|---:|');
  for (const [k, c] of dist.entries) {
    const pct = ((c / dist.total) * 100).toFixed(1);
    lines.push(`| \`${k.replace(/\|/g, '\\|')}\` | ${c} | ${pct}% |`);
  }
  lines.push(`| **total** | **${dist.total}** | **100.0%** |`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const dates = eligibleDates();
  if (dates.length === 0) {
    console.error('[04d-compare] No run-date directories have both 03-extracts.jsonl ' +
                  'AND 03-extracts-v2.jsonl. Run 04c-reextract.js first. Exiting.');
    process.exit(2);
  }
  console.error(`[04d-compare] Comparing run-dates: ${dates.join(', ')}`);

  const allCsvRows = [];
  const perRun = []; // for summary header

  for (const runDate of dates) {
    const dir = path.join(RESEARCH_ROOT, 'runs', runDate);
    const v1Rows = await readJSONL(path.join(dir, '03-extracts.jsonl'));
    const v2Rows = await readJSONL(path.join(dir, '03-extracts-v2.jsonl'));

    const v1ByUrl = new Map();
    const v2ByUrl = new Map();
    const personasSet = new Set();
    for (const r of v1Rows) {
      if (r && r.url) v1ByUrl.set(r.url, r);
      if (r && r.persona) personasSet.add(r.persona);
    }
    for (const r of v2Rows) {
      if (r && r.url) v2ByUrl.set(r.url, r);
      if (r && r.persona) personasSet.add(r.persona);
    }

    const urls = new Set([...v1ByUrl.keys(), ...v2ByUrl.keys()]);
    for (const url of urls) {
      const v1 = v1ByUrl.get(url) || null;
      const v2 = v2ByUrl.get(url) || null;
      const persona = (v1 && v1.persona) || (v2 && v2.persona) || '';
      allCsvRows.push(buildCsvRow({ runDate, persona, url, v1, v2 }));
    }

    perRun.push({
      run_date: runDate,
      v1_rows: v1Rows.length,
      v2_rows: v2Rows.length,
      personas: Array.from(personasSet).sort(),
    });
    console.error(`[04d-compare] ${runDate}: v1=${v1Rows.length} v2=${v2Rows.length} joined=${urls.size}`);
  }

  // ─── CSV ────────────────────────────────────────────────────────────────
  const csvText = stringify(allCsvRows, { header: true, columns: CSV_COLUMNS });
  fs.writeFileSync(CSV_PATH, csvText);
  console.error(`[04d-compare] Wrote ${CSV_PATH} (${allCsvRows.length} rows)`);

  // ─── Summary markdown ──────────────────────────────────────────────────
  const judgmentDist = distribution(allCsvRows, 'judgment_change');
  const pageTypeDist = distribution(allCsvRows, 'page_type_new');
  const rejectionDist = distribution(
    allCsvRows,
    'rejection_reason_new',
    (r) => r.judgment_change === 'downgraded_to_floor',
  );

  const md = [];
  md.push(`# Extract comparison — v1 baseline vs v2 prompt`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push(`Total rows compared: **${allCsvRows.length}**`);
  md.push('');
  md.push(`## Runs included`);
  md.push('');
  md.push(`| run_date | v1 rows | v2 rows | personas |`);
  md.push(`|---|---:|---:|---|`);
  for (const r of perRun) {
    md.push(`| ${r.run_date} | ${r.v1_rows} | ${r.v2_rows} | ${r.personas.join(', ') || '(none)'} |`);
  }
  md.push('');
  md.push(`## Distributions`);
  md.push('');
  md.push(mdTable('`judgment_change` (all rows)', judgmentDist));
  md.push(mdTable('`page_type_new` (all rows)', pageTypeDist));
  md.push(mdTable('`rejection_reason_new` among `downgraded_to_floor`', rejectionDist));
  md.push(`---`);
  md.push(`Per-row CSV: \`${path.relative(RESEARCH_ROOT, CSV_PATH)}\``);
  md.push('');

  fs.writeFileSync(SUMMARY_PATH, md.join('\n'));
  console.error(`[04d-compare] Wrote ${SUMMARY_PATH}`);
  console.error(`[04d-compare] DONE rows=${allCsvRows.length} ` +
                `downgraded_to_floor=${
                  (judgmentDist.entries.find(([k]) => k === 'downgraded_to_floor') || [, 0])[1]
                }`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main, buildCsvRow, judgmentChange, CSV_COLUMNS };
