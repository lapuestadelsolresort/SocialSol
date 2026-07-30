#!/usr/bin/env node
'use strict';
//
// index-voice-corpus.js - Phase R, R2
//
// Embeds Sarah-voice messages from sarah_voice_corpus into the Chroma
// "sarah_voice_corpus" collection, then flips embedding_status row-by-row.
//
// Idempotent: driven by `WHERE embedding_status='pending' AND language='en'`.
// Re-runs after success embed zero rows. Failures go to status='failed'
// with the error captured in embedding_error - no silent skip.
//
// Recovery: if the Chroma data dir is wiped, re-running this script after
//   UPDATE sarah_voice_corpus SET embedding_status='pending', embedded_at=NULL
//     WHERE embedding_status='indexed';
// rebuilds everything for ~$0.003 (1,204 messages, text-embedding-3-small).
//
// Usage:
//   node index-voice-corpus.js [options]
//     --dry-run                  Print what would happen; no OpenAI/Chroma writes.
//     --limit=N                  Cap rows processed this run.
//     --model=text-embedding-3-small   (default)
//     --reindex-failed           Also pick up rows where embedding_status='failed'.
//     --verify-idempotency       Run twice; second pass must embed 0.
//     --chroma-url=http://...    Default http://localhost:8000
//     --batch-openai=100         OpenAI inputs per embeddings call.
//     --batch-chroma=200         Chroma docs per upsert call.

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const DB_PATH = process.env.DB_PATH ||
  path.join(__dirname, '..', 'data', 'crm.db');

// ── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    model: 'text-embedding-3-small',
    chromaUrl: 'http://localhost:8000',
    batchOpenAI: 100,
    batchChroma: 200,
  };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2] === undefined ? true : m[2];
    if (k === 'dry-run') out.dryRun = true;
    else if (k === 'limit') out.limit = parseInt(v, 10);
    else if (k === 'model') out.model = String(v);
    else if (k === 'reindex-failed') out.reindexFailed = true;
    else if (k === 'verify-idempotency') out.verifyIdempotency = true;
    else if (k === 'chroma-url') out.chromaUrl = String(v);
    else if (k === 'batch-openai') out.batchOpenAI = parseInt(v, 10);
    else if (k === 'batch-chroma') out.batchChroma = parseInt(v, 10);
    else if (k === 'help' || k === 'h') out.help = true;
  }
  return out;
}

function usage() {
  console.error([
    'Usage: node index-voice-corpus.js [options]',
    '',
    '  --dry-run                  Print plan; no OpenAI / Chroma writes.',
    '  --limit=N                  Cap rows processed.',
    '  --model=<name>             OpenAI embedding model (default text-embedding-3-small).',
    '  --reindex-failed           Pick up failed rows in addition to pending.',
    '  --verify-idempotency       Run twice; second pass asserts 0 embeds.',
    '  --chroma-url=<url>         Chroma server URL (default http://localhost:8000).',
    '',
  ].join('\n'));
}

// ── recipient_relationship derivation ──────────────────────────────────────
// Source of truth: contacts.relationship_type, joined in the SELECT below.
// Derived value is written ONLY into the Chroma metadata for each row;
// the sarah_voice_corpus.recipient_relationship SQLite column exists in
// the schema (migration 006) but is intentionally NEVER populated — the
// indexer is the single derivation site and Chroma is the read surface.
//
// Recovery path: wiping chroma-data and re-running this script (per the
// R2 recovery procedure) re-derives recipient_relationship from the
// JOIN every run. As long as contacts.relationship_type is intact, no
// data is lost. Verified empirically May 7, 2026 against a sample of 7
// rows (5 attributed + 2 orphans) — derived value matched Chroma
// metadata exactly.
//
// Anyone querying sarah_voice_corpus.recipient_relationship directly
// from SQLite will see NULL for every row — that is correct, not a bug.
// To get the real value, JOIN to contacts (see the SELECT in runOnce
// below) or read from Chroma metadata.
//
// NULL contact_id (the 20 R1-orphan rows) -> 'unknown'.
// Per R2 plan: orphans stay in retrieval pool; non-null filters skip them.
function deriveRecipientRelationship(row) {
  if (row.contact_relationship_type) return row.contact_relationship_type;
  return 'unknown';
}

// ── OpenAI embeddings ──────────────────────────────────────────────────────
async function embedBatch(inputs, { model, apiKey }) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: inputs, model }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.data) || json.data.length !== inputs.length) {
    throw new Error(`OpenAI returned ${json.data ? json.data.length : 'no'} embeddings for ${inputs.length} inputs`);
  }
  // Sort by index; OpenAI returns in input order but defensive check is cheap.
  json.data.sort((a, b) => a.index - b.index);
  return {
    embeddings: json.data.map(d => d.embedding),
    promptTokens: (json.usage && json.usage.prompt_tokens) || 0,
    totalTokens: (json.usage && json.usage.total_tokens) || 0,
  };
}

// ── Chroma upsert ──────────────────────────────────────────────────────────
async function chromaUpsert(collection, batch) {
  await collection.upsert({
    ids: batch.map(b => b.id),
    embeddings: batch.map(b => b.embedding),
    documents: batch.map(b => b.body),
    metadatas: batch.map(b => b.metadata),
  });
}

// ── status flip ────────────────────────────────────────────────────────────
async function markIndexed(db, ids, model, embeddedAt) {
  for (const id of ids) {
    await db.query(sql`
      UPDATE sarah_voice_corpus
         SET embedding_status='indexed',
             embedding_model=${model},
             embedded_at=${embeddedAt},
             embedding_error=NULL
       WHERE id=${id}
    `);
  }
}

async function markFailed(db, ids, errorMsg) {
  for (const id of ids) {
    await db.query(sql`
      UPDATE sarah_voice_corpus
         SET embedding_status='failed',
             embedding_error=${errorMsg}
       WHERE id=${id}
    `);
  }
}

// ── core run ───────────────────────────────────────────────────────────────
async function runOnce(opts) {
  const { dryRun, limit, model, chromaUrl, reindexFailed, batchOpenAI, batchChroma } = opts;

  // Key resolution: env (set by index-voice-corpus.sh wrapper) → workspace/secrets/openai.json.
  // The helper centralizes the same fallback chain the wrapper uses, so direct
  // `node index-voice-corpus.js` invocation works without sourcing the wrapper.
  let apiKey = null;
  if (!dryRun) {
    const { getOpenAIKey } = require('../lib/openai-key');
    apiKey = getOpenAIKey();
  }

  // ── DB ───────────────────────────────────────────────────────────────────
  const db = createDB(DB_PATH);

  // Pull rows joined to contacts.relationship_type so we can derive recipient_relationship inline.
  const statusFilter = reindexFailed
    ? sql`(s.embedding_status='pending' OR s.embedding_status='failed')`
    : sql`s.embedding_status='pending'`;
  const limitClause = (Number.isInteger(limit) && limit > 0) ? sql`LIMIT ${limit}` : sql``;

  const rows = await db.query(sql`
    SELECT s.id, s.source, s.source_id, s.message_id, s.contact_id,
           s.source_account_id, s.direction, s.sent_at, s.body,
           s.intent_tags, s.language, s.word_count,
           c.relationship_type AS contact_relationship_type
      FROM sarah_voice_corpus s
      LEFT JOIN contacts c ON c.id = s.contact_id
     WHERE ${statusFilter}
       AND s.language='en'
     ORDER BY s.sent_at ASC, s.id ASC
     ${limitClause}
  `);

  console.log(`[indexer] Found ${rows.length} row(s) to process (model=${model}, dry-run=${!!dryRun})`);
  if (rows.length === 0) {
    await db.dispose();
    return { embedded: 0, failed: 0, skipped: 0, totalTokens: 0 };
  }

  // ── Chroma ──────────────────────────────────────────────────────────────
  // Same retry-with-backoff pattern as crm/server.js initChroma, so the
  // launchd-scheduled indexer absorbs reboot races against the chroma daemon.
  let collection = null;
  if (!dryRun) {
    const { connectWithRetry } = require('../lib/chroma-connect');
    const client = await connectWithRetry({ url: chromaUrl, label: 'indexer' });
    collection = await client.getOrCreateCollection({ name: 'sarah_voice_corpus' });
  }

  // ── Process in OpenAI-sized batches ──────────────────────────────────────
  let embedded = 0, failed = 0, totalTokens = 0;
  const pendingChroma = []; // accumulate up to batchChroma before upserting

  async function flushChroma() {
    if (pendingChroma.length === 0) return;
    if (dryRun) {
      console.log(`[indexer] [dry-run] would Chroma-upsert ${pendingChroma.length} docs`);
      pendingChroma.length = 0;
      return;
    }
    try {
      await chromaUpsert(collection, pendingChroma);
      const ids = pendingChroma.map(p => p.id);
      const embeddedAt = new Date().toISOString();
      await markIndexed(db, ids, model, embeddedAt);
      embedded += pendingChroma.length;
      console.log(`[indexer] Upserted ${pendingChroma.length} -> Chroma; flipped status=indexed`);
    } catch (e) {
      const ids = pendingChroma.map(p => p.id);
      await markFailed(db, ids, `chroma upsert: ${e.message}`.slice(0, 1000));
      failed += pendingChroma.length;
      console.warn(`[indexer] Chroma upsert FAILED for ${pendingChroma.length} rows: ${e.message}`);
    }
    pendingChroma.length = 0;
  }

  for (let i = 0; i < rows.length; i += batchOpenAI) {
    const slice = rows.slice(i, i + batchOpenAI);
    const inputs = slice.map(r => r.body);
    const ids = slice.map(r => String(r.id));

    if (dryRun) {
      console.log(`[indexer] [dry-run] OpenAI batch ${Math.floor(i / batchOpenAI) + 1}: ` +
        `${slice.length} inputs, ` +
        `${inputs.reduce((s, x) => s + x.length, 0)} chars total, ` +
        `first id=${ids[0]} (sent_at=${slice[0].sent_at})`);
      // Accumulate placeholder metadata for the dry-run upsert log
      for (const r of slice) {
        pendingChroma.push({
          id: String(r.id),
          embedding: null,
          body: r.body,
          metadata: buildMetadata(r),
        });
        if (pendingChroma.length >= batchChroma) await flushChroma();
      }
      continue;
    }

    let result;
    try {
      result = await embedBatch(inputs, { model, apiKey });
    } catch (e) {
      await markFailed(db, slice.map(r => r.id), `openai: ${e.message}`.slice(0, 1000));
      failed += slice.length;
      console.warn(`[indexer] OpenAI batch FAILED for ${slice.length} rows: ${e.message}`);
      continue;
    }

    totalTokens += result.totalTokens;
    for (let j = 0; j < slice.length; j++) {
      pendingChroma.push({
        id: String(slice[j].id),
        embedding: result.embeddings[j],
        body: slice[j].body,
        metadata: buildMetadata(slice[j]),
      });
      if (pendingChroma.length >= batchChroma) await flushChroma();
    }
  }

  await flushChroma();
  await db.dispose();

  return { embedded, failed, skipped: 0, totalTokens };
}

function buildMetadata(row) {
  // Chroma metadata supports primitive types only (string|number|bool).
  // Coerce nullables to defaults that are safe to filter on.
  const md = {
    source: String(row.source),
    source_id: String(row.source_id),
    message_id: String(row.message_id),
    source_account_id: row.source_account_id == null ? 0 : Number(row.source_account_id),
    language: String(row.language),
    sent_at: String(row.sent_at),
    word_count: Number(row.word_count),
    recipient_relationship: deriveRecipientRelationship(row),
  };
  if (row.contact_id != null) md.contact_id = Number(row.contact_id);
  if (row.intent_tags) md.intent_tags = String(row.intent_tags);
  return md;
}

// ── entry ──────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return 0; }

  const t0 = Date.now();
  const r1 = await runOnce(opts);
  const dt1 = ((Date.now() - t0) / 1000).toFixed(1);
  const cost = (r1.totalTokens * 0.02 / 1_000_000).toFixed(4); // $0.02/M for text-embedding-3-small
  console.log(`[indexer] Pass 1: embedded=${r1.embedded} failed=${r1.failed} tokens=${r1.totalTokens} cost~=$${cost} time=${dt1}s`);

  if (opts.verifyIdempotency) {
    console.log(`[indexer] --verify-idempotency: running pass 2...`);
    const t2 = Date.now();
    const r2 = await runOnce(Object.assign({}, opts, { verifyIdempotency: false }));
    const dt2 = ((Date.now() - t2) / 1000).toFixed(1);
    console.log(`[indexer] Pass 2: embedded=${r2.embedded} failed=${r2.failed} tokens=${r2.totalTokens} time=${dt2}s`);
    if (r2.embedded !== 0) {
      console.error(`[indexer] FAIL: pass 2 embedded ${r2.embedded} rows; expected 0`);
      return 2;
    }
    console.log(`[indexer] OK: idempotent (pass 2 embedded 0 rows)`);
  }
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code || 0)).catch(e => {
    console.error('[indexer] FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { parseArgs, deriveRecipientRelationship, buildMetadata, runOnce };
