'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { similarity, classify, normalize, rawDistance } =
  require('../../regina/lib/reconcile-similarity');

test('similarity: identical strings → 1.0', () => {
  assert.equal(similarity('hello world', 'hello world'), 1);
});

test('similarity: empty strings → 1.0 (defined as identical)', () => {
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity(null, null), 1);
});

test('similarity: one empty + one non-empty → 0', () => {
  assert.equal(similarity('hi', ''), 0);
  assert.equal(similarity('', 'hello'), 0);
});

test('similarity: case + whitespace normalization', () => {
  assert.equal(similarity('Hello World', 'hello   world'), 1);
});

test('similarity: small edit yields high score', () => {
  const score = similarity('Hi Patricia, just touching base', 'Hi Patricia, just touching base!');
  assert.ok(score > 0.95, `score=${score}`);
});

test('similarity: large edit yields lower score', () => {
  const a = 'Hi Patricia, hope your summer is going well!';
  const b = 'Hi Patricia, hope your summer is great. Drop me a line — Sarah.';
  const score = similarity(a, b);
  assert.ok(score > 0.4 && score < 0.85, `score=${score}`);
});

test('similarity: completely different strings → low score', () => {
  // Use strings with no overlapping characters at all (incl. spaces).
  const score = similarity('aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb');
  assert.ok(score < 0.05, `score=${score}`);
});

test('classify: ≥ 0.6 → auto_mark', () => {
  assert.equal(classify(0.6), 'auto_mark');
  assert.equal(classify(0.95), 'auto_mark');
});

test('classify: 0.4 ≤ x < 0.6 → possible_match', () => {
  assert.equal(classify(0.4), 'possible_match');
  assert.equal(classify(0.59), 'possible_match');
});

test('classify: < 0.4 → no_match', () => {
  assert.equal(classify(0.39), 'no_match');
  assert.equal(classify(0), 'no_match');
});

test('classify: custom thresholds', () => {
  assert.equal(classify(0.5, { autoMark: 0.45, possibleMatch: 0.3 }), 'auto_mark');
  assert.equal(classify(0.35, { autoMark: 0.45, possibleMatch: 0.3 }), 'possible_match');
});

test('normalize: collapses whitespace + lowercases', () => {
  assert.equal(normalize('  HELLO\n  World  '), 'hello world');
});

test('rawDistance: matches reference', () => {
  assert.equal(rawDistance('kitten', 'sitting'), 3);
});
