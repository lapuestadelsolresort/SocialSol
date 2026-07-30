'use strict';
//
// Pure helpers for R4 — the dossier extraction job.
// Side-effect-free so the test suite can exercise every branch without
// touching the DB, the filesystem, or the Anthropic API.
//
// Public API:
//   SYSTEM_PROMPT            verbatim from the R4 spec
//   DOSSIER_JSON_SCHEMA      structured-outputs schema; closed-taxonomy enums
//   TAXONOMIES               { trip_purpose, why_no_book, ... } enum lists
//   FIELD_GROUPS             which fields are arrays vs scalars
//
//   buildThreadInputBlock({ thread, contacts, hostAccountIds, opsAccountId })
//     -> { text, messageCount, charCount }
//   mapMessageRole(accountId, hostAccountIds, opsAccountId) -> 'HOST'|'GUEST'|'OPS'|'SERVICE'
//   isStrictlySpanish(thread, hostAccountIds, detectLanguage) -> bool
//   validateDossierJson(parsed) -> throws Error with .category on schema fail
//   flattenForInsert({ parsed, airbnbThreadId, contactIds, model, status, lastError })
//     -> { col -> value } row matching the migration 009 schema
//   classifyApiError(err) -> { retryable, category }

const { detectLanguage } = require('./airbnb-export');

// ── Closed taxonomies ─────────────────────────────────────────────────────
const TAXONOMIES = Object.freeze({
  trip_purpose: [
    'wedding', 'honeymoon', 'vow_renewal', 'family_vacation',
    'family_reunion', 'corporate_retreat', 'milestone_birthday',
    'anniversary_trip', 'bachelor_bachelorette', 'friends_getaway',
    'general_leisure', 'unclear',
  ],
  why_no_book: [
    'price', 'dates_unavailable', 'no_response', 'went_elsewhere',
    'cancelled_plans', 'not_applicable', 'unclear',
  ],
  decision_timeline: [
    'actively_deciding', 'early_research', 'confirmed_booking',
    'decided_against', 'indeterminate',
  ],
  language: ['en', 'es', 'mixed'],
  extraction_status: [
    'extracted', 'deferred_spanish', 'no_source', 'extraction_failed',
  ],
});

// Field groups, used by validator + flattener.
const SCALAR_TAXONOMY_FIELDS = ['trip_purpose', 'why_no_book', 'decision_timeline', 'language'];
const ARRAY_FREE_TEXT_FIELDS = ['excitement_signals', 'objections', 'specific_features_mentioned'];
const SCALAR_FREE_TEXT_FIELDS = [
  'dates_targeted', 'group_dynamics', 'geographic_hints',
  'communication_style', 'occasion_anniversary_date', 'notes_for_sarah',
];

// All extractable fields — each carries value + confidence + source_message_ids.
const ALL_EXTRACTABLE_FIELDS = [
  ...SCALAR_TAXONOMY_FIELDS,
  ...ARRAY_FREE_TEXT_FIELDS,
  ...SCALAR_FREE_TEXT_FIELDS,
];

const FIELD_GROUPS = Object.freeze({
  scalar_taxonomy: SCALAR_TAXONOMY_FIELDS,
  array_free_text: ARRAY_FREE_TEXT_FIELDS,
  scalar_free_text: SCALAR_FREE_TEXT_FIELDS,
  all: ALL_EXTRACTABLE_FIELDS,
});

// ── System prompt ─────────────────────────────────────────────────────────
// Verbatim from the R4 spec the user supplied. Trailing "[INPUT GOES HERE]"
// is stripped — the user message provides the per-thread input.
const SYSTEM_PROMPT = `You are extracting structured guest dossiers from Airbnb message threads for
La Puesta del Sol, a boutique beachfront resort in Riviera Nayarit, Mexico.
Each dossier becomes a one-page reference Sarah (the host) reads before
writing a personalized reactivation message to a past guest or a
non-converting inquiry.

Your output is consumed by an automated campaign system. Accuracy and honest
"I don't know" are more valuable than rich-sounding inferences.

==================================================================
INPUT
==================================================================

You will receive:
- CONTACT(S): one or more contact records sharing this thread (group
  bookings produce one shared dossier).
- THREAD: the full message thread in chronological order. Each message is
  tagged with [message_id], timestamp, sender role (GUEST or HOST), and body.
- OUTCOME: metadata about whether the guest stayed, inquired only,
  cancelled, etc.

==================================================================
RULES
==================================================================

1. Output strictly valid JSON matching the schema below. No prose outside
   the JSON. No code fences.

2. CITATIONS: every factual claim about the guest must include a
   source_message_ids array listing the [message_id] values the claim
   came from. Empty array means "I'm inferring this from thread tone or
   structure, not a specific message" — use sparingly.

3. CLOSED TAXONOMIES: categorical fields use ONLY values from the closed
   list given. If no value fits, use the explicit \`unclear\` value. Do not
   invent new categories.

4. CONFIDENCE: every field gets a confidence score 0.0–1.0:
   - 0.9–1.0  Stated explicitly in messages
   - 0.7–0.9  Strongly implied by multiple messages
   - 0.4–0.7  Plausible inference from limited evidence
   - 0.0–0.4  Guess; prefer null instead

5. WHEN UNCERTAIN, return null + confidence 0.0. Do NOT guess to fill
   space. Sarah would rather see "we don't know" than a polite-sounding
   fabrication.

6. NEVER fabricate dates, names, occasions, or quoted statements. If the
   thread does not mention an anniversary, do not write that they have one.
   If the thread mentions "summer" but not a year, do not pick a year.

7. notes_for_sarah is a 2–4 sentence narrative Sarah can read in 10
   seconds before writing a message. Reference specific things from the
   thread. Do not pad. Do not flatter.

==================================================================
SCHEMA
==================================================================

{
  "trip_purpose": {
    "value": one of:
      wedding | honeymoon | vow_renewal | family_vacation |
      family_reunion | corporate_retreat | milestone_birthday |
      anniversary_trip | bachelor_bachelorette | friends_getaway |
      general_leisure | unclear,
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "why_no_book": {
    "value": one of:
      price | dates_unavailable | no_response | went_elsewhere |
      cancelled_plans | not_applicable | unclear,
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
    // Use "not_applicable" if the guest stayed.
    // Use "no_response" if the guest stopped replying without giving a reason.
    // Use "went_elsewhere" only if the guest explicitly said they booked elsewhere.
  },

  "excitement_signals": {
    "value": [string, ...],   // 0–5 short phrases naming things the guest
                              // got visibly excited or enthusiastic about
                              // (verbs of enthusiasm, follow-up questions,
                              // emoji clusters, etc.)
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "objections": {
    "value": [string, ...],   // 0–5 short phrases naming concerns,
                              // hesitations, or friction points
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "specific_features_mentioned": {
    "value": [string, ...],   // 0–8 short phrases naming named features,
                              // villas, amenities, or spaces (e.g.,
                              // "Villa Dolphin", "private chef", "rooftop
                              // yoga deck"). Factual references, not
                              // affect.
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "dates_targeted": {
    "value": string or null,  // ISO date range "2024-08-15 to 2024-08-22"
                              // OR month/year "March 2025" if exact dates
                              // unknown. Null if no dates discussed.
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "group_dynamics": {
    "value": string or null,  // ≤200 chars: composition + relationships
                              // (e.g., "couple in their 30s, no kids" or
                              // "extended family, 8 adults + 4 kids
                              // ages 3–12")
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "decision_timeline": {
    "value": one of:
      actively_deciding | early_research | confirmed_booking |
      decided_against | indeterminate,
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "geographic_hints": {
    "value": string or null,  // ≤100 chars: where they're traveling from
                              // (e.g., "Toronto, Canada", "Northern
                              // California"). Null if never mentioned.
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "language": {
    "value": one of: en | es | mixed,
    "confidence": 0.0–1.0,
    "source_message_ids": []  // observed across thread; no specific source
  },

  "communication_style": {
    "value": string or null,  // ≤120 chars: tone descriptor (e.g., "warm
                              // and chatty, frequent emoji, asks lots of
                              // questions" or "terse, business-like, only
                              // logistics")
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "occasion_anniversary_date": {
    "value": string or null,  // ISO date or month/day if a specific
                              // anniversary/birthday/wedding date was
                              // mentioned. Null otherwise — including
                              // when an occasion is mentioned without
                              // a specific date.
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "notes_for_sarah": {
    "value": string,          // 2–4 sentences, ≤500 chars: human-readable
                              // narrative for the host. Reference specifics.
    "confidence": 0.0–1.0,
    "source_message_ids": [string, ...]
  },

  "extraction_status": one of:
    extracted | deferred_spanish | no_source | extraction_failed
    // Use "deferred_spanish" if the thread is primarily Spanish — fill
    // language and extraction_status only, leave the rest null.
    // Use "no_source" if there is no thread at all.
    // Use "extraction_failed" only if the thread is so corrupted you
    // cannot determine even the basics.
}

==================================================================
OUTPUT FORMAT
==================================================================

Respond with ONLY a JSON object matching the schema. No prose outside the JSON.
No code fences. Every extractable field must be present (use null + confidence 0.0
if you don't know). extraction_status is required.`;

// ── JSON Schema for structured outputs ────────────────────────────────────
// Used both at API time (output_config.format) and inside validateDossierJson
// (post-parse second wall). Closed-taxonomy enums are enforced by both layers.
//
// Structured-outputs constraints to remember (per tag-corpus-intents.js
// comment): minItems/maxItems > 1 not supported; numerical min/max not
// supported. Enforce those via the prompt and validator instead.

function fieldShape({ valueSchema, requireValue }) {
  // requireValue=false means value can be null. Confidence and sources are always required.
  const value = requireValue
    ? valueSchema
    : { anyOf: [valueSchema, { type: 'null' }] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'confidence', 'source_message_ids'],
    properties: {
      value,
      confidence: { type: 'number' },
      source_message_ids: { type: 'array', items: { type: 'string' } },
    },
  };
}

const DOSSIER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'trip_purpose', 'why_no_book',
    'excitement_signals', 'objections', 'specific_features_mentioned',
    'dates_targeted', 'group_dynamics', 'decision_timeline',
    'geographic_hints', 'language', 'communication_style',
    'occasion_anniversary_date', 'notes_for_sarah',
    'extraction_status',
  ],
  properties: {
    trip_purpose: fieldShape({
      valueSchema: { type: 'string', enum: TAXONOMIES.trip_purpose },
      requireValue: true,
    }),
    why_no_book: fieldShape({
      valueSchema: { type: 'string', enum: TAXONOMIES.why_no_book },
      requireValue: true,
    }),
    excitement_signals: fieldShape({
      valueSchema: { type: 'array', items: { type: 'string' } },
      requireValue: true,
    }),
    objections: fieldShape({
      valueSchema: { type: 'array', items: { type: 'string' } },
      requireValue: true,
    }),
    specific_features_mentioned: fieldShape({
      valueSchema: { type: 'array', items: { type: 'string' } },
      requireValue: true,
    }),
    dates_targeted: fieldShape({
      valueSchema: { type: 'string' },
      requireValue: false,
    }),
    group_dynamics: fieldShape({
      valueSchema: { type: 'string' },
      requireValue: false,
    }),
    decision_timeline: fieldShape({
      valueSchema: { type: 'string', enum: TAXONOMIES.decision_timeline },
      requireValue: true,
    }),
    geographic_hints: fieldShape({
      valueSchema: { type: 'string' },
      requireValue: false,
    }),
    language: fieldShape({
      valueSchema: { type: 'string', enum: TAXONOMIES.language },
      requireValue: true,
    }),
    communication_style: fieldShape({
      valueSchema: { type: 'string' },
      requireValue: false,
    }),
    occasion_anniversary_date: fieldShape({
      valueSchema: { type: 'string' },
      requireValue: false,
    }),
    notes_for_sarah: fieldShape({
      valueSchema: { type: 'string' },
      requireValue: true,
    }),
    extraction_status: { type: 'string', enum: TAXONOMIES.extraction_status },
  },
};

// ── Role mapping ──────────────────────────────────────────────────────────
function mapMessageRole(accountId, hostAccountIds, opsAccountId) {
  const hostSet = (hostAccountIds instanceof Set)
    ? hostAccountIds
    : new Set(hostAccountIds);
  if (hostSet.has(accountId)) return 'HOST';
  if (opsAccountId != null && accountId === opsAccountId) return 'OPS';
  return 'GUEST';
}

// ── Strict-Spanish detection ──────────────────────────────────────────────
// Strict = both guest text AND host text trip the language=es heuristic.
// Mixed (guest_es / host_en) does NOT defer; the host responses give the
// model enough English to ground itself.
function isStrictlySpanish(thread, hostAccountIds, detectFn) {
  const detect = detectFn || detectLanguage;
  const hostSet = (hostAccountIds instanceof Set) ? hostAccountIds : new Set(hostAccountIds);
  const guestParts = [];
  const hostParts = [];
  for (const env of (thread.messagesAndContents || [])) {
    const m = env && env.message;
    if (!m || m.accountType === 'service' || m.accountId == null) continue;
    const body = extractBody(env);
    if (!body) continue;
    if (hostSet.has(m.accountId)) hostParts.push(body);
    else guestParts.push(body);
  }
  if (guestParts.length === 0 || hostParts.length === 0) return false;
  return detect(guestParts.join(' ')) === 'es' && detect(hostParts.join(' ')) === 'es';
}

function extractBody(envelope) {
  if (!envelope || !envelope.messageContent) return '';
  const c = envelope.messageContent;
  if (c.textContent) {
    const t = c.textContent.body || c.textContent.text;
    if (typeof t === 'string') return t;
  }
  if (c.textAndReferenceContent) {
    const t = c.textAndReferenceContent.body || c.textAndReferenceContent.text;
    if (typeof t === 'string') return t;
  }
  return '';
}

// ── Build per-thread input block ──────────────────────────────────────────
// Format mirrors the example in the system prompt:
//   CONTACT(S):
//     - <name>, contact_id=<n>, relationship_type=<rt> [, last_stay=<date>] [, review_rating=<n>]
//
//   THREAD (<count> messages, <first> to <last>):
//     [<message_id>] <YYYY-MM-DD HH:MM> GUEST|HOST: <body>
//     ...
//
//   OUTCOME: <relationship-derived summary>
//
// `contacts` is the array of contact rows for this thread (group bookings
// can have >1). hostAccountIds is the Set of Sarah accountIds.
function buildThreadInputBlock({ thread, contacts, hostAccountIds, opsAccountId }) {
  const hostSet = (hostAccountIds instanceof Set) ? hostAccountIds : new Set(hostAccountIds);

  // CONTACT(S) block
  const contactLines = (contacts && contacts.length > 0)
    ? contacts.map(c => {
        const parts = [
          c.name || `Airbnb guest ${c.airbnb_account_id}`,
          `contact_id=${c.id}`,
          `relationship_type=${c.relationship_type || 'unknown'}`,
        ];
        if (c.last_stay_date) parts.push(`last_stay=${c.last_stay_date}`);
        if (c.review_rating != null) parts.push(`review_rating=${c.review_rating}`);
        return '  - ' + parts.join(', ');
      })
    : ['  - (no linked contact)'];

  // THREAD block — ordered by createdAt
  const envelopes = (thread.messagesAndContents || [])
    .filter(env => env && env.message && env.message.accountType !== 'service' && env.message.accountId != null)
    .map(env => ({
      m: env.message,
      body: extractBody(env),
    }))
    .filter(x => x.body && x.body.trim())
    .sort((a, b) => String(a.m.createdAt).localeCompare(String(b.m.createdAt)));

  const threadLines = envelopes.map(({ m, body }) => {
    const role = mapMessageRole(m.accountId, hostSet, opsAccountId);
    const ts = formatTimestamp(m.createdAt);
    // Replace newlines in body with " | " so the per-message line stays one line.
    // Preserves readability without distorting message boundaries.
    const oneLineBody = String(body).replace(/\s*\n+\s*/g, ' | ').trim();
    return `  [${m.id}] ${ts} ${role}: ${oneLineBody}`;
  });

  const firstTs = envelopes.length ? formatTimestamp(envelopes[0].m.createdAt, 'date') : 'unknown';
  const lastTs = envelopes.length ? formatTimestamp(envelopes[envelopes.length - 1].m.createdAt, 'date') : 'unknown';

  // OUTCOME block — derived from contacts' relationship_type. Group bookings:
  // mention if multiple distinct relationship_types are present.
  const outcomeLine = buildOutcomeLine(contacts);

  const text = [
    'CONTACT(S):',
    ...contactLines,
    '',
    `THREAD (${envelopes.length} messages, ${firstTs} to ${lastTs}):`,
    ...threadLines,
    '',
    `OUTCOME: ${outcomeLine}`,
  ].join('\n');

  return {
    text,
    messageCount: envelopes.length,
    charCount: text.length,
  };
}

function formatTimestamp(iso, mode) {
  if (!iso) return 'unknown';
  const s = String(iso);
  if (mode === 'date') return s.slice(0, 10);
  // YYYY-MM-DD HH:MM
  return s.slice(0, 10) + ' ' + s.slice(11, 16);
}

function buildOutcomeLine(contacts) {
  if (!contacts || contacts.length === 0) return 'No linked contact in directory.';
  const types = new Set(contacts.map(c => c.relationship_type).filter(Boolean));
  const parts = [];
  for (const c of contacts) {
    const rt = c.relationship_type;
    let descr;
    if (rt === 'past_guest_stayed') {
      descr = `STAYED${c.last_stay_date ? ` (last stay ${c.last_stay_date})` : ''}${c.review_rating != null ? `, review ${c.review_rating}/5` : ''}`;
    } else if (rt === 'past_guest_cancelled') {
      descr = 'CANCELLED a booking';
    } else if (rt === 'past_guest_inquired') {
      descr = 'INQUIRED but did not book';
    } else {
      descr = `relationship_type=${rt || 'unknown'}`;
    }
    parts.push(`${c.name || `contact_id=${c.id}`} — ${descr}`);
  }
  if (types.size > 1) parts.unshift('(group booking, mixed outcomes)');
  return parts.join('; ');
}

// ── JSON validator (second wall after API-side schema) ────────────────────
// Throws a structured error: err.category ∈ {'schema_validation'} on failure.
// Validates every closed taxonomy, confidence ranges, source_message_ids
// shape, and presence of all required top-level keys.
function validateDossierJson(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw schemaError('top-level value is not an object');
  }

  // extraction_status — required, enum-checked.
  const status = parsed.extraction_status;
  if (!TAXONOMIES.extraction_status.includes(status)) {
    throw schemaError(`extraction_status not in enum: ${JSON.stringify(status)}`);
  }

  // Deferred / no_source / extraction_failed: skip extractable-field validation.
  // The script writes the row with all extraction fields null in those cases,
  // and the model is allowed to either omit them or send nulls.
  if (status !== 'extracted') {
    return; // permissive — extraction_status already validated above
  }

  // Validate every extractable field.
  for (const field of ALL_EXTRACTABLE_FIELDS) {
    const f = parsed[field];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw schemaError(`field ${field} is missing or not an object`);
    }
    if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) {
      throw schemaError(`field ${field}.confidence must be number in [0, 1], got ${JSON.stringify(f.confidence)}`);
    }
    if (!Array.isArray(f.source_message_ids) || !f.source_message_ids.every(s => typeof s === 'string')) {
      throw schemaError(`field ${field}.source_message_ids must be array of strings`);
    }
    validateValueShape(field, f.value);
  }
}

function validateValueShape(field, value) {
  // Closed taxonomies: value is required string from the enum.
  if (SCALAR_TAXONOMY_FIELDS.includes(field)) {
    if (typeof value !== 'string') {
      throw schemaError(`field ${field}.value must be string from taxonomy, got ${JSON.stringify(value)}`);
    }
    const enumList = TAXONOMIES[field];
    if (!enumList.includes(value)) {
      throw schemaError(`field ${field}.value=${JSON.stringify(value)} not in enum [${enumList.join(', ')}]`);
    }
    return;
  }
  // Array free-text: value is required string array.
  if (ARRAY_FREE_TEXT_FIELDS.includes(field)) {
    if (!Array.isArray(value) || !value.every(s => typeof s === 'string')) {
      throw schemaError(`field ${field}.value must be array of strings`);
    }
    return;
  }
  // Scalar free-text: value is string OR null.
  if (SCALAR_FREE_TEXT_FIELDS.includes(field)) {
    if (value !== null && typeof value !== 'string') {
      throw schemaError(`field ${field}.value must be string or null, got ${typeof value}`);
    }
    return;
  }
  throw new Error(`internal: unknown field group for ${field}`);
}

function schemaError(msg) {
  const e = new Error(`schema_validation: ${msg}`);
  e.category = 'schema_validation';
  return e;
}

// ── Flatten parsed dossier to row matching migration 009 schema ───────────
// `airbnbThreadId` is the thread.id (number → toString); `contactIds` is an
// array of contacts.id integers; `model` is e.g. 'claude-sonnet-4-6'.
// `status` overrides the parsed extraction_status (used for pre-write
// deferred_spanish or extraction_failed paths).
function flattenForInsert({ parsed, airbnbThreadId, contactIds, model, status, lastError }) {
  const finalStatus = status || (parsed && parsed.extraction_status) || 'extraction_failed';
  const row = {
    airbnb_thread_id: String(airbnbThreadId),
    contact_ids: JSON.stringify(contactIds || []),
    extraction_status: finalStatus,
    last_attempt_error: lastError || null,
    extraction_model: model,
    reviewed_by_human: 0,
  };

  // Initialize all extractable columns to null.
  for (const field of ALL_EXTRACTABLE_FIELDS) {
    row[field] = null;
    row[`${field}_confidence`] = null;
    row[`${field}_source_message_ids`] = null;
  }

  // Only populate when the status is 'extracted' AND parsed is non-null.
  if (finalStatus === 'extracted' && parsed) {
    for (const field of ALL_EXTRACTABLE_FIELDS) {
      const f = parsed[field];
      if (!f) continue;
      // value: arrays go to JSON.stringify, scalars (string|null) pass through.
      const isArrayField = ARRAY_FREE_TEXT_FIELDS.includes(field);
      row[field] = isArrayField
        ? (Array.isArray(f.value) ? JSON.stringify(f.value) : null)
        : (f.value == null ? null : String(f.value));
      row[`${field}_confidence`] = (typeof f.confidence === 'number') ? f.confidence : null;
      row[`${field}_source_message_ids`] = Array.isArray(f.source_message_ids)
        ? JSON.stringify(f.source_message_ids)
        : null;
    }
  } else if (finalStatus === 'deferred_spanish') {
    // Per the prompt: "fill language and extraction_status only, leave the rest null."
    // We pre-detect this case before the LLM call, so language is set programmatically.
    row.language = 'es';
    row.language_confidence = 1.0;
    row.language_source_message_ids = JSON.stringify([]);
  }

  return row;
}

// ── API error classification ──────────────────────────────────────────────
// retryable=true: transient (429, 5xx, timeout, fetch).
// retryable=false: schema violation, bad request, auth, anything we shouldn't burn money on.
function classifyApiError(err) {
  if (!err) return { retryable: false, category: 'api_other' };

  // Pre-classified by validateDossierJson / JSON.parse.
  if (err.category === 'schema_validation') return { retryable: false, category: 'schema_validation' };
  if (err.category === 'json_parse') return { retryable: false, category: 'json_parse' };
  if (err.category === 'max_tokens_truncation') return { retryable: false, category: 'max_tokens_truncation' };

  // Anthropic SDK errors carry a numeric status; node fetch surfaces err.code.
  const status = err.status || (err.response && err.response.status) || null;
  const code = err.code || (err.cause && err.cause.code) || null;
  const msg = String(err.message || '');

  if (status === 429) return { retryable: true, category: 'api_429' };
  if (typeof status === 'number' && status >= 500 && status <= 599) return { retryable: true, category: 'api_5xx' };
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN' || /timeout/i.test(msg)) {
    return { retryable: true, category: 'timeout' };
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { retryable: false, category: 'api_other' };
  }
  // Unknown — be conservative and not retry. Avoids burning $$$ on an
  // unbounded loop when the failure is something we'd want a human to see.
  return { retryable: false, category: 'api_other' };
}

module.exports = {
  // constants
  SYSTEM_PROMPT,
  DOSSIER_JSON_SCHEMA,
  TAXONOMIES,
  FIELD_GROUPS,
  ALL_EXTRACTABLE_FIELDS,
  ARRAY_FREE_TEXT_FIELDS,
  SCALAR_TAXONOMY_FIELDS,
  SCALAR_FREE_TEXT_FIELDS,
  // helpers
  buildThreadInputBlock,
  mapMessageRole,
  isStrictlySpanish,
  validateDossierJson,
  flattenForInsert,
  classifyApiError,
  // exposed for tests
  extractBody,
  buildOutcomeLine,
};
