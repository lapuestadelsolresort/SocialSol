#!/usr/bin/env node
'use strict';
//
// extract-guest-dossiers.js — R4: one-shot Sonnet 4.6 dossier extraction
// from Airbnb messages.json into guest_dossiers (migration 009 schema).
//
// Eligibility filter (re-derived; R1 didn't persist these lists):
//   Drop threads with ZERO messages from {121885415, 510010203} (the 30
//     threads that have no Sarah-side reply: 5 ops-only + 25 auto-system).
//   Drop threads whose only guest accountId isn't in the 218-contact directory.
//   Pre-defer threads where BOTH guest text AND host text trip detectLanguage='es'
//     (3 threads) — write extraction_status='deferred_spanish', no Sonnet call.
//
// Two-phase gate per the R1 directive ("Spot-check sample of 20 manually
// before trusting outputs"):
//   --sample 20    runs on 20 stride-sampled threads, writes reviewed_by_human=0
//   (manual)       Jason inspects, sets reviewed_by_human=1 on the keepers
//   --confirm-sample-reviewed  required for the full run; refuses to start
//                              if any sampled rows still have reviewed_by_human=0
//
// Retry policy: 3 attempts (2s, 8s) on transient (429/5xx/timeout). Non-retryable
// (4xx, json_parse, schema_validation) terminates immediately and writes
// extraction_failed with last_attempt_error='<category>: <message>'.
//
// Usage:
//   node extract-guest-dossiers.js --export-dir ~/Desktop/Airbnb_data_request_02May2026_GMT --sample 20
//   node extract-guest-dossiers.js --export-dir ~/Desktop/Airbnb_data_request_02May2026_GMT \
//       --confirm-sample-reviewed --max-cost-usd 25
//   node extract-guest-dossiers.js --export-dir ... --retry-failed
//
// Cost (estimated): ~$15–20 for the full 155-thread pass.

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const Anthropic = require('@anthropic-ai/sdk');
const { getAnthropicKey } = require('../lib/anthropic-key');
const lib = require('./lib/dossier-extract');
const airbnbLib = require('./lib/airbnb-export');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crm.db');
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const HOST_ACCOUNT_IDS = new Set([121885415, 510010203]);
const OPS_ACCOUNT_ID = 558059521;

// Sonnet 4.6 pricing (per 1M tokens). Mirrors voice-draft.js:121 computeCost.
const PRICE = { input: 3.0, output: 15.0, cache_read: 0.30, cache_write: 3.75 };

function computeCost(usage) {
  const i = usage.input_tokens || 0;
  const o = usage.output_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  return (i * PRICE.input / 1e6) + (o * PRICE.output / 1e6)
       + (cw * PRICE.cache_write / 1e6) + (cr * PRICE.cache_read / 1e6);
}

// ── Args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { maxCostUsd: 25 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2] != null ? m[2] : argv[++i];
    if (key === 'export-dir') out.exportDir = val;
    else if (key === 'sample') out.sample = parseInt(val, 10);
    else if (key === 'limit') out.limit = parseInt(val, 10);
    else if (key === 'max-cost-usd') out.maxCostUsd = parseFloat(val);
    else if (key === 'confirm-sample-reviewed') { out.confirmSampleReviewed = true; if (val !== undefined) i--; }
    else if (key === 'retry-failed') { out.retryFailed = true; if (val !== undefined) i--; }
    else if (key === 'dry-run') { out.dryRun = true; if (val !== undefined) i--; }
    else if (key === 'force') { out.force = true; if (val !== undefined) i--; }
    else if (key === 'help' || key === 'h') out.help = true;
  }
  return out;
}

function usage() {
  console.error(`Usage:
  --export-dir <path>            REQUIRED — path to Airbnb_data_request_*/  directory
  --sample N                     run on N stride-sampled eligible threads (sample mode)
  --confirm-sample-reviewed      required for full run; refuses if sample rows are unreviewed
  --retry-failed                 only re-attempt rows with extraction_status='extraction_failed'
  --limit N                      cap total threads processed (debugging)
  --max-cost-usd N               abort if running cost exceeds N (default: 25)
  --force                        replace existing 'extracted' rows
  --dry-run                      print eligibility math + first input block, exit
  -h, --help                     show this`);
}

// ── Eligibility ───────────────────────────────────────────────────────────
function loadMessagesJson(exportDir) {
  const p = path.join(exportDir, 'json', 'messages.json');
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('messages.json: expected non-empty array');
  }
  const threads = parsed[0].messageThreads;
  if (!Array.isArray(threads)) {
    throw new Error('messages.json: expected messageThreads array at parsed[0].messageThreads');
  }
  return threads;
}

function classifyThread(thread, contactsByAccountId) {
  // Reasons (mutually exclusive, in priority order):
  //   'no_host'       — no message from Sarah's host accounts
  //   'unmapped'      — no guest accountId is in our 218-contact directory
  //   'eligible'      — all good
  let hasHost = false;
  const guestAccountIds = new Set();
  for (const env of (thread.messagesAndContents || [])) {
    const m = env && env.message;
    if (!m || m.accountType === 'service' || m.accountId == null) continue;
    if (HOST_ACCOUNT_IDS.has(m.accountId)) {
      hasHost = true;
    } else if (m.accountId !== OPS_ACCOUNT_ID) {
      guestAccountIds.add(m.accountId);
    }
  }
  if (!hasHost) return { reason: 'no_host', contactIds: [] };
  const matchedContactIds = [];
  for (const accId of guestAccountIds) {
    const cid = contactsByAccountId.get(accId);
    if (cid != null) matchedContactIds.push(cid);
  }
  if (matchedContactIds.length === 0) return { reason: 'unmapped', contactIds: [] };
  return { reason: 'eligible', contactIds: matchedContactIds };
}

// Stride-sampling: deterministic, evenly spread across thread IDs.
// Sort eligible threads by thread.id, take indices [0, k, 2k, ...] where
// k = floor(N_eligible / N_sample).
function strideSample(threads, n) {
  if (n >= threads.length) return [...threads];
  const sorted = [...threads].sort((a, b) => Number(a.thread.id) - Number(b.thread.id));
  const stride = Math.max(1, Math.floor(sorted.length / n));
  const picked = [];
  for (let i = 0; i < sorted.length && picked.length < n; i += stride) {
    picked.push(sorted[i]);
  }
  return picked;
}

// ── Sonnet API call (with retry) ──────────────────────────────────────────
async function callSonnetWithRetry(client, threadInputBlock) {
  const DELAYS_MS = [2000, 8000]; // 2 attempts of retry after the initial → 3 total
  let lastErr = null;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = DELAYS_MS[attempt - 1];
      // Honor Retry-After header if present on a 429/5xx.
      const retryAfter = lastErr && lastErr.headers && parseInt(lastErr.headers['retry-after'] || '0', 10) * 1000;
      const wait = Math.max(delay, retryAfter || 0);
      await sleep(wait);
    }
    try {
      // No output_config.format — the dossier schema's compiled grammar
      // exceeds Anthropic's size limit ("The compiled grammar is too large"
      // 400 with 14 fields × triple-shape × enum lists). Prompt + post-parse
      // validateDossierJson is the second wall; same approach voice-draft.js
      // uses. effort='low' is still useful for the chat-shaped output.
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: [
          { type: 'text', text: lib.SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: threadInputBlock }],
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
      });
      return resp;
    } catch (e) {
      lastErr = e;
      const cls = lib.classifyApiError(e);
      if (!cls.retryable || attempt === DELAYS_MS.length) {
        // Attach category for upstream classification.
        e._classified = cls;
        throw e;
      }
      console.warn(`[r4] attempt ${attempt + 1}/${DELAYS_MS.length + 1} failed (${cls.category}): ${e.message}; retrying...`);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Per-thread extraction ─────────────────────────────────────────────────
async function extractOne(client, { thread, contactIds, contactsByThread }) {
  const contacts = contactsByThread.get(thread.id) || [];
  const block = lib.buildThreadInputBlock({
    thread,
    contacts,
    hostAccountIds: HOST_ACCOUNT_IDS,
    opsAccountId: OPS_ACCOUNT_ID,
  });

  let resp;
  try {
    resp = await callSonnetWithRetry(client, block.text);
  } catch (e) {
    const cls = e._classified || lib.classifyApiError(e);
    return {
      ok: false,
      row: lib.flattenForInsert({
        parsed: null,
        airbnbThreadId: thread.id,
        contactIds,
        model: MODEL,
        status: 'extraction_failed',
        lastError: `${cls.category}: ${truncateMsg(e.message)}`,
      }),
      usage: {},
      category: cls.category,
      message: e.message,
    };
  }

  // Truncation guard: stop_reason='max_tokens' is treated as failure even
  // if JSON happened to parse, because subtle truncation (a citations array
  // ending one ID short) would slip past the validator.
  if (resp.stop_reason === 'max_tokens') {
    return {
      ok: false,
      row: lib.flattenForInsert({
        parsed: null,
        airbnbThreadId: thread.id,
        contactIds,
        model: MODEL,
        status: 'extraction_failed',
        lastError: 'max_tokens_truncation: stop_reason=max_tokens; bump max_tokens or simplify thread',
      }),
      usage: resp.usage || {},
      category: 'max_tokens_truncation',
      message: 'output truncated at max_tokens=8192',
    };
  }

  // Parse + validate.
  const textBlocks = (resp.content || []).filter(b => b.type === 'text');
  let text = textBlocks.map(b => b.text).join('').trim();
  // Defensive: strip ```json ... ``` fences if Sonnet ignored the "no code
  // fences" rule. Without API-side schema enforcement, this happens occasionally.
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      row: lib.flattenForInsert({
        parsed: null,
        airbnbThreadId: thread.id,
        contactIds,
        model: MODEL,
        status: 'extraction_failed',
        lastError: `json_parse: ${truncateMsg(e.message)}`,
      }),
      usage: resp.usage || {},
      category: 'json_parse',
      message: e.message,
    };
  }
  try {
    lib.validateDossierJson(parsed);
  } catch (e) {
    return {
      ok: false,
      row: lib.flattenForInsert({
        parsed: null,
        airbnbThreadId: thread.id,
        contactIds,
        model: MODEL,
        status: 'extraction_failed',
        lastError: `schema_validation: ${truncateMsg(e.message)}`,
      }),
      usage: resp.usage || {},
      category: 'schema_validation',
      message: e.message,
    };
  }

  // Sonnet may itself return deferred_spanish even though we pre-filter the
  // 3 strictly-Spanish threads. Honor whatever status it picked.
  const row = lib.flattenForInsert({
    parsed,
    airbnbThreadId: thread.id,
    contactIds,
    model: MODEL,
    status: parsed.extraction_status,
    lastError: null,
  });

  return { ok: true, row, usage: resp.usage || {}, category: 'extracted' };
}

function truncateMsg(s) {
  return String(s || '').slice(0, 500);
}

// ── DB writes ─────────────────────────────────────────────────────────────
const ALL_COLS = [
  'airbnb_thread_id', 'contact_ids',
  'trip_purpose', 'trip_purpose_confidence', 'trip_purpose_source_message_ids',
  'why_no_book', 'why_no_book_confidence', 'why_no_book_source_message_ids',
  'decision_timeline', 'decision_timeline_confidence', 'decision_timeline_source_message_ids',
  'language', 'language_confidence', 'language_source_message_ids',
  'excitement_signals', 'excitement_signals_confidence', 'excitement_signals_source_message_ids',
  'objections', 'objections_confidence', 'objections_source_message_ids',
  'specific_features_mentioned', 'specific_features_mentioned_confidence', 'specific_features_mentioned_source_message_ids',
  'dates_targeted', 'dates_targeted_confidence', 'dates_targeted_source_message_ids',
  'group_dynamics', 'group_dynamics_confidence', 'group_dynamics_source_message_ids',
  'geographic_hints', 'geographic_hints_confidence', 'geographic_hints_source_message_ids',
  'communication_style', 'communication_style_confidence', 'communication_style_source_message_ids',
  'occasion_anniversary_date', 'occasion_anniversary_date_confidence', 'occasion_anniversary_date_source_message_ids',
  'notes_for_sarah', 'notes_for_sarah_confidence', 'notes_for_sarah_source_message_ids',
  'extraction_status', 'last_attempt_error', 'reviewed_by_human', 'extraction_model',
];

async function upsertRow(db, row) {
  // INSERT OR REPLACE — idempotent on PK (airbnb_thread_id).
  // updated_at refreshed; created_at preserved by SQLite default (the column
  // default fires on insert; on REPLACE it's a fresh insert so created_at
  // also resets — that's fine for this one-shot, no historical query).
  const cols = ALL_COLS;
  const valuesSql = sql.join(cols.map(c => sql`${row[c]}`), sql`, `);
  const colsSql = sql.__dangerous__rawValue(cols.join(', '));
  await db.query(sql`
    INSERT OR REPLACE INTO guest_dossiers (${colsSql}, updated_at)
    VALUES (${valuesSql}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.exportDir) {
    usage();
    return opts.help ? 0 : 1;
  }
  if (opts.sample && opts.confirmSampleReviewed) {
    console.error('[r4] --sample and --confirm-sample-reviewed are mutually exclusive');
    return 1;
  }

  const isFullRun = !opts.sample && !opts.retryFailed;

  const db = createDB(DB_PATH);

  // Sample-gate enforcement (skipped in dry-run; no writes happen).
  if (isFullRun && !opts.confirmSampleReviewed && !opts.dryRun) {
    console.error('[r4] full run requires --confirm-sample-reviewed (or use --sample N to run sample mode first)');
    await db.dispose();
    return 1;
  }
  if (isFullRun && !opts.dryRun) {
    const unreviewed = await db.query(sql`
      SELECT COUNT(*) AS n FROM guest_dossiers
      WHERE reviewed_by_human=0 AND extraction_status='extracted'
    `);
    const n = (unreviewed && unreviewed[0] && unreviewed[0].n) || 0;
    if (n > 0) {
      console.error(`[r4] ABORT: ${n} 'extracted' rows still have reviewed_by_human=0.`);
      console.error(`[r4] Inspect them, then UPDATE guest_dossiers SET reviewed_by_human=1 WHERE airbnb_thread_id IN (...)`);
      await db.dispose();
      return 1;
    }
  }

  // Load contacts → accountId map + per-contact metadata.
  const contactRows = await db.query(sql`
    SELECT id, name, airbnb_account_id, airbnb_thread_id, relationship_type, last_stay_date, review_rating
      FROM contacts
     WHERE airbnb_account_id IS NOT NULL
  `);
  const contactsByAccountId = new Map(contactRows.map(c => [c.airbnb_account_id, c.id]));
  const contactsById = new Map(contactRows.map(c => [c.id, c]));

  console.log(`[r4] Loaded ${contactRows.length} contacts with airbnb_account_id`);

  // Load messages.json.
  const threads = loadMessagesJson(opts.exportDir);
  console.log(`[r4] Loaded ${threads.length} threads from messages.json`);

  // Classify threads.
  const eligible = []; // { thread, contactIds }
  const counts = { total: threads.length, no_host: 0, unmapped: 0, eligible: 0, deferred_spanish: 0 };
  const deferredSpanish = []; // { thread, contactIds }
  for (const thread of threads) {
    const cls = classifyThread(thread, contactsByAccountId);
    counts[cls.reason] = (counts[cls.reason] || 0) + 1;
    if (cls.reason !== 'eligible') continue;
    if (lib.isStrictlySpanish(thread, HOST_ACCOUNT_IDS, airbnbLib.detectLanguage)) {
      deferredSpanish.push({ thread, contactIds: cls.contactIds });
      counts.deferred_spanish += 1;
      counts.eligible -= 1; // shift from eligible→deferred
    } else {
      eligible.push({ thread, contactIds: cls.contactIds });
    }
  }
  // counts.eligible was incremented by the cls.reason='eligible' loop above;
  // strictly-Spanish threads were re-classified after the fact, so undo that.
  counts.eligible = eligible.length;

  // Build contactsByThread (for buildThreadInputBlock).
  const contactsByThread = new Map();
  for (const entry of [...eligible, ...deferredSpanish]) {
    contactsByThread.set(entry.thread.id, entry.contactIds.map(cid => contactsById.get(cid)).filter(Boolean));
  }

  console.log(`[r4] Eligibility: total=${counts.total} eligible=${counts.eligible} deferred_spanish=${counts.deferred_spanish} no_host=${counts.no_host} unmapped=${counts.unmapped}`);

  // Pre-write deferred_spanish rows (no Sonnet call).
  let deferredWritten = 0;
  if (!opts.dryRun && !opts.retryFailed) {
    for (const { thread, contactIds } of deferredSpanish) {
      const row = lib.flattenForInsert({
        parsed: null,
        airbnbThreadId: thread.id,
        contactIds,
        model: MODEL,
        status: 'deferred_spanish',
        lastError: null,
      });
      await upsertRow(db, row);
      deferredWritten += 1;
    }
    if (deferredWritten > 0) console.log(`[r4] Wrote ${deferredWritten} deferred_spanish rows.`);
  }

  // Select target set.
  let targets;
  if (opts.retryFailed) {
    const failedRows = await db.query(sql`
      SELECT airbnb_thread_id FROM guest_dossiers WHERE extraction_status='extraction_failed'
    `);
    const failedIds = new Set(failedRows.map(r => String(r.airbnb_thread_id)));
    targets = eligible.filter(e => failedIds.has(String(e.thread.id)));
    console.log(`[r4] --retry-failed: ${targets.length} threads queued`);
  } else if (opts.sample) {
    targets = strideSample(eligible, opts.sample);
    console.log(`[r4] --sample ${opts.sample}: ${targets.length} stride-sampled threads queued`);
  } else {
    targets = eligible;
    console.log(`[r4] full run: ${targets.length} threads queued`);
  }
  if (opts.limit && opts.limit > 0) targets = targets.slice(0, opts.limit);

  // Skip already-extracted rows (unless --force).
  if (!opts.force && !opts.retryFailed) {
    const existingRows = await db.query(sql`
      SELECT airbnb_thread_id FROM guest_dossiers WHERE extraction_status='extracted'
    `);
    const existingIds = new Set(existingRows.map(r => String(r.airbnb_thread_id)));
    const before = targets.length;
    targets = targets.filter(t => !existingIds.has(String(t.thread.id)));
    if (before !== targets.length) {
      console.log(`[r4] skip-existing: ${before - targets.length} already extracted; ${targets.length} remaining`);
    }
  }

  if (opts.dryRun) {
    console.log(`[r4] [dry-run] would extract ${targets.length} threads`);
    if (targets.length > 0) {
      const sample = targets[0];
      const block = lib.buildThreadInputBlock({
        thread: sample.thread,
        contacts: contactsByThread.get(sample.thread.id) || [],
        hostAccountIds: HOST_ACCOUNT_IDS,
        opsAccountId: OPS_ACCOUNT_ID,
      });
      console.log(`[r4] [dry-run] first input block (thread=${sample.thread.id}, ${block.charCount} chars, ${block.messageCount} msgs):`);
      console.log('---');
      console.log(block.text);
      console.log('---');
    }
    await db.dispose();
    return 0;
  }

  if (targets.length === 0) {
    console.log('[r4] nothing to extract — done');
    await db.dispose();
    return 0;
  }

  // Sonnet client.
  const client = new Anthropic({ apiKey: getAnthropicKey() });

  // Run.
  const summary = {
    extracted: 0, deferred_spanish: deferredWritten, extraction_failed: 0,
    by_failure_category: {},
    cost: 0.0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    durations: [],
  };

  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i];
    const t0 = Date.now();
    let result;
    try {
      result = await extractOne(client, { thread: tgt.thread, contactIds: tgt.contactIds, contactsByThread });
    } catch (e) {
      // extractOne already catches and returns ok:false; this is for unexpected throws.
      console.error(`[r4] thread ${tgt.thread.id} unexpected error: ${e.message}`);
      result = {
        ok: false,
        row: lib.flattenForInsert({
          parsed: null, airbnbThreadId: tgt.thread.id, contactIds: tgt.contactIds,
          model: MODEL, status: 'extraction_failed',
          lastError: `api_other: ${truncateMsg(e.message)}`,
        }),
        usage: {}, category: 'api_other',
      };
    }
    const dt = Date.now() - t0;
    summary.durations.push(dt);

    // Tally tokens + cost.
    summary.tokens.input += result.usage.input_tokens || 0;
    summary.tokens.output += result.usage.output_tokens || 0;
    summary.tokens.cache_read += result.usage.cache_read_input_tokens || 0;
    summary.tokens.cache_write += result.usage.cache_creation_input_tokens || 0;
    summary.cost += computeCost(result.usage || {});

    // Tally outcome.
    if (result.ok) {
      const status = result.row.extraction_status;
      summary[status] = (summary[status] || 0) + 1;
    } else {
      summary.extraction_failed += 1;
      summary.by_failure_category[result.category] = (summary.by_failure_category[result.category] || 0) + 1;
    }

    await upsertRow(db, result.row);

    // Progress log every 10 threads.
    if ((i + 1) % 10 === 0 || i === targets.length - 1) {
      console.log(`[r4] ${i + 1}/${targets.length}: extracted=${summary.extracted} failed=${summary.extraction_failed} cost=$${summary.cost.toFixed(3)}`);
    }

    // Cost cap.
    if (summary.cost > opts.maxCostUsd) {
      console.error(`[r4] ABORT: running cost $${summary.cost.toFixed(3)} exceeded --max-cost-usd ${opts.maxCostUsd}`);
      break;
    }
  }

  await db.dispose();

  // Summary.
  const dur = summary.durations.sort((a, b) => a - b);
  const p50 = dur.length ? dur[Math.floor(dur.length * 0.5)] : 0;
  const p95 = dur.length ? dur[Math.floor(dur.length * 0.95)] : 0;
  console.log('');
  console.log('[r4] ============================================');
  console.log(`[r4] DONE: extracted=${summary.extracted} deferred_spanish=${summary.deferred_spanish} extraction_failed=${summary.extraction_failed}`);
  console.log(`[r4] cost: $${summary.cost.toFixed(4)}`);
  console.log(`[r4] tokens: input=${summary.tokens.input} output=${summary.tokens.output} cache_read=${summary.tokens.cache_read} cache_write=${summary.tokens.cache_write}`);
  console.log(`[r4] duration: p50=${p50}ms p95=${p95}ms total_threads=${summary.durations.length}`);
  if (summary.extraction_failed > 0) {
    console.log(`[r4] failure categories: ${JSON.stringify(summary.by_failure_category)}`);
    console.log('[r4]   inspect: SELECT airbnb_thread_id, last_attempt_error FROM guest_dossiers WHERE extraction_status=\'extraction_failed\';');
  }
  if (opts.sample) {
    console.log('');
    console.log(`[r4] Sample mode complete. Inspect the rows, then:`);
    console.log(`[r4]   sqlite3 ${DB_PATH} "UPDATE guest_dossiers SET reviewed_by_human=1 WHERE airbnb_thread_id IN ('...');"`);
    console.log(`[r4] then re-run with --confirm-sample-reviewed for the full pass.`);
  }
  return 0;
}

if (require.main === module) {
  main().then(c => process.exit(c || 0)).catch(e => {
    console.error('[r4] FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  classifyThread,
  strideSample,
  computeCost,
  HOST_ACCOUNT_IDS,
  OPS_ACCOUNT_ID,
  MODEL,
};
