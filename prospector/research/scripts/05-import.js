#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { stringify } = require('csv-stringify/sync');
const { loadConfig, runDir, todayISODate } = require('./lib/config');
const { buildContactRow, postBulkImport } = require('./lib/importer');
const { postToChannel } = require('./lib/slack');

function parseArgs(argv) {
  const args = { runDate: null, persona: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-date') args.runDate = argv[++i];
    else if (a.startsWith('--run-date=')) args.runDate = a.slice('--run-date='.length);
    else if (a === '--persona') args.persona = argv[++i];
    else if (a.startsWith('--persona=')) args.persona = a.slice('--persona='.length);
    else if (a === '--dry-run') args.dryRun = true;
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

function mdEscape(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }

function buildReport({ runDate, personaSummary, candidates, importResult, costExtract, durations, dryRun, slackChannelName }) {
  const lines = [];
  lines.push(`# Research run ${runDate}`);
  lines.push('');
  lines.push(`Personas: ${Object.keys(personaSummary).join(', ')}`);
  lines.push('');
  lines.push(`## Pipeline counts`);
  lines.push('');
  lines.push(`| persona | searched | fetched | extracted | new | existing | suppressed |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const [p, s] of Object.entries(personaSummary)) {
    lines.push(`| ${p} | ${s.searched} | ${s.fetched_ok} | ${s.extracted_ok} | ${s.dedup.new} | ${s.dedup.existing_email + s.dedup.existing_domain} | ${s.dedup.suppressed} |`);
  }
  lines.push('');
  lines.push(`## Import outcome`);
  lines.push('');
  if (dryRun) {
    lines.push(`**Dry-run: no rows imported. Would have attempted ${importResult.attempted}.**`);
  } else {
    lines.push(`Attempted: ${importResult.attempted} | Inserted: ${importResult.inserted} | Skipped duplicates: ${importResult.skipped_duplicates} | Errors: ${importResult.errors.length}`);
  }
  if (importResult.errors && importResult.errors.length > 0) {
    lines.push('');
    lines.push(`### Import errors`);
    lines.push('');
    for (const err of importResult.errors) {
      lines.push(`- row ${err.index}: ${mdEscape(err.error)} (${err.email || err.name || ''})`);
    }
  }
  lines.push('');
  lines.push(`## Top candidates (★≥4)`);
  lines.push('');
  const top = candidates.filter(c => (c.quality_score || 0) >= 4).slice(0, 15);
  if (top.length === 0) {
    lines.push(`_No ★≥4 candidates this run._`);
  } else {
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      const ext = c.extracted || {};
      const company = ext.company_name || '(no company)';
      const fit = ext.persona_fit || '?';
      const ev = (c.evidence && Array.isArray(c.evidence.persona_fit) ? c.evidence.persona_fit : (c.evidence && c.evidence.persona_fit)) || '';
      lines.push(`${i + 1}. **★${c.quality_score} ${company}** — ${c.email} (${[ext.location && ext.location.city, ext.location && ext.location.state_or_region].filter(Boolean).join(', ') || 'unknown loc'})`);
      lines.push(`   - persona: \`${c.persona}\` | fit: ${fit} | dedup: \`${c.dedup_status}\`${c.personal_email ? ' | _personal-email_' : ''}`);
      if (ev) lines.push(`   - fit evidence: "${mdEscape(typeof ev === 'string' ? ev : '')}"`);
      lines.push(`   - source: ${c.url}`);
    }
  }
  lines.push('');
  lines.push(`## All candidates`);
  lines.push('');
  lines.push(`See \`candidates.csv\` (sibling file) for the full list including \`existing_*\` and \`suppressed\` rows.`);
  lines.push('');
  lines.push(`## Page type distribution`);
  lines.push('');
  {
    const total = candidates.length;
    if (total === 0) {
      lines.push(`_No rows._`);
    } else {
      const counts = new Map();
      for (const c of candidates) {
        const key = c.page_type || '(empty)';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      lines.push(`| page_type | count | % |`);
      lines.push(`|---|---:|---:|`);
      for (const [key, n] of sorted) {
        const pct = ((n / total) * 100).toFixed(1);
        lines.push(`| \`${mdEscape(key)}\` | ${n} | ${pct}% |`);
      }
    }
  }
  lines.push('');
  lines.push(`## Rejection reasons`);
  lines.push('');
  {
    const rejected = candidates.filter(c => c.page_type !== 'real_planner' || (c.quality_score || 0) < 3);
    const total = rejected.length;
    if (total === 0) {
      lines.push(`_No rows._`);
    } else {
      const counts = new Map();
      for (const c of rejected) {
        const key = c.rejection_reason || '(none)';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      lines.push(`| rejection_reason | count | % |`);
      lines.push(`|---|---:|---:|`);
      for (const [key, n] of sorted) {
        const pct = ((n / total) * 100).toFixed(1);
        lines.push(`| \`${mdEscape(key)}\` | ${n} | ${pct}% |`);
      }
    }
  }
  lines.push('');
  lines.push(`## Cost`);
  lines.push('');
  lines.push(`Brave: $0 (free tier) | Claude (extract): $${costExtract.toFixed(4)} | Total: $${costExtract.toFixed(4)}`);
  lines.push(`Duration: ${(durations.total_ms / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push(`## Reverting this run`);
  lines.push('');
  lines.push('```bash');
  for (const persona of Object.keys(personaSummary)) {
    lines.push(`sqlite3 "$DB_PATH" "DELETE FROM contacts WHERE source='brave_search' AND source_query='${runDate}_${persona}'"`);
  }
  lines.push('```');
  lines.push('');
  lines.push(`## Approval protocol (Sarah review)`);
  lines.push('');
  lines.push(`Sarah: review this report + \`candidates.csv\`. Reply free-form in ${slackChannelName || '#prospector-paulina'} with sign-off or concerns. If extraction quality is unacceptable, run the revert SQL above and let Jason know.`);
  return lines.join('\n');
}

function buildSlackMessage({ runDate, personaSummary, importResult, costExtract, dryRun }) {
  const lines = [];
  lines.push(`🔬 Research run ${runDate}`);
  for (const [p, s] of Object.entries(personaSummary)) {
    lines.push(`• ${p}: searched ${s.searched} → fetched ${s.fetched_ok} → extracted ${s.extracted_ok} | dedup → ${s.dedup.new} new, ${s.dedup.existing_email + s.dedup.existing_domain} existing, ${s.dedup.suppressed} suppressed`);
  }
  if (dryRun) {
    lines.push(`Imported: 0 (dry-run) | Errors: 0`);
  } else {
    lines.push(`Imported: ${importResult.inserted} | Skipped dup: ${importResult.skipped_duplicates} | Errors: ${importResult.errors.length}`);
    if (importResult.errors.length > 0) {
      lines.push(`⚠️ ${importResult.errors.length} rows failed to import — see runs/${runDate}/import-errors.jsonl`);
    }
  }
  lines.push(`Cost: $${costExtract.toFixed(4)}`);
  lines.push(`Report: prospector/research/runs/${runDate}/report.md`);
  lines.push(``);
  lines.push(`Revert:`);
  for (const persona of Object.keys(personaSummary)) {
    lines.push(`sqlite3 "$DB_PATH" "DELETE FROM contacts WHERE source='brave_search' AND source_query='${runDate}_${persona}'"`);
  }
  return lines.join('\n');
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const runDate = args.runDate || todayISODate();
  const dir = runDir(runDate);
  const dedupPath = path.join(dir, '04-deduped.jsonl');
  const fetchesPath = path.join(dir, '02-fetches.jsonl');
  const extractsPath = path.join(dir, '03-extracts.jsonl');
  const searchesPath = path.join(dir, '01-searches.jsonl');
  if (!fs.existsSync(dedupPath)) {
    console.error(`[05-import] missing input ${dedupPath}`);
    process.exit(2);
  }

  const candidates = await readJSONL(dedupPath);
  const allFetches = fs.existsSync(fetchesPath) ? await readJSONL(fetchesPath) : [];
  const allExtracts = fs.existsSync(extractsPath) ? await readJSONL(extractsPath) : [];
  const allSearches = fs.existsSync(searchesPath) ? await readJSONL(searchesPath) : [];

  // Per-persona summary
  const personaSummary = {};
  function bump(persona) {
    if (!personaSummary[persona]) {
      personaSummary[persona] = {
        searched: 0, fetched_ok: 0, extracted_ok: 0,
        dedup: { new: 0, existing_email: 0, existing_domain: 0, suppressed: 0, invalid: 0 },
      };
    }
    return personaSummary[persona];
  }
  for (const r of allSearches) bump(r.persona).searched++;
  for (const r of allFetches) if (r.status === 200) bump(r.persona).fetched_ok++;
  for (const r of allExtracts) if (r.extract_status === 'ok') bump(r.persona).extracted_ok++;
  for (const c of candidates) {
    const s = bump(c.persona);
    s.dedup[c.dedup_status] = (s.dedup[c.dedup_status] || 0) + 1;
  }

  // Build payload from `new` candidates only.
  const newCandidates = candidates.filter(c => c.dedup_status === 'new');
  const payload = newCandidates.map(c => buildContactRow(c, runDate));

  const importResult = { attempted: payload.length, inserted: 0, skipped_duplicates: 0, errors: [], status: 'pending' };
  const importErrorsPath = path.join(dir, 'import-errors.jsonl');

  if (args.dryRun) {
    fs.writeFileSync(importErrorsPath, '');  // empty file; visibility, not surprise
    importResult.status = 'dry_run';
  } else if (payload.length === 0) {
    fs.writeFileSync(importErrorsPath, '');
    importResult.status = 'nothing_to_import';
  } else {
    const res = await postBulkImport(payload);
    importResult.status = res.ok ? 'completed' : 'http_failed';
    importResult.inserted = res.inserted;
    importResult.skipped_duplicates = res.skipped_duplicates;
    importResult.errors = res.errors || [];
    // Surface every error to stderr (no silent partial failure)
    const errOut = fs.createWriteStream(importErrorsPath, { flags: 'w' });
    for (const err of importResult.errors) {
      const idx = (typeof err.index === 'number') ? err.index : -1;
      const attempted = idx >= 0 && idx < payload.length ? payload[idx] : null;
      const email = attempted && attempted.email;
      const name = attempted && attempted.name;
      console.error(`[bulk-import] row ${idx} ${email || name || ''}: ${err.error}`);
      errOut.write(JSON.stringify({
        index: idx,
        email: email || null,
        name: name || null,
        source_query: attempted ? attempted.source_query : null,
        error: err.error,
        attempted_payload: attempted,
      }) + '\n');
    }
    errOut.end();
    await new Promise(res => errOut.on('close', res));
  }

  // candidates.csv (all rows for review, including existing_*/suppressed)
  const csvRows = candidates.map(c => {
    const ext = c.extracted || {};
    return {
      persona: c.persona,
      dedup_status: c.dedup_status,
      quality_score: c.quality_score || '',
      persona_fit: ext.persona_fit || '',
      personal_email: c.personal_email ? '1' : '',
      page_type:                  c.page_type || '',
      rejection_reason:           c.rejection_reason || '',
      destination_work_evidence:  c.destination_work_evidence || '',
      mexico_or_latam_evidence:   c.mexico_or_latam_evidence || '',
      group_size_signal:          c.group_size_signal || '',
      budget_signal:              c.budget_signal || '',
      portfolio_recency_signal:   c.portfolio_recency_signal || '',
      email: c.email || '',
      named_contact: c.named_contact ? c.named_contact.name : '',
      title: c.named_contact ? (c.named_contact.role || '') : '',
      company: ext.company_name || '',
      city: (ext.location && ext.location.city) || '',
      state_or_region: (ext.location && ext.location.state_or_region) || '',
      country: (ext.location && ext.location.country) || '',
      services_offered: Array.isArray(ext.services_offered) ? ext.services_offered.join('; ') : '',
      destinations_served: Array.isArray(ext.destinations_served) ? ext.destinations_served.join('; ') : '',
      role_based_emails: Array.isArray(ext.role_based_emails) ? ext.role_based_emails.join('; ') : '',
      source_url: c.url,
      source: 'brave_search',
      source_query: `${runDate}_${c.persona}`,
    };
  });
  const csvText = stringify(csvRows, {
    header: true,
    columns: [
      'persona', 'dedup_status', 'quality_score', 'persona_fit', 'personal_email',
      'page_type', 'rejection_reason', 'destination_work_evidence', 'mexico_or_latam_evidence',
      'group_size_signal', 'budget_signal', 'portfolio_recency_signal',
      'email', 'named_contact', 'title', 'company',
      'city', 'state_or_region', 'country',
      'services_offered', 'destinations_served', 'role_based_emails',
      'source_url', 'source', 'source_query',
    ],
  });
  fs.writeFileSync(path.join(dir, 'candidates.csv'), csvText);

  // Pull cost from sidecar written by 03-extract
  let costExtract = 0;
  let costCapHit = false;
  const sidecarPath = path.join(dir, '03-extract.meta.json');
  if (fs.existsSync(sidecarPath)) {
    try {
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      costExtract = sidecar.cost_usd || 0;
      costCapHit = !!sidecar.cost_cap_hit;
    } catch (_) {}
  }

  const durations = { total_ms: Date.now() - startedAt };
  const channelName = (cfg.channel_name || '#prospector-paulina');
  const channelTarget = cfg.channel_id ? `channel:${cfg.channel_id}` : channelName;

  // report.md
  const report = buildReport({
    runDate,
    personaSummary,
    candidates,
    importResult,
    costExtract,
    durations,
    dryRun: args.dryRun,
    slackChannelName: channelName,
  });
  fs.writeFileSync(path.join(dir, 'report.md'), report);

  // summary.jsonl (one-line cron-shape rollup, summed across personas)
  const summed = {
    searched: 0, fetched_ok: 0, extracted_ok: 0,
    new: 0, existing: 0, suppressed: 0,
  };
  for (const s of Object.values(personaSummary)) {
    summed.searched += s.searched;
    summed.fetched_ok += s.fetched_ok;
    summed.extracted_ok += s.extracted_ok;
    summed.new += s.dedup.new;
    summed.existing += s.dedup.existing_email + s.dedup.existing_domain;
    summed.suppressed += s.dedup.suppressed;
  }
  const importStatusFinal = (() => {
    if (args.dryRun) return 'dry_run';
    if (importResult.errors.length > 0 && importResult.inserted === 0) return 'failed';
    if (importResult.errors.length > 0) return 'completed_with_errors';
    return 'completed';
  })();

  const summary = {
    ts: new Date().toISOString(),
    run_date: runDate,
    status: importStatusFinal,
    cost_cap_hit: costCapHit,
    personas: Object.keys(personaSummary),
    searched: summed.searched,
    fetched: summed.fetched_ok,
    extracted: summed.extracted_ok,
    new: summed.new,
    existing: summed.existing,
    suppressed: summed.suppressed,
    attempted_import: importResult.attempted,
    inserted: importResult.inserted,
    skipped_duplicates: importResult.skipped_duplicates,
    import_errors: importResult.errors.length,
    cost_usd: Number(costExtract.toFixed(4)),
    durationMs: durations.total_ms,
  };
  fs.writeFileSync(path.join(dir, 'summary.jsonl'), JSON.stringify(summary) + '\n');

  // Slack post (skipped on dry-run)
  if (!args.dryRun) {
    const msg = buildSlackMessage({ runDate, personaSummary, importResult, costExtract, dryRun: false });
    const slackRes = await postToChannel(channelTarget, msg);
    if (!slackRes.ok) {
      console.error(`[05-import] Slack post failed: ${slackRes.error}`);
    } else {
      console.error(`[05-import] Slack posted to ${channelTarget} (${channelName})`);
    }
  } else {
    console.error(`[05-import] DRY-RUN: skipping bulk-import POST and Slack post.`);
  }

  console.error(`[05-import] DONE. status=${importStatusFinal} attempted=${importResult.attempted} inserted=${importResult.inserted} errors=${importResult.errors.length}`);

  // Exit code: non-zero if all attempted imports failed.
  if (importStatusFinal === 'failed') process.exitCode = 5;
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main, buildReport, buildSlackMessage };
