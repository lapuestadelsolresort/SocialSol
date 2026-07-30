'use strict';
//
// vision-caption.js — Claude Sonnet 4.6 vision wrapper that returns a
// JSON tag object per keyframe and an optional roll-up synopsis per clip.
//
// Cost model (Sonnet 4.6, as of plan): input ~$3/MTok, output ~$15/MTok.
// A 480p JPEG keyframe ~6 KB → ~700 input tokens; output ~220 tokens →
// ~$0.005 per frame. 850 frames → ~$4.25.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { getAnthropicKey } = require('../../crm/lib/anthropic-key');
const { VISION_SYSTEM_PROMPT, SYNOPSIS_SYSTEM_PROMPT } = require('./tag-taxonomy');

const MODEL = 'claude-sonnet-4-6';

let _client = null;
function client() {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: getAnthropicKey() });
  return _client;
}

function imageBlock(jpegPath) {
  const b64 = fs.readFileSync(jpegPath).toString('base64');
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
  };
}

function safeParseJson(text) {
  const s = String(text).trim();
  // Strip a leading ```json ... ``` fence if Claude ignored "no fencing".
  const stripped = s.replace(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/m, '$1').trim();
  // Try whole-string first.
  try { return JSON.parse(stripped); } catch {}
  // Brace-balanced scan for the FIRST valid JSON object. Handles trailing
  // prose ("here's the JSON: {...} let me know if you want changes")
  // without greedy-matching past the first object into prose-embedded {}.
  const start = stripped.indexOf('{');
  if (start === -1) throw new Error('vision response had no JSON object');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try { return JSON.parse(candidate); }
        catch (e) { throw new Error(`vision JSON parse failed: ${e.message}: ${candidate.slice(0, 200)}`); }
      }
    }
  }
  throw new Error(`vision response had unbalanced JSON braces: ${stripped.slice(0, 200)}`);
}

// Per-frame caption. Returns {caption, tags, persona_fit, usable, cost_usd, raw}.
async function captionFrame(jpegPath, { contextHint = '' } = {}) {
  const userText = contextHint
    ? `Context (do not echo this, just use it to inform your tags): ${contextHint}\n\nCatalog this single frame as a JSON object now.`
    : 'Catalog this single frame as a JSON object now.';
  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 600,
    system: VISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [imageBlock(jpegPath), { type: 'text', text: userText }] }],
  });
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = safeParseJson(text);
  const u = resp.usage || {};
  const cost = ((u.input_tokens || 0) * 3 / 1e6) + ((u.output_tokens || 0) * 15 / 1e6);
  return {
    caption: parsed.caption || '',
    setting: parsed.setting || 'unknown',
    mood: parsed.mood || 'serene',
    people: parsed.people || 'none',
    camera_motion: parsed.camera_motion || 'static',
    time_of_day: parsed.time_of_day || 'unknown',
    persona_fit: parsed.persona_fit || {},
    usable: parsed.usable !== false,
    notes: parsed.notes || '',
    cost_usd: Number(cost.toFixed(5)),
    raw: parsed,
  };
}

// Clip-level synopsis. Sends N keyframes + per-frame tags + (optional)
// transcript snippet. Returns {synopsis, tags, persona_fit, usable,
// searchable_text, cost_usd}.
async function synthesizeClip({ keyframes, perFrame, transcriptSnippet = '', durationMs = 0, sourceRole = '' }) {
  const summary = perFrame.map((p, i) => ({
    frame_idx: i,
    timestamp_ms: keyframes[i] && keyframes[i].timestamp_ms,
    caption: p.caption,
    setting: p.setting,
    mood: p.mood,
    people: p.people,
    camera_motion: p.camera_motion,
    time_of_day: p.time_of_day,
    usable: p.usable,
    notes: p.notes,
  }));
  const userBlocks = [];
  for (const kf of keyframes) {
    userBlocks.push(imageBlock(kf.frame_path));
  }
  const ctx = {
    source_role: sourceRole,
    duration_ms: durationMs,
    keyframe_tags: summary,
    transcript_snippet: transcriptSnippet ? transcriptSnippet.slice(0, 800) : '',
  };
  userBlocks.push({ type: 'text', text: `Roll up this clip. Context:\n\n${JSON.stringify(ctx)}\n\nReturn the synopsis JSON now.` });

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYNOPSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userBlocks }],
  });
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = safeParseJson(text);
  const u = resp.usage || {};
  const cost = ((u.input_tokens || 0) * 3 / 1e6) + ((u.output_tokens || 0) * 15 / 1e6);

  const tagBits = [
    ...(parsed.tags && parsed.tags.setting || []),
    ...(parsed.tags && parsed.tags.mood || []),
    parsed.tags && parsed.tags.people,
    parsed.tags && parsed.tags.time_of_day,
    ...(parsed.tags && parsed.tags.camera_motion || []),
  ].filter(Boolean);
  const searchable = [
    parsed.synopsis || '',
    transcriptSnippet ? `Transcript snippet: ${transcriptSnippet.slice(0, 400)}` : '',
    'Tags: ' + tagBits.join(', '),
  ].filter(Boolean).join('\n\n');

  return {
    synopsis: parsed.synopsis || '',
    tags: parsed.tags || {},
    persona_fit: parsed.persona_fit || {},
    usable: parsed.usable !== false,
    searchable_text: searchable,
    cost_usd: Number(cost.toFixed(5)),
    raw: parsed,
  };
}

module.exports = { captionFrame, synthesizeClip, MODEL };
