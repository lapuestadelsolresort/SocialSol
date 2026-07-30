#!/usr/bin/env node
'use strict';
//
// tag-corpus-intents.js — one-shot Haiku 4.5 batch tagger over
// sarah_voice_corpus rows where intent_tags IS NULL AND language='en'.
//
// For each batch of N messages, asks Haiku to assign one of the reserved
// intent values per row. Result is written back to SQLite and reupserted
// into the Chroma metadata so retrieval can filter on intent_tags.
//
// Idempotent: query is `WHERE intent_tags IS NULL ... `; re-runs after a
// full pass return 0 rows.
//
// Usage:
//   node tag-corpus-intents.js [--dry-run] [--limit=N] [--batch=N]
//
// Cost (~$0.16 for the full 1,204-row pass at batch=10): Haiku 4.5 input
// $1/Mtok, output $5/Mtok. Prompt caching keeps the static taxonomy +
// instructions block hot across batches.

const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const Anthropic = require('@anthropic-ai/sdk');
const { connectWithRetry } = require('../lib/chroma-connect');
const { getAnthropicKey } = require('../lib/anthropic-key');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crm.db');
const CHROMA_URL = 'http://localhost:8000';
const MODEL = 'claude-haiku-4-5';

// Mirrors the taxonomy in routes/voice-draft.js + voice_drafts_log schema.
// "unknown" is the structured-output escape hatch when Haiku has no
// confident match — we leave intent_tags NULL on the row in that case
// so a future re-run can retry.
const INTENTS = [
  'reactivation_anniversary',
  'reactivation_winback',
  'reactivation_referral',
  'reactivation_conversion',
  'reactivation_vip',
  'reactivation_feedback_closure',
  'inbound_inquiry_response',
  'cold_outbound_planner',
  'ad_hoc',
  'unknown',
];

const SYSTEM = `You are tagging messages from Sarah, the owner of a Mexican Pacific-coast resort, with one intent label each.

Intent meanings:
  reactivation_anniversary       — anniversary / "it's been a year" outreach to a past guest
  reactivation_winback           — past guest who hasn't returned; light re-engagement
  reactivation_referral          — asking a past guest to refer friends/family
  reactivation_conversion        — past inquirer who never booked; nudge to convert
  reactivation_vip               — repeat / VIP guest, special treatment
  reactivation_feedback_closure  — closing the loop on a complaint or feedback item
  inbound_inquiry_response       — replying to an inbound booking inquiry
  cold_outbound_planner          — cold outreach to a wedding / event planner
  ad_hoc                         — operational / logistical chatter (check-in details, directions, schedules)
  unknown                        — none of the above fits with confidence

Tag each message with exactly ONE label. When in doubt between two labels, pick the more specific one. When in doubt overall, return "unknown" — a re-run can retry.`;

function parseArgs(argv) {
  const out = { batch: 10 };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'dry-run') out.dryRun = true;
    else if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'batch') out.batch = parseInt(m[2], 10);
    else if (m[1] === 'help' || m[1] === 'h') out.help = true;
  }
  return out;
}

async function tagBatch(client, rows) {
  // Truncate each body to keep input small. Long bodies don't help intent
  // classification; the first 600 chars are the lead, which is what
  // distinguishes intent.
  const items = rows.map((r, i) => ({
    idx: i,
    id: r.id,
    body: String(r.body || '').slice(0, 600),
    relationship: r.recipient_relationship || 'unknown',
  }));

  const userPrompt = [
    'Tag each of the following messages. Respond ONLY with a JSON object matching the required schema.',
    '',
    items.map((it) => `[${it.idx}] (relationship=${it.relationship}) ${it.body}`).join('\n\n---\n\n'),
  ].join('\n');

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    ],
    // Structured outputs: minItems/maxItems > 1 not supported, and
    // numerical constraints (minimum/maximum) not supported. Rely on the
    // prompt to enforce one entry per input idx; missing entries are
    // tolerated downstream (idToIntent map skips them).
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['idx', 'intent'],
                properties: {
                  idx: { type: 'integer' },
                  intent: { type: 'string', enum: INTENTS },
                },
              },
            },
          },
        },
      },
    },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text block in tagger response');
  const parsed = JSON.parse(textBlock.text);
  if (!parsed.tags || !Array.isArray(parsed.tags)) {
    throw new Error('tagger response missing tags array');
  }

  // Map back to row.id by idx.
  const idToIntent = new Map();
  for (const t of parsed.tags) {
    const item = items[t.idx];
    if (!item) continue;
    idToIntent.set(item.id, t.intent);
  }

  return {
    idToIntent,
    usage: resp.usage || {},
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.error('Usage: node tag-corpus-intents.js [--dry-run] [--limit=N] [--batch=N]');
    return 0;
  }

  const db = createDB(DB_PATH);

  const limitClause = (Number.isInteger(opts.limit) && opts.limit > 0)
    ? sql`LIMIT ${opts.limit}` : sql``;

  // JOIN contacts so the tagger sees real recipient_relationship values
  // (the column on sarah_voice_corpus is NULL by design — see indexer).
  const rows = await db.query(sql`
    SELECT s.id, s.body,
           COALESCE(c.relationship_type, 'unknown') AS recipient_relationship
      FROM sarah_voice_corpus s
      LEFT JOIN contacts c ON c.id = s.contact_id
     WHERE s.intent_tags IS NULL
       AND s.language = 'en'
       AND s.embedding_status = 'indexed'
     ORDER BY s.sent_at ASC, s.id ASC
     ${limitClause}
  `);

  console.log(`[tagger] ${rows.length} row(s) to tag (model=${MODEL}, batch=${opts.batch}, dry-run=${!!opts.dryRun})`);
  if (rows.length === 0) {
    await db.dispose();
    console.log('[tagger] 0 rows to tag — nothing to do.');
    return 0;
  }

  if (opts.dryRun) {
    await db.dispose();
    console.log('[tagger] [dry-run] would tag', rows.length, 'rows; exiting');
    return 0;
  }

  const anthropic = new Anthropic({ apiKey: getAnthropicKey() });

  const chromaClient = await connectWithRetry({ url: CHROMA_URL, label: 'tagger' });
  const collection = await chromaClient.getOrCreateCollection({ name: 'sarah_voice_corpus' });

  let tagged = 0, unknownTagged = 0, failed = 0;
  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;

  for (let i = 0; i < rows.length; i += opts.batch) {
    const slice = rows.slice(i, i + opts.batch);
    let result;
    try {
      result = await tagBatch(anthropic, slice);
    } catch (e) {
      failed += slice.length;
      console.warn(`[tagger] batch ${Math.floor(i / opts.batch) + 1} failed (${slice.length} rows): ${e.message}`);
      continue;
    }
    totalIn += result.usage.input_tokens || 0;
    totalOut += result.usage.output_tokens || 0;
    totalCacheRead += result.usage.cache_read_input_tokens || 0;
    totalCacheWrite += result.usage.cache_creation_input_tokens || 0;

    // Fetch existing Chroma metadatas in one shot to preserve every
    // non-intent_tags field on the reupsert.
    const ids = slice.map((r) => String(r.id));
    const existing = await collection.get({ ids });
    const idToMetadata = new Map();
    if (existing && existing.ids) {
      for (let k = 0; k < existing.ids.length; k++) {
        idToMetadata.set(String(existing.ids[k]), existing.metadatas[k] || {});
      }
    }

    const upsertIds = [];
    const upsertMetadatas = [];

    for (const row of slice) {
      const intent = result.idToIntent.get(row.id);
      if (!intent) {
        // Tagger silently dropped this row; leave it for re-run.
        continue;
      }
      if (intent === 'unknown') {
        unknownTagged++;
        // Leave SQLite intent_tags NULL — a future re-run will retry.
        continue;
      }
      // Update SQLite.
      await db.query(sql`
        UPDATE sarah_voice_corpus
           SET intent_tags = ${intent}
         WHERE id = ${row.id}
      `);
      // Reupsert into Chroma metadata.
      const md = Object.assign({}, idToMetadata.get(String(row.id)) || {});
      md.intent_tags = intent;
      upsertIds.push(String(row.id));
      upsertMetadatas.push(md);
      tagged++;
    }

    if (upsertIds.length > 0) {
      // Chroma update preserves embeddings + documents when only
      // metadatas are passed.
      await collection.update({ ids: upsertIds, metadatas: upsertMetadatas });
    }

    if ((Math.floor(i / opts.batch) + 1) % 5 === 0 || (i + opts.batch) >= rows.length) {
      console.log(`[tagger] batch ${Math.floor(i / opts.batch) + 1}/${Math.ceil(rows.length / opts.batch)}: tagged=${tagged} unknown=${unknownTagged} failed=${failed}`);
    }
  }

  await db.dispose();

  // Haiku 4.5: $1/Mtok input, $5/Mtok output. Cache read 0.10, cache write 1.25 (1.25× of input price).
  const cost = (totalIn * 1.0 / 1_000_000) + (totalOut * 5.0 / 1_000_000)
    + (totalCacheRead * 0.10 / 1_000_000) + (totalCacheWrite * 1.25 / 1_000_000);

  console.log(`[tagger] DONE: tagged=${tagged} unknown=${unknownTagged} failed=${failed} cost~=$${cost.toFixed(4)}`);
  console.log(`[tagger] tokens: input=${totalIn} output=${totalOut} cache_read=${totalCacheRead} cache_write=${totalCacheWrite}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    console.error('[tagger] FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { tagBatch, INTENTS, SYSTEM };
