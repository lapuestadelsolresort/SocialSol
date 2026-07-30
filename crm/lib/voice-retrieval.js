'use strict';
//
// voice-retrieval.js — Chroma similarity search over sarah_voice_corpus.
//
// Always uses queryEmbeddings (NOT queryTexts). Chroma's
// DefaultEmbeddingFunction package is not installed, and even if it were,
// it would produce vectors in a different space than the OpenAI
// text-embedding-3-small ones the indexer wrote. queryTexts here would
// either crash or silently return wrong-space neighbors. The unit suite
// asserts the call shape stays queryEmbeddings.
//
// Filter shape: { language: 'en', recipient_relationship?, intent_tags? }.
// When recipient_relationship is supplied, the 20 R1-orphan rows
// (recipient_relationship='unknown') are excluded by construction —
// they only appear in un-filtered queries.

const { embedQuery } = require('./openai-embed');

const DEFAULT_TOP_K = 8;
// Cosine distance for OpenAI text-embedding-3-small lives in [0, 2].
// 0.7–0.9 = high semantic match (R2's sample query landed here because
// it echoed actual message wording). 0.9–1.25 = typical real-world
// query (message_context describes the situation rather than mimicking
// Sarah's response style). 1.5+ = stretching even the stylistic-anchor
// case. Empirical span across the 3 R3 verification queries: 0.90–1.25,
// so 1.5 has ~0.25 headroom while still rejecting genuinely off-domain
// noise. The companion low_exemplar_count warning (routes/voice-draft.js)
// fires when post-filter survives < 3 — that's the graceful-degradation
// contract for queries where 1.5 is still too tight.
const DEFAULT_MAX_DISTANCE = 1.5;

// Build a Chroma `where` clause from filter inputs. Chroma requires a
// $and wrapper when combining multiple metadata filters.
function buildWhere({ language = 'en', recipientRelationship, intentTag }) {
  const clauses = [];
  if (language) clauses.push({ language: { $eq: String(language) } });
  if (recipientRelationship) clauses.push({ recipient_relationship: { $eq: String(recipientRelationship) } });
  if (intentTag) clauses.push({ intent_tags: { $eq: String(intentTag) } });
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

async function retrieveExemplars(collection, {
  queryText,
  language = 'en',
  recipientRelationship,
  intentTag,
  topK = DEFAULT_TOP_K,
  maxDistance = DEFAULT_MAX_DISTANCE,
  excludeIds = [],
}) {
  if (!collection) throw new Error('retrieveExemplars: collection is required');
  if (!queryText) throw new Error('retrieveExemplars: queryText is required');

  const { embedding, totalTokens } = await embedQuery(queryText);

  const where = buildWhere({ language, recipientRelationship, intentTag });

  // Over-fetch when excludeIds is non-empty so post-filtering still hits topK.
  const nResults = topK + (excludeIds.length || 0);

  const result = await collection.query({
    queryEmbeddings: [embedding],
    nResults,
    where,
  });

  // result is shaped as columnar arrays (one slot per query input).
  // We sent a single query, so always read [0].
  const ids = (result.ids && result.ids[0]) || [];
  const distances = (result.distances && result.distances[0]) || [];
  const documents = (result.documents && result.documents[0]) || [];
  const metadatas = (result.metadatas && result.metadatas[0]) || [];

  const excludeSet = new Set(excludeIds.map(String));
  const exemplars = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (excludeSet.has(String(id))) continue;
    const distance = distances[i];
    if (typeof distance === 'number' && distance > maxDistance) continue;
    exemplars.push({
      id,
      distance,
      document: documents[i],
      metadata: metadatas[i] || {},
    });
    if (exemplars.length >= topK) break;
  }

  return {
    exemplars,
    embeddingTokens: totalTokens,
  };
}

module.exports = {
  retrieveExemplars,
  buildWhere,
  DEFAULT_TOP_K,
  DEFAULT_MAX_DISTANCE,
};
