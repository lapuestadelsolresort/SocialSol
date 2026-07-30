'use strict';
//
// openai-embed.js — query-time text embedding for the Voice Service.
//
// MUST stay locked to the model the indexer used. Mismatched embedding
// models produce vectors in different spaces; the resulting Chroma
// queries return silently-wrong neighbors with no error surfaced.
// See crm/scripts/index-voice-corpus.js (uses the same model string).
//
// Why a separate module instead of reusing the indexer's embedBatch:
// the indexer is a CLI script, not a library; lifting just the HTTP
// call here keeps the route handler free of CLI concerns.

const { getOpenAIKey } = require('./openai-key');

// Pinned to match crm/scripts/index-voice-corpus.js default --model.
// Test crm/test/voice-draft.test.js asserts these are identical.
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
let _embedderForTesting = null;

async function embedQuery(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('embedQuery: text must be a non-empty string');
  }
  if (_embedderForTesting) return _embedderForTesting(text);
  const apiKey = getOpenAIKey();
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: text, model: EMBEDDING_MODEL }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (!Array.isArray(json.data) || json.data.length !== 1) {
    throw new Error(`OpenAI returned ${json.data ? json.data.length : 'no'} embeddings for 1 input`);
  }
  return {
    embedding: json.data[0].embedding,
    promptTokens: (json.usage && json.usage.prompt_tokens) || 0,
    totalTokens: (json.usage && json.usage.total_tokens) || 0,
  };
}

function _setEmbedderForTesting(embedder) {
  _embedderForTesting = embedder;
}

module.exports = { embedQuery, EMBEDDING_MODEL, EMBEDDING_DIM, _setEmbedderForTesting };
