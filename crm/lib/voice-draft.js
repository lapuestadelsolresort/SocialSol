'use strict';
//
// voice-draft.js — Sonnet 4.6 voice-conditioned draft generation.
//
// System prompt (voice-spec §4 + invariant role) is cached via
// cache_control:{type:'ephemeral'}. The exemplar block + task block live
// in the user turn so the cached prefix is reused across drafts even as
// per-call exemplars and message_context vary.
//
// Defaults: thinking disabled, effort 'low'. Voice generation is a
// chat-shaped task — exemplars do the work, reasoning would only add
// latency and verbose drafts. Override at call site if a specific
// intent ever needs deeper deliberation.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getAnthropicKey } = require('./anthropic-key');
// Shared §4 contract — both consumers (this Voice Service and Paulina's
// composer) MUST use the identical regex. The byte-equality is asserted
// in crm/test/voice-draft.test.js so a future drift fails CI.
const {
  VOICE_SPEC_SECTION_4_REGEX,
  loadSection4: loadVoiceSpecSection4,
} = require('../../prospector/lib/voice-spec-section');

const MODEL = 'claude-sonnet-4-6';
const VOICE_SPEC_PATH = path.join(__dirname, '..', '..', 'prospector', 'voice-spec.md');

function loadVoiceConstraintsBlock() {
  const block = loadVoiceSpecSection4(VOICE_SPEC_PATH);
  if (!block) {
    throw new Error(`voice-spec.md does not contain "## 4." → "## 5." block. Paulina's composer also depends on this.`);
  }
  return block;
}

function readVoiceSpecVersion() {
  // First non-empty line after the H1 — if rebuild-voice-spec.js writes a
  // version marker like "v1 — auto-generated 2026-05-07", this picks it up.
  try {
    const raw = fs.readFileSync(VOICE_SPEC_PATH, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      if (t.startsWith('# ')) continue;
      return t.slice(0, 120);
    }
  } catch (e) { /* fall through */ }
  return 'unknown';
}

let _client = null;
function client() {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: getAnthropicKey() });
  return _client;
}

// Test-only: inject a mock client to stub Anthropic in unit tests.
// The mock must implement messages.create({...}) → {content, usage, model, stop_reason}.
function _setClientForTesting(c) { _client = c; }

const SYSTEM_HEADER = [
  'You are drafting a message in Sarah\'s voice. Sarah owns and runs La Puesta del Sol Resort. She writes warm, direct, brief messages — never marketing-speak.',
  '',
  'You will receive:',
  '  1. A static voice spec (the constraints block below).',
  '  2. A handful of real exemplar messages Sarah has written in similar contexts.',
  '  3. A task: the intent, recipient relationship, target length, and the message_context to respond to.',
  '',
  'Your job is to produce ONE draft message in Sarah\'s voice that fits the task. Output ONLY the draft text — no preamble, no commentary, no markdown fencing, no signature beyond what the voice spec calls for.',
  '',
  '── SARAH-VOICE CONSTRAINTS (voice-spec §4) ──',
].join('\n');

function buildSystemBlocks(voiceConstraints) {
  // Single cacheable text block. Cache breakpoint at the end caches the
  // entire system across calls — voice spec changes only when the rebuild
  // script lands a new file.
  return [
    {
      type: 'text',
      text: `${SYSTEM_HEADER}\n${voiceConstraints}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

function buildUserPrompt({ intent, recipientRelationship, messageContext, draftLength, exemplars }) {
  const exemplarBlock = exemplars.length === 0
    ? '(no exemplars retrieved — proceed from the voice spec only)'
    : exemplars.map((e, i) => {
        const rel = (e.metadata && e.metadata.recipient_relationship) || 'unknown';
        const sentAt = (e.metadata && e.metadata.sent_at) || '';
        return `--- exemplar ${i + 1} (relationship=${rel}, sent_at=${sentAt}, distance=${(e.distance || 0).toFixed(3)}) ---\n${e.document || ''}`;
      }).join('\n\n');

  const lengthLine = draftLength
    ? `Target length: ${draftLength.min || 40}–${draftLength.max || 160} words.`
    : 'Target length: 40–160 words.';

  return [
    `Intent: ${intent}`,
    recipientRelationship ? `Recipient relationship: ${recipientRelationship}` : 'Recipient relationship: (unspecified)',
    lengthLine,
    '',
    'Message context (what you are responding to / writing about):',
    messageContext,
    '',
    'Stylistic exemplars from Sarah\'s real messages:',
    exemplarBlock,
    '',
    'Now write the draft.',
  ].join('\n');
}

// Sonnet 4.6 pricing: $3 / 1M input tokens, $15 / 1M output. Cache reads
// are ~0.1×, cache writes ~1.25× of input price.
function computeCost(usage) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    (input * 3.0 / 1_000_000) +
    (output * 15.0 / 1_000_000) +
    (cacheCreate * 3.75 / 1_000_000) +
    (cacheRead * 0.30 / 1_000_000)
  );
}

async function generateDraft({
  intent,
  recipientRelationship,
  messageContext,
  draftLength,
  exemplars,
}) {
  const voiceConstraints = loadVoiceConstraintsBlock();
  const system = buildSystemBlocks(voiceConstraints);
  const userPrompt = buildUserPrompt({ intent, recipientRelationship, messageContext, draftLength, exemplars });

  const maxOutput = Math.max(512, Math.ceil(((draftLength && draftLength.max) || 160) * 4) + 64);

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: maxOutput,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlocks = resp.content.filter((b) => b.type === 'text');
  const draftText = textBlocks.map((b) => b.text).join('\n').trim();

  return {
    draftText,
    modelUsed: resp.model || MODEL,
    voiceSpecVersion: readVoiceSpecVersion(),
    tokens: {
      input: resp.usage.input_tokens || 0,
      output: resp.usage.output_tokens || 0,
      cache_creation: resp.usage.cache_creation_input_tokens || 0,
      cache_read: resp.usage.cache_read_input_tokens || 0,
    },
    costUsd: computeCost(resp.usage || {}),
    stopReason: resp.stop_reason,
  };
}

module.exports = {
  generateDraft,
  loadVoiceConstraintsBlock,
  readVoiceSpecVersion,
  computeCost,
  _setClientForTesting,
  MODEL,
  VOICE_SPEC_PATH,
  // Re-exported for the regex-sync unit test (D12-style invariant).
  VOICE_SPEC_SECTION_4_REGEX,
};
