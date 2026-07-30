'use strict';
//
// voice-draft.test.js — Phase R, R3 golden suite.
//
// Stubs Anthropic and embeddings by default (deterministic mocks). Chroma
// is used when available. The unit assertions
// pin retrieval shape, response envelope, and module-level invariants.
//
// Run:  cd crm && node --test test/voice-draft.test.js
//
// Voice quality is NOT asserted (not unit-testable). Quality is the
// downstream voice_drafts_log.outcome flow.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Indexer model constant (locked) — exposed via the indexer's parseArgs
// default. We don't import the whole CLI script; just hardcode and have
// the test fail if either side drifts.
const INDEXER_EMBEDDING_MODEL_DEFAULT = 'text-embedding-3-small';

const { EMBEDDING_MODEL, EMBEDDING_DIM, _setEmbedderForTesting } = require('../lib/openai-embed');
const { buildWhere, DEFAULT_TOP_K, DEFAULT_MAX_DISTANCE } = require('../lib/voice-retrieval');
const voiceDraft = require('../lib/voice-draft');
const { VALID_INTENTS, VALID_AGENTS } = require('../routes/voice-draft');

// ── Module invariants ────────────────────────────────────────────────────

test('embedding model matches indexer default', () => {
  assert.equal(EMBEDDING_MODEL, INDEXER_EMBEDDING_MODEL_DEFAULT,
    'lib/openai-embed.js EMBEDDING_MODEL must equal the indexer default');
  assert.equal(EMBEDDING_DIM, 1536);
});

test('voice-spec §4 block is extractable (Paulina contract)', () => {
  const block = voiceDraft.loadVoiceConstraintsBlock();
  assert.ok(block.startsWith('## 4.'),
    'extracted block must start with "## 4." — Paulina composer regex depends on this');
  assert.ok(block.length > 200, 'block must contain real content');
});

// D12-style invariant: both consumers must use byte-identical regex
// patterns to extract §4. Without this guard, drift between
// composer.js and voice-draft.js silently produces different §4
// content for Paulina vs. the Voice Service.
test('§4 regex is byte-identical between voice-draft.js and composer.js (one source of truth)', () => {
  const sharedModule = require('../../prospector/lib/voice-spec-section');
  // voice-draft.js re-exports the regex it actually uses
  assert.equal(voiceDraft.VOICE_SPEC_SECTION_4_REGEX.source, sharedModule.VOICE_SPEC_SECTION_4_REGEX.source,
    'voice-draft.js regex source must match the shared module');
  assert.equal(voiceDraft.VOICE_SPEC_SECTION_4_REGEX.flags, sharedModule.VOICE_SPEC_SECTION_4_REGEX.flags,
    'voice-draft.js regex flags must match the shared module');

  // composer.js doesn't re-export the regex — but its loadVoiceConstraintsBlock
  // and the shared module's loadSection4 are the same function (require cache).
  // Assert composer.js's loader returns the same content as the shared loader.
  const composer = require('../../prospector/composer.js');
  const fromComposer = composer.loadVoiceConstraintsBlock();
  const fromShared = sharedModule.loadSection4(voiceDraft.VOICE_SPEC_PATH);
  assert.equal(fromComposer, fromShared,
    'composer.js and the shared module must extract identical §4 content');
});

// Structural guard: the §4-to-§5 contract is meaningless if the spec
// rebuild ever inserts an intervening H2 (## 4a, ## 4.1, ## new section)
// between them. Loosening the regex would mask the bug; instead we
// catch the spec violation at test time and require the rebuild
// template to keep §5 immediately after §4.
test('voice-spec.md: §5 immediately follows §4 with no intervening H2', () => {
  const fs2 = require('fs');
  const raw = fs2.readFileSync(voiceDraft.VOICE_SPEC_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);
  const h2 = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^## /.test(line));

  const fourIdx = h2.findIndex(({ line }) => /^## 4\./.test(line));
  assert.ok(fourIdx >= 0, 'voice-spec.md must contain a "## 4." H2');

  const next = h2[fourIdx + 1];
  assert.ok(next, 'voice-spec.md has no H2 after §4 — §5 must exist');
  assert.ok(/^## 5\./.test(next.line),
    `expected the H2 immediately after §4 to be "## 5.", got "${next.line}" at line ${next.i + 1}. ` +
    `If a rebuild template change introduced this, fix the template — do not loosen the §4 regex.`);
});

test('voice-spec version line is readable', () => {
  const v = voiceDraft.readVoiceSpecVersion();
  assert.ok(typeof v === 'string' && v.length > 0);
});

test('intent + agent taxonomies match Phase R schema', () => {
  for (const intent of [
    'reactivation_anniversary', 'reactivation_winback', 'reactivation_referral',
    'reactivation_conversion', 'reactivation_vip', 'reactivation_feedback_closure',
    'inbound_inquiry_response', 'cold_outbound_planner', 'ad_hoc',
  ]) {
    assert.ok(VALID_INTENTS.has(intent), `intent ${intent} must be valid`);
  }
  for (const agent of ['regina', 'paulina', 'sol', 'adhoc', 'sarah-coach']) {
    assert.ok(VALID_AGENTS.has(agent), `agent ${agent} must be valid`);
  }
});

// ── Retrieval where-clause shape ─────────────────────────────────────────

test('buildWhere: language only', () => {
  const w = buildWhere({ language: 'en' });
  assert.deepEqual(w, { language: { $eq: 'en' } });
});

test('buildWhere: language + relationship → $and', () => {
  const w = buildWhere({ language: 'en', recipientRelationship: 'past_guest_stayed' });
  assert.deepEqual(w, {
    $and: [
      { language: { $eq: 'en' } },
      { recipient_relationship: { $eq: 'past_guest_stayed' } },
    ],
  });
});

test('buildWhere: language + relationship + intent → $and (3 clauses)', () => {
  const w = buildWhere({ language: 'en', recipientRelationship: 'past_guest_stayed', intentTag: 'reactivation_winback' });
  assert.equal(w.$and.length, 3);
});

test('DEFAULT_TOP_K = 8, DEFAULT_MAX_DISTANCE = 1.5', () => {
  assert.equal(DEFAULT_TOP_K, 8);
  assert.equal(DEFAULT_MAX_DISTANCE, 1.5);
});

// ── Route validation (boots an Express app in-process) ──────────────────

const express = require('express');
const { buildRouter } = require('../routes/voice-draft');

function buildTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  // No db wired — log insert no-ops, response.voice_drafts_log_id will be null.
  app.use('/api/voice', buildRouter(() => null));
  return app;
}

async function postDraft(app, body, opts = {}) {
  const http = require('http');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const headers = { 'Content-Type': 'application/json' };
  if (opts.xff) headers['X-Forwarded-For'] = opts.xff;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/draft`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

test('400 on missing intent', async () => {
  const app = buildTestApp();
  const r = await postDraft(app, { message_context: 'hi', agent_id: 'adhoc' });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'intent');
});

test('400 on missing message_context', async () => {
  const app = buildTestApp();
  const r = await postDraft(app, { intent: 'ad_hoc', agent_id: 'adhoc' });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'message_context');
});

test('400 on missing agent_id', async () => {
  const app = buildTestApp();
  const r = await postDraft(app, { intent: 'ad_hoc', message_context: 'hi' });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'agent_id');
});

test('400 on invalid intent value', async () => {
  const app = buildTestApp();
  const r = await postDraft(app, { intent: 'not_real', message_context: 'hi', agent_id: 'adhoc' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_value');
  assert.equal(r.body.field, 'intent');
});

test('400 on unsupported language', async () => {
  const app = buildTestApp();
  const r = await postDraft(app, { intent: 'ad_hoc', message_context: 'hola', agent_id: 'adhoc', language: 'es' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unsupported_language');
});

test('403 on non-localhost IP', async () => {
  const app = buildTestApp();
  // trust proxy=1 → req.ip becomes the X-Forwarded-For value.
  const r = await postDraft(app, { intent: 'ad_hoc', message_context: 'hi', agent_id: 'adhoc' }, { xff: '203.0.113.7' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'localhost_only');
});

// ── Golden cases (D9 from the R3 plan) ──────────────────────────────────
//
// Default: Anthropic and OpenAI embedding are deterministic mocks; Chroma is
// real when available. Skips gracefully if Chroma is not reachable so
// `npm test` still works in fresh checkouts / CI without Chroma running.
//
// LIVE_ANTHROPIC=1 swaps in the real Anthropic client (~$0.05 per run);
// use for nightly smoke against real Sonnet 4.6.

const GOLDENS = [
  { intent: 'reactivation_winback',         relationship: 'past_guest_stayed',     ctx: 'Maria stayed Aug 2024, two adults, hasn\'t booked since.' },
  { intent: 'reactivation_anniversary',     relationship: 'past_guest_stayed',     ctx: 'One year since the Hayes family stayed for their daughter\'s graduation.' },
  { intent: 'reactivation_referral',        relationship: 'past_guest_stayed',     ctx: 'Repeat guest with three stays who left a 5-star review last fall. Asking if she would refer her friends or sister.' },
  { intent: 'inbound_inquiry_response',     relationship: 'past_guest_inquired',   ctx: 'They asked about availability and pricing for Easter week 2026. Two adults, want oceanfront.' },
  { intent: 'cold_outbound_planner',        relationship: null,                    ctx: 'Wedding planner from Guadalajara, focuses on small destination weddings. No prior contact.' },
  { intent: 'reactivation_winback',         relationship: 'past_guest_cancelled',  ctx: 'Booked but cancelled three weeks before arrival in 2023.' },
  { intent: 'ad_hoc',                       relationship: null,                    ctx: 'Quick reminder about the late-checkout policy for tomorrow.' },
];

const STUB_DRAFT = `Hi — so good to hear from you. We'd love to make this work and can hold dates while you decide. Just reply here or call me directly and I'll take care of the details. Easy to reach any time.\n\nBest, Sarah`;

function makeStubAnthropic() {
  return {
    messages: {
      async create(_params) {
        return {
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: STUB_DRAFT }],
          usage: { input_tokens: 1200, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
        };
      },
    },
  };
}

async function tryConnectChroma() {
  try {
    const { connectOnce } = require('../lib/chroma-connect');
    const c = await connectOnce({ url: 'http://localhost:8000' });
    const col = await c.getOrCreateCollection({ name: 'sarah_voice_corpus' });
    return { client: c, collection: col };
  } catch (e) {
    return null;
  }
}

const LIVE_ANTHROPIC = String(process.env.LIVE_ANTHROPIC || '') === '1';

test('golden cases exercise the full path (D9)', async (t) => {
  const chroma = await tryConnectChroma();
  if (!chroma) {
    t.skip('Chroma not reachable at http://localhost:8000 — start chroma to run goldens');
    return;
  }

  if (!LIVE_ANTHROPIC) {
    voiceDraft._setClientForTesting(makeStubAnthropic());
    _setEmbedderForTesting(async () => {
      const embedding = Array(EMBEDDING_DIM).fill(0);
      embedding[0] = 1;
      return { embedding, promptTokens: 0, totalTokens: 0 };
    });
  } else {
    // Live mode: explicitly clear the stub so the module re-instantiates
    // a real Anthropic client lazily.
    voiceDraft._setClientForTesting(null);
    _setEmbedderForTesting(null);
  }

  const express2 = require('express');
  const app = express2();
  app.set('trust proxy', 1);
  app.locals.chromaClient = chroma.client;
  app.locals.chromaVoiceCorpus = chroma.collection;
  app.use('/api/voice', buildRouter(() => null));

  for (const g of GOLDENS) {
    await t.test(`${g.intent} × ${g.relationship || 'none'}`, async () => {
      const r = await postDraft(app, {
        intent: g.intent,
        recipient_relationship: g.relationship,
        message_context: g.ctx,
        agent_id: 'adhoc',
        draft_length: { min: 40, max: 120 },
      });
      assert.equal(r.status, 200, `unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.model_used, 'claude-sonnet-4-6');
      assert.equal(r.body.embedding_model_used, 'text-embedding-3-small');
      assert.ok(typeof r.body.draft_text === 'string' && r.body.draft_text.length > 0,
        'draft_text must be non-empty');
      assert.ok(Array.isArray(r.body.retrieved_exemplar_ids),
        'retrieved_exemplar_ids must be an array');
      assert.ok(typeof r.body.cost_usd === 'number');
      // Voice quality is NOT asserted (not unit-testable). The retrieval
      // floor: at least 3 exemplars, OR the warning surfaces.
      const exCount = r.body.retrieved_exemplar_ids.length;
      if (exCount < 3) {
        assert.equal(r.body.warning, 'low_exemplar_count',
          `expected low_exemplar_count warning when retrieval < 3 (got ${exCount})`);
      } else {
        assert.ok(exCount >= 3 && exCount <= 8,
          `expected 3–8 exemplars, got ${exCount}`);
      }
    });
  }
});
