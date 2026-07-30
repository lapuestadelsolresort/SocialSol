'use strict';
//
// reconcile-similarity.js — character-level Levenshtein-based similarity
// scorer for Gmail reconciliation.
//
// similarity = 1 - lev(a, b) / max(len(a), len(b))
//   - identical strings  → 1.0
//   - completely disjoint of equal length → ~0.0
//   - empty strings      → 1.0 (defined as identical for our purposes)
//
// Thresholds (configurable via reconcile config):
//   ≥ 0.6  auto-mark
//   0.4 .. 0.6  possible match (Slack notification, no auto-mark)
//   < 0.4  no match

const levenshtein = require('fast-levenshtein');

function normalize(s) {
  if (s == null) return '';
  // Lowercase + collapse whitespace + strip leading/trailing punctuation/space.
  // Email replies often add "On <date>... wrote:" quote blocks; the caller is
  // expected to strip those before passing in. We only do conservative
  // whitespace normalization here.
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 && nb.length === 0) return 1;
  const dist = levenshtein.get(na, nb);
  const denom = Math.max(na.length, nb.length);
  if (denom === 0) return 1;
  return 1 - dist / denom;
}

function rawDistance(a, b) {
  return levenshtein.get(String(a || ''), String(b || ''));
}

function classify(score, { autoMark = 0.6, possibleMatch = 0.4 } = {}) {
  if (score >= autoMark) return 'auto_mark';
  if (score >= possibleMatch) return 'possible_match';
  return 'no_match';
}

module.exports = { similarity, rawDistance, classify, normalize };
