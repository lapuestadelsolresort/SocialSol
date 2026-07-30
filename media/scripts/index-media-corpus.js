#!/usr/bin/env node
'use strict';
//
// index-media-corpus.js — embeds media_clip_synopses rows into the
// Chroma "media_corpus" collection, then flips embedding_status row-by-row.
// Mirrors crm/scripts/index-voice-corpus.js (same OpenAI model, same
// retry-with-backoff Chroma client, same idempotency model).
//
// Driven by `WHERE embedding_status='pending'`. Recovery: clear the
// chroma-data dir, run
//   UPDATE media_clip_synopses SET embedding_status='pending', embedded_at=NULL;
// and re-run; rebuilds the index for ~$0.001 per clip.
//
// Usage:
//   node index-media-corpus.js [--dry-run] [--limit=N] [--reindex-failed]
//     [--chroma-url=http://localhost:8000]

const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const DB_PATH = process.env.DB_PATH
  || path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');

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
    else if (k === 'reindex-failed') out.reindexFailed = true;
    else if (k === 'chroma-url') out.chromaUrl = String(v);
    else if (k === 'model') out.model = String(v);
  }
  return out;
}

async function embedBatch(inputs, { model, apiKey }) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: inputs, model }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.data) || json.data.length !== inputs.length) {
    throw new Error(`OpenAI returned ${json.data ? json.data.length : 'no'} for ${inputs.length}`);
  }
  json.data.sort((a, b) => a.index - b.index);
  return {
    embeddings: json.data.map(d => d.embedding),
    totalTokens: (json.usage && json.usage.total_tokens) || 0,
  };
}

function buildMetadata(row) {
  const md = {
    asset_id: Number(row.asset_id),
    shoot_id: Number(row.shoot_id),
    source_role: String(row.source_role),
    kind: String(row.kind),
    duration_ms: row.duration_ms == null ? 0 : Number(row.duration_ms),
    width: row.width == null ? 0 : Number(row.width),
    height: row.height == null ? 0 : Number(row.height),
    usable: 1,
  };
  // Flatten tag categories to simple comma-separated strings for Chroma
  // metadata filtering (Chroma only supports primitives).
  if (row.tags_json) {
    try {
      const t = JSON.parse(row.tags_json);
      if (Array.isArray(t.setting)) md.setting = t.setting.join(',');
      if (Array.isArray(t.mood)) md.mood = t.mood.join(',');
      if (Array.isArray(t.camera_motion)) md.camera_motion = t.camera_motion.join(',');
      if (t.people) md.people = String(t.people);
      if (t.time_of_day) md.time_of_day = String(t.time_of_day);
    } catch {}
  }
  if (row.persona_fit_json) {
    try {
      const pf = JSON.parse(row.persona_fit_json);
      for (const [k, v] of Object.entries(pf)) {
        const num = Number(v);
        if (Number.isFinite(num)) md[`pf_${k}`] = num;
      }
    } catch {}
  }
  return md;
}

async function main() {
  const opts = parseArgs(process.argv);
  let apiKey = null;
  if (!opts.dryRun) {
    const { getOpenAIKey } = require('../../crm/lib/openai-key');
    apiKey = getOpenAIKey();
  }
  const db = createDB(DB_PATH);

  const statusFilter = opts.reindexFailed
    ? sql`(cs.embedding_status='pending' OR cs.embedding_status='failed')`
    : sql`cs.embedding_status='pending'`;
  const limitClause = opts.limit ? sql`LIMIT ${opts.limit}` : sql``;

  const rows = await db.query(sql`
    SELECT cs.id, cs.asset_id, cs.synopsis, cs.searchable_text,
           cs.tags_json, cs.persona_fit_json,
           a.shoot_id, a.source_role, a.kind, a.duration_ms, a.width, a.height
      FROM media_clip_synopses cs
      JOIN media_assets a ON a.id = cs.asset_id
     WHERE ${statusFilter}
     ORDER BY cs.id
     ${limitClause}
  `);
  console.log(`[media-indexer] ${rows.length} synopsis row(s) pending`);
  if (rows.length === 0) { await db.dispose(); return; }

  let collection = null;
  if (!opts.dryRun) {
    const { connectWithRetry } = require('../../crm/lib/chroma-connect');
    const client = await connectWithRetry({ url: opts.chromaUrl, label: 'media-indexer' });
    collection = await client.getOrCreateCollection({ name: 'media_corpus' });
  }

  let embedded = 0, failed = 0, totalTokens = 0;
  const pending = [];

  async function flushChroma() {
    if (!pending.length) return;
    if (opts.dryRun) {
      console.log(`[media-indexer] [dry-run] would upsert ${pending.length} docs`);
      pending.length = 0;
      return;
    }
    try {
      await collection.upsert({
        ids: pending.map(p => p.id),
        embeddings: pending.map(p => p.embedding),
        documents: pending.map(p => p.body),
        metadatas: pending.map(p => p.metadata),
      });
      const embeddedAt = new Date().toISOString();
      for (const p of pending) {
        await db.query(sql`
          UPDATE media_clip_synopses
             SET embedding_status='indexed',
                 embedding_model=${opts.model},
                 embedded_at=${embeddedAt},
                 embedding_error=NULL
           WHERE id=${p.row_id}
        `);
        await db.query(sql`UPDATE media_assets SET status='indexed' WHERE id=${p.metadata.asset_id}`);
      }
      embedded += pending.length;
    } catch (e) {
      for (const p of pending) {
        await db.query(sql`UPDATE media_clip_synopses SET embedding_status='failed', embedding_error=${`chroma: ${e.message}`.slice(0, 500)} WHERE id=${p.row_id}`);
      }
      failed += pending.length;
      console.warn(`[media-indexer] Chroma upsert FAILED for ${pending.length}: ${e.message}`);
    }
    pending.length = 0;
  }

  for (let i = 0; i < rows.length; i += opts.batchOpenAI) {
    const slice = rows.slice(i, i + opts.batchOpenAI);
    if (opts.dryRun) {
      for (const r of slice) pending.push({ row_id: r.id, id: `media_${r.asset_id}`, embedding: null, body: r.searchable_text, metadata: buildMetadata(r) });
      if (pending.length >= opts.batchChroma) await flushChroma();
      continue;
    }
    let result;
    try { result = await embedBatch(slice.map(r => r.searchable_text), { model: opts.model, apiKey }); }
    catch (e) {
      for (const r of slice) await db.query(sql`UPDATE media_clip_synopses SET embedding_status='failed', embedding_error=${`openai: ${e.message}`.slice(0, 500)} WHERE id=${r.id}`);
      failed += slice.length;
      console.warn(`[media-indexer] OpenAI batch FAILED: ${e.message}`);
      continue;
    }
    totalTokens += result.totalTokens;
    for (let j = 0; j < slice.length; j++) {
      pending.push({
        row_id: slice[j].id,
        id: `media_${slice[j].asset_id}`,
        embedding: result.embeddings[j],
        body: slice[j].searchable_text,
        metadata: buildMetadata(slice[j]),
      });
      if (pending.length >= opts.batchChroma) await flushChroma();
    }
  }
  await flushChroma();

  const cost = (totalTokens * 0.02 / 1_000_000).toFixed(5);
  console.log(`[media-indexer] done. embedded=${embedded} failed=${failed} tokens=${totalTokens} cost=$${cost}`);
  await db.dispose();
}

if (require.main === module) {
  main().catch((e) => { console.error('[media-indexer] FATAL:', e.message); console.error(e.stack); process.exit(1); });
}
