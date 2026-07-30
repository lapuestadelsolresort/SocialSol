'use strict';
// Unit tests for the voice-corpus indexer.
// Mirrors crm/tests/ingest-airbnb-export.test.js: node:test + node:assert,
// no extra deps. Tests the pure helpers (parseArgs, deriveRecipientRelationship,
// buildMetadata) without touching DB / Chroma / OpenAI.

const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../scripts/index-voice-corpus');

// ── parseArgs ────────────────────────────────────────────────────────────────

test('parseArgs defaults', () => {
  const o = lib.parseArgs(['node', 'index-voice-corpus.js']);
  assert.equal(o.model, 'text-embedding-3-small');
  assert.equal(o.chromaUrl, 'http://localhost:8000');
  assert.equal(o.batchOpenAI, 100);
  assert.equal(o.batchChroma, 200);
  assert.equal(o.dryRun, undefined);
  assert.equal(o.verifyIdempotency, undefined);
});

test('parseArgs flags', () => {
  const o = lib.parseArgs([
    'node', 'index-voice-corpus.js',
    '--dry-run',
    '--limit=42',
    '--model=text-embedding-3-large',
    '--reindex-failed',
    '--verify-idempotency',
    '--batch-openai=50',
    '--batch-chroma=75',
    '--chroma-url=http://1.2.3.4:9000',
  ]);
  assert.equal(o.dryRun, true);
  assert.equal(o.limit, 42);
  assert.equal(o.model, 'text-embedding-3-large');
  assert.equal(o.reindexFailed, true);
  assert.equal(o.verifyIdempotency, true);
  assert.equal(o.batchOpenAI, 50);
  assert.equal(o.batchChroma, 75);
  assert.equal(o.chromaUrl, 'http://1.2.3.4:9000');
});

// ── deriveRecipientRelationship ──────────────────────────────────────────────

test("deriveRecipientRelationship returns contact's relationship_type", () => {
  assert.equal(
    lib.deriveRecipientRelationship({ contact_relationship_type: 'past_guest_stayed' }),
    'past_guest_stayed'
  );
  assert.equal(
    lib.deriveRecipientRelationship({ contact_relationship_type: 'past_guest_inquired' }),
    'past_guest_inquired'
  );
});

test("deriveRecipientRelationship returns 'unknown' for NULL contact / NULL relationship", () => {
  // The 20 R1-orphan rows have no linked contact at all.
  assert.equal(lib.deriveRecipientRelationship({ contact_id: null, contact_relationship_type: null }), 'unknown');
  // A linked contact with a NULL relationship_type also falls through to unknown.
  assert.equal(lib.deriveRecipientRelationship({ contact_id: 17, contact_relationship_type: null }), 'unknown');
  // Empty string is not a real relationship - treat as unknown.
  assert.equal(lib.deriveRecipientRelationship({ contact_relationship_type: '' }), 'unknown');
});

// ── buildMetadata ────────────────────────────────────────────────────────────

test('buildMetadata produces Chroma-safe (primitives only) metadata', () => {
  const row = {
    id: 17,
    source: 'airbnb_messages',
    source_id: '999',
    message_id: '12345678901',
    contact_id: 7,
    source_account_id: 121885415,
    language: 'en',
    sent_at: '2025-01-15T12:00:00Z',
    word_count: 42,
    intent_tags: null,
    contact_relationship_type: 'past_guest_stayed',
  };
  const md = lib.buildMetadata(row);
  for (const [k, v] of Object.entries(md)) {
    const t = typeof v;
    assert.ok(t === 'string' || t === 'number' || t === 'boolean',
      `metadata.${k} must be a Chroma primitive, got ${t} (${v})`);
  }
  assert.equal(md.source, 'airbnb_messages');
  assert.equal(md.source_id, '999');
  assert.equal(md.message_id, '12345678901');
  assert.equal(md.source_account_id, 121885415);
  assert.equal(md.contact_id, 7);
  assert.equal(md.language, 'en');
  assert.equal(md.recipient_relationship, 'past_guest_stayed');
  assert.equal(md.word_count, 42);
});

test('buildMetadata: NULL contact_id row falls through to recipient_relationship=unknown', () => {
  // The 20 R1-orphan rows: account 510010203, no linked contact in 218-directory.
  const row = {
    id: 17,
    source: 'airbnb_messages',
    source_id: '999',
    message_id: '12345678901',
    contact_id: null,
    source_account_id: 510010203,
    language: 'en',
    sent_at: '2024-09-15T12:00:00Z',
    word_count: 60,
    intent_tags: null,
    contact_relationship_type: null,
  };
  const md = lib.buildMetadata(row);
  assert.equal(md.recipient_relationship, 'unknown');
  assert.equal(md.source_account_id, 510010203);
  assert.equal('contact_id' in md, false, 'NULL contact_id should be omitted from metadata, not coerced to 0');
});

test('buildMetadata: NULL source_account_id coerces to 0 (Chroma rejects null)', () => {
  // source_account_id is on every Airbnb row but future Gmail/WhatsApp ingests may not have it.
  const row = {
    id: 99, source: 'gmail', source_id: 't', message_id: 'm',
    contact_id: 5, source_account_id: null, language: 'en',
    sent_at: '2026-01-01T00:00:00Z', word_count: 10, intent_tags: null,
    contact_relationship_type: 'past_guest_stayed',
  };
  const md = lib.buildMetadata(row);
  assert.equal(md.source_account_id, 0);
});

test('buildMetadata: stringifies numeric source_id and message_id', () => {
  // Airbnb message_ids are large ints (>2^53) - storing as numbers loses precision.
  // We always coerce to string.
  const row = {
    id: 7, source: 'airbnb_messages',
    source_id: 999999999999999,        // would overflow Number precision
    message_id: 12345678901234567890,  // ditto
    contact_id: 1, source_account_id: 121885415, language: 'en',
    sent_at: '2025-01-01T00:00:00Z', word_count: 5, intent_tags: null,
    contact_relationship_type: 'past_guest_stayed',
  };
  const md = lib.buildMetadata(row);
  assert.equal(typeof md.source_id, 'string');
  assert.equal(typeof md.message_id, 'string');
});
