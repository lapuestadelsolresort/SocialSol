'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../scripts/lib/dossier-extract');
const main = require('../scripts/extract-guest-dossiers');
const { detectLanguage } = require('../scripts/lib/airbnb-export');

const HOST_IDS = new Set([121885415, 510010203]);
const OPS_ID = 558059521;

// ── Fixture: a minimal thread with one guest + one host message ──────────
function fixtureThread(overrides = {}) {
  return {
    id: 999000111,
    messageThreadParticipants: [
      { accountId: 12345 },
      { accountId: 121885415 },
    ],
    messagesAndContents: [
      {
        message: { id: 'm1', accountId: 12345, accountType: 'user', createdAt: '2026-04-15T10:00:00.000Z' },
        messageContent: { textContent: { body: 'Hello! Looking at your villa for our anniversary in August.' } },
      },
      {
        message: { id: 'm2', accountId: 121885415, accountType: 'user', createdAt: '2026-04-15T12:00:00.000Z' },
        messageContent: { textContent: { body: 'Hi! Thanks for reaching out, those dates are open.' } },
      },
      ...(overrides.extraMessages || []),
    ],
  };
}

const FIXTURE_CONTACT = {
  id: 412,
  name: 'Maria González',
  airbnb_account_id: 12345,
  airbnb_thread_id: 999000111,
  relationship_type: 'past_guest_inquired',
  last_stay_date: null,
  review_rating: null,
};

// ── Role mapping ──────────────────────────────────────────────────────────
test('mapMessageRole identifies HOST/GUEST/OPS correctly', () => {
  assert.equal(lib.mapMessageRole(121885415, HOST_IDS, OPS_ID), 'HOST');
  assert.equal(lib.mapMessageRole(510010203, HOST_IDS, OPS_ID), 'HOST');
  assert.equal(lib.mapMessageRole(558059521, HOST_IDS, OPS_ID), 'OPS');
  assert.equal(lib.mapMessageRole(99999, HOST_IDS, OPS_ID), 'GUEST');
});

// ── Strict-Spanish detection ──────────────────────────────────────────────
test('isStrictlySpanish: false when host replies in English', () => {
  const t = fixtureThread();
  // guest English, host English → false
  assert.equal(lib.isStrictlySpanish(t, HOST_IDS, detectLanguage), false);
});

test('isStrictlySpanish: false when only guest is Spanish (mixed thread)', () => {
  const t = {
    id: 1,
    messagesAndContents: [
      { message: { id: 'm1', accountId: 12345, accountType: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        messageContent: { textContent: { body: 'hola, gracias por contestar, necesito reservación para mañana' } } },
      { message: { id: 'm2', accountId: 121885415, accountType: 'user', createdAt: '2026-01-01T01:00:00.000Z' },
        messageContent: { textContent: { body: 'Hi, those dates are open. Welcome!' } } },
    ],
  };
  assert.equal(lib.isStrictlySpanish(t, HOST_IDS, detectLanguage), false);
});

test('isStrictlySpanish: true when both sides Spanish', () => {
  const t = {
    id: 1,
    messagesAndContents: [
      { message: { id: 'm1', accountId: 12345, accountType: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
        messageContent: { textContent: { body: 'hola, necesito reservación para mañana' } } },
      { message: { id: 'm2', accountId: 121885415, accountType: 'user', createdAt: '2026-01-01T01:00:00.000Z' },
        messageContent: { textContent: { body: 'hola, gracias por su mensaje, las fechas están disponibles' } } },
    ],
  };
  assert.equal(lib.isStrictlySpanish(t, HOST_IDS, detectLanguage), true);
});

// ── Build thread input block ──────────────────────────────────────────────
test('buildThreadInputBlock formats CONTACT/THREAD/OUTCOME sections', () => {
  const t = fixtureThread();
  const block = lib.buildThreadInputBlock({
    thread: t,
    contacts: [FIXTURE_CONTACT],
    hostAccountIds: HOST_IDS,
    opsAccountId: OPS_ID,
  });
  assert.match(block.text, /^CONTACT\(S\):/);
  assert.match(block.text, /Maria González, contact_id=412, relationship_type=past_guest_inquired/);
  assert.match(block.text, /THREAD \(2 messages, 2026-04-15 to 2026-04-15\):/);
  assert.match(block.text, /\[m1\] 2026-04-15 10:00 GUEST: Hello!/);
  assert.match(block.text, /\[m2\] 2026-04-15 12:00 HOST: Hi!/);
  assert.match(block.text, /OUTCOME: Maria González — INQUIRED but did not book/);
  assert.equal(block.messageCount, 2);
});

test('buildThreadInputBlock orders messages chronologically even if input is shuffled', () => {
  const t = fixtureThread();
  // Reverse to make sure sort kicks in.
  t.messagesAndContents.reverse();
  const block = lib.buildThreadInputBlock({
    thread: t, contacts: [FIXTURE_CONTACT], hostAccountIds: HOST_IDS, opsAccountId: OPS_ID,
  });
  const m1Pos = block.text.indexOf('[m1]');
  const m2Pos = block.text.indexOf('[m2]');
  assert.ok(m1Pos > 0 && m2Pos > 0 && m1Pos < m2Pos, 'm1 must appear before m2');
});

test('buildThreadInputBlock skips service messages and empty bodies', () => {
  const t = {
    id: 5,
    messagesAndContents: [
      { message: { id: 's1', accountId: 1, accountType: 'service', createdAt: '2026-01-01T00:00:00.000Z' },
        messageContent: { textContent: { body: 'system notification' } } },
      { message: { id: 'e1', accountId: 12345, accountType: 'user', createdAt: '2026-01-01T01:00:00.000Z' },
        messageContent: { textContent: { body: '' } } },
      { message: { id: 'g1', accountId: 12345, accountType: 'user', createdAt: '2026-01-01T02:00:00.000Z' },
        messageContent: { textContent: { body: 'Hi there' } } },
    ],
  };
  const block = lib.buildThreadInputBlock({ thread: t, contacts: [FIXTURE_CONTACT], hostAccountIds: HOST_IDS, opsAccountId: OPS_ID });
  assert.equal(block.messageCount, 1);
  assert.match(block.text, /\[g1\]/);
  assert.doesNotMatch(block.text, /\[s1\]/);
  assert.doesNotMatch(block.text, /\[e1\]/);
});

// ── Validator: enums ──────────────────────────────────────────────────────
function validParsed(overrides = {}) {
  const f = (value, conf = 0.9, sources = ['m1']) => ({ value, confidence: conf, source_message_ids: sources });
  const arr = (vals, conf = 0.8, sources = []) => ({ value: vals, confidence: conf, source_message_ids: sources });
  return {
    trip_purpose: f('anniversary_trip'),
    why_no_book: f('price'),
    excitement_signals: arr(['private chef option']),
    objections: arr(['price stretch']),
    specific_features_mentioned: arr(['Villa Dolphin']),
    dates_targeted: f('2024-08-15 to 2024-08-22'),
    group_dynamics: f('couple'),
    decision_timeline: f('decided_against'),
    geographic_hints: { value: null, confidence: 0.0, source_message_ids: [] },
    language: { value: 'en', confidence: 1.0, source_message_ids: [] },
    communication_style: f('warm, polite'),
    occasion_anniversary_date: { value: null, confidence: 0.0, source_message_ids: [] },
    notes_for_sarah: f('Maria inquired for her anniversary; price was the blocker.'),
    extraction_status: 'extracted',
    ...overrides,
  };
}

test('validateDossierJson accepts a well-formed extracted payload', () => {
  assert.doesNotThrow(() => lib.validateDossierJson(validParsed()));
});

test('validateDossierJson rejects language="english" (the bug we are guarding against)', () => {
  const bad = validParsed({
    language: { value: 'english', confidence: 1.0, source_message_ids: [] },
  });
  assert.throws(() => lib.validateDossierJson(bad), (err) => {
    assert.equal(err.category, 'schema_validation');
    assert.match(err.message, /language\.value/);
    return true;
  });
});

test('validateDossierJson rejects unknown trip_purpose', () => {
  const bad = validParsed({
    trip_purpose: { value: 'spa_retreat', confidence: 0.8, source_message_ids: ['m1'] },
  });
  assert.throws(() => lib.validateDossierJson(bad), (err) => {
    assert.equal(err.category, 'schema_validation');
    return true;
  });
});

test('validateDossierJson rejects out-of-range confidence', () => {
  const bad = validParsed({
    why_no_book: { value: 'price', confidence: 1.5, source_message_ids: ['m1'] },
  });
  assert.throws(() => lib.validateDossierJson(bad), /confidence/);
});

test('validateDossierJson rejects non-string source_message_ids', () => {
  const bad = validParsed({
    why_no_book: { value: 'price', confidence: 0.9, source_message_ids: [123, 'm1'] },
  });
  assert.throws(() => lib.validateDossierJson(bad), /source_message_ids/);
});

test('validateDossierJson is permissive for deferred_spanish/no_source/extraction_failed', () => {
  // The script writes these from a synthesized payload; the model may also
  // produce them with mostly-null fields.
  assert.doesNotThrow(() => lib.validateDossierJson({ extraction_status: 'deferred_spanish' }));
  assert.doesNotThrow(() => lib.validateDossierJson({ extraction_status: 'no_source' }));
  assert.doesNotThrow(() => lib.validateDossierJson({ extraction_status: 'extraction_failed' }));
});

test('validateDossierJson rejects extraction_status outside the enum', () => {
  assert.throws(() => lib.validateDossierJson({ extraction_status: 'maybe' }), /extraction_status/);
});

// ── Flatten ───────────────────────────────────────────────────────────────
test('flattenForInsert produces a row with all 48 schema columns populated for "extracted"', () => {
  const row = lib.flattenForInsert({
    parsed: validParsed(),
    airbnbThreadId: 999000111,
    contactIds: [412],
    model: 'claude-sonnet-4-6',
    status: 'extracted',
    lastError: null,
  });
  // PK + linkage
  assert.equal(row.airbnb_thread_id, '999000111');
  assert.equal(row.contact_ids, '[412]');
  // Closed taxonomy
  assert.equal(row.trip_purpose, 'anniversary_trip');
  assert.equal(row.trip_purpose_confidence, 0.9);
  assert.equal(row.trip_purpose_source_message_ids, '["m1"]');
  // Array field stored as JSON
  assert.equal(row.specific_features_mentioned, '["Villa Dolphin"]');
  // Scalar nullable
  assert.equal(row.geographic_hints, null);
  assert.equal(row.geographic_hints_confidence, 0.0);
  assert.equal(row.geographic_hints_source_message_ids, '[]');
  // Status + meta
  assert.equal(row.extraction_status, 'extracted');
  assert.equal(row.last_attempt_error, null);
  assert.equal(row.extraction_model, 'claude-sonnet-4-6');
  assert.equal(row.reviewed_by_human, 0);
});

test('flattenForInsert for deferred_spanish leaves extractable fields null but sets language=es', () => {
  const row = lib.flattenForInsert({
    parsed: null,
    airbnbThreadId: 1,
    contactIds: [10],
    model: 'claude-sonnet-4-6',
    status: 'deferred_spanish',
    lastError: null,
  });
  assert.equal(row.extraction_status, 'deferred_spanish');
  assert.equal(row.language, 'es');
  assert.equal(row.language_confidence, 1.0);
  assert.equal(row.trip_purpose, null);
  assert.equal(row.notes_for_sarah, null);
});

test('flattenForInsert for extraction_failed records last_attempt_error and nulls all extractable fields', () => {
  const row = lib.flattenForInsert({
    parsed: null,
    airbnbThreadId: 1,
    contactIds: [10],
    model: 'claude-sonnet-4-6',
    status: 'extraction_failed',
    lastError: 'json_parse: Unexpected token at position 47',
  });
  assert.equal(row.extraction_status, 'extraction_failed');
  assert.match(row.last_attempt_error, /^json_parse:/);
  assert.equal(row.trip_purpose, null);
  assert.equal(row.language, null);
});

// ── classifyApiError ──────────────────────────────────────────────────────
test('classifyApiError: 429 is retryable as api_429', () => {
  const r = lib.classifyApiError({ status: 429, message: 'rate limited' });
  assert.equal(r.retryable, true);
  assert.equal(r.category, 'api_429');
});

test('classifyApiError: 503 is retryable as api_5xx', () => {
  const r = lib.classifyApiError({ status: 503, message: 'service unavailable' });
  assert.equal(r.retryable, true);
  assert.equal(r.category, 'api_5xx');
});

test('classifyApiError: ETIMEDOUT is retryable as timeout', () => {
  const r = lib.classifyApiError({ code: 'ETIMEDOUT', message: 'request timed out' });
  assert.equal(r.retryable, true);
  assert.equal(r.category, 'timeout');
});

test('classifyApiError: 400 is non-retryable as api_other', () => {
  const r = lib.classifyApiError({ status: 400, message: 'bad request' });
  assert.equal(r.retryable, false);
  assert.equal(r.category, 'api_other');
});

test('classifyApiError: schema_validation pre-tag is non-retryable', () => {
  const e = new Error('bad shape');
  e.category = 'schema_validation';
  const r = lib.classifyApiError(e);
  assert.equal(r.retryable, false);
  assert.equal(r.category, 'schema_validation');
});

// ── Eligibility: classifyThread ───────────────────────────────────────────
test('classifyThread: no_host when no Sarah-account messages', () => {
  const t = {
    id: 1,
    messagesAndContents: [
      { message: { id: 'g1', accountId: 12345, accountType: 'user' }, messageContent: { textContent: { body: 'hi' } } },
    ],
  };
  const cls = main.classifyThread(t, new Map([[12345, 412]]));
  assert.equal(cls.reason, 'no_host');
});

test('classifyThread: unmapped when guest is not in directory', () => {
  const t = {
    id: 1,
    messagesAndContents: [
      { message: { id: 'g1', accountId: 99999, accountType: 'user' }, messageContent: { textContent: { body: 'hi' } } },
      { message: { id: 'h1', accountId: 121885415, accountType: 'user' }, messageContent: { textContent: { body: 'hello' } } },
    ],
  };
  const cls = main.classifyThread(t, new Map([[12345, 412]]));
  assert.equal(cls.reason, 'unmapped');
});

test('classifyThread: eligible when Sarah replied AND guest is in directory', () => {
  const t = fixtureThread();
  const cls = main.classifyThread(t, new Map([[12345, 412]]));
  assert.equal(cls.reason, 'eligible');
  assert.deepEqual(cls.contactIds, [412]);
});

test('classifyThread: ops account does NOT count as guest (avoids spurious unmapped)', () => {
  const t = {
    id: 1,
    messagesAndContents: [
      { message: { id: 'o1', accountId: 558059521, accountType: 'user' }, messageContent: { textContent: { body: 'ops' } } },
      { message: { id: 'h1', accountId: 121885415, accountType: 'user' }, messageContent: { textContent: { body: 'hello' } } },
    ],
  };
  // No real guest at all — should be unmapped.
  const cls = main.classifyThread(t, new Map());
  assert.equal(cls.reason, 'unmapped');
});

// ── Stride sampling ───────────────────────────────────────────────────────
test('strideSample is deterministic and evenly spread', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ thread: { id: i } }));
  const a = main.strideSample(items, 10);
  const b = main.strideSample(items, 10);
  assert.deepEqual(a.map(x => x.thread.id), b.map(x => x.thread.id));
  assert.equal(a.length, 10);
  // Stride should be 10 (100 / 10) → ids 0, 10, 20, ..., 90.
  assert.deepEqual(a.map(x => x.thread.id), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
});

test('strideSample returns all items when N >= eligible count', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ thread: { id: i } }));
  const out = main.strideSample(items, 20);
  assert.equal(out.length, 5);
});

// ── parseArgs ─────────────────────────────────────────────────────────────
test('parseArgs handles --key=value and --key value forms', () => {
  const a = main.parseArgs(['node', 'script', '--export-dir=/tmp/foo', '--sample=5']);
  assert.equal(a.exportDir, '/tmp/foo');
  assert.equal(a.sample, 5);
  const b = main.parseArgs(['node', 'script', '--export-dir', '/tmp/bar', '--sample', '7']);
  assert.equal(b.exportDir, '/tmp/bar');
  assert.equal(b.sample, 7);
});

test('parseArgs flag without value sets true', () => {
  const a = main.parseArgs(['node', 'script', '--confirm-sample-reviewed', '--retry-failed']);
  assert.equal(a.confirmSampleReviewed, true);
  assert.equal(a.retryFailed, true);
});
