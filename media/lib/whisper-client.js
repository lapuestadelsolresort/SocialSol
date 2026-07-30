'use strict';
//
// whisper-client.js — OpenAI Whisper API wrapper for the media pipeline.
//
// Whisper API limit: 25 MB per request. At 16 kHz mono pcm_s16le that's
// ~13 minutes. We chunk anything longer at a fixed 10-minute interval
// and stitch the segments back with absolute-time offsets.

const fs = require('fs');
const path = require('path');
const { getOpenAIKey } = require('../../crm/lib/openai-key');
const { extractAudioForWhisper } = require('./ffmpeg-helpers');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';
const CHUNK_SECONDS = 600;          // 10 min — well under the 25 MB limit
const COST_PER_MINUTE_USD = 0.006;  // OpenAI Whisper API rate

// FormData lives in Node 18+ globals (undici). Use fetch + FormData natively.
async function transcribeFile(wavPath, { language = 'en' } = {}) {
  const apiKey = getOpenAIKey();
  const form = new FormData();
  const buf = fs.readFileSync(wavPath);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);

  const res = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

// Transcribe an audio source of arbitrary length. Chunks into 10-min
// 16 kHz mono pcm_s16le segments, sends each, stitches.
async function transcribeAudioSource(srcPath, { language = 'en', tmpDir, durationSec = null }) {
  fs.mkdirSync(tmpDir, { recursive: true });

  // Probe duration if not provided.
  if (!durationSec) {
    const { ffprobeJson, probeSummary } = require('./ffmpeg-helpers');
    const sum = probeSummary(await ffprobeJson(srcPath));
    durationSec = (sum.duration_ms || 0) / 1000;
  }

  const chunks = [];
  let pos = 0, idx = 0;
  while (pos < durationSec) {
    const len = Math.min(CHUNK_SECONDS, durationSec - pos);
    const out = path.join(tmpDir, `chunk_${String(idx).padStart(3, '0')}.wav`);
    await extractAudioForWhisper(srcPath, out, { startSec: pos, durationSec: len });
    chunks.push({ idx, startSec: pos, lengthSec: len, path: out });
    pos += len;
    idx++;
  }

  let fullText = '';
  const allSegments = [];
  let detectedLang = null;

  for (const c of chunks) {
    const t = await transcribeFile(c.path, { language });
    if (!detectedLang && t.language) detectedLang = t.language;
    if (t.text) fullText += (fullText ? ' ' : '') + t.text.trim();
    if (Array.isArray(t.segments)) {
      for (const s of t.segments) {
        allSegments.push({
          start_ms: Math.round((c.startSec + (s.start || 0)) * 1000),
          end_ms: Math.round((c.startSec + (s.end || 0)) * 1000),
          text: s.text,
        });
      }
    }
    // Cleanup chunk file (cheap; keeps tmpDir small)
    try { fs.unlinkSync(c.path); } catch {}
  }

  const minutes = durationSec / 60;
  return {
    text: fullText,
    segments: allSegments,
    language: detectedLang || language,
    duration_sec: durationSec,
    cost_usd: Number((minutes * COST_PER_MINUTE_USD).toFixed(4)),
    n_chunks: chunks.length,
  };
}

module.exports = { transcribeFile, transcribeAudioSource, MODEL, COST_PER_MINUTE_USD };
