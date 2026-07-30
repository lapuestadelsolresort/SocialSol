'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractEditedText } = require('../../regina/scripts/sent');
const { extractReason } = require('../../regina/scripts/skip');
const { extractDays, addDaysIso } = require('../../regina/scripts/defer');

// ── extractEditedText (sent.js) ──────────────────────────────────────────

test('extractEditedText: bare !sent → empty string', () => {
  assert.equal(extractEditedText('!sent'), '');
});

test('extractEditedText: !sent with whitespace → empty', () => {
  assert.equal(extractEditedText('  !sent  '), '');
});

test('extractEditedText: edited text + space + !sent', () => {
  assert.equal(
    extractEditedText('Hi Patricia, just touching base — Sarah !sent'),
    'Hi Patricia, just touching base — Sarah'
  );
});

test('extractEditedText: edited text + newline + !sent', () => {
  assert.equal(
    extractEditedText('Hi Patricia,\n\nHope you are well — Sarah\n!sent'),
    'Hi Patricia,\n\nHope you are well — Sarah'
  );
});

test('extractEditedText: !sent in middle is NOT stripped (only trailing)', () => {
  assert.equal(
    extractEditedText('I already !sent the message yesterday'),
    'I already !sent the message yesterday'
  );
});

// ── extractReason (skip.js) ──────────────────────────────────────────────

test('extractReason: !skip alone → unspecified', () => {
  assert.equal(extractReason('!skip'), 'unspecified');
});

test('extractReason: !skip with reason text', () => {
  assert.equal(extractReason('!skip not the right moment'), 'not the right moment');
});

test('extractReason: !skip with whitespace + reason', () => {
  assert.equal(extractReason('  !skip   bad timing  '), 'bad timing');
});

test('extractReason: text without !skip → unspecified', () => {
  assert.equal(extractReason('this is not a skip'), 'unspecified');
});

// ── extractDays + addDaysIso (defer.js) ──────────────────────────────────

test('extractDays: !defer 14 → 14', () => {
  assert.equal(extractDays('!defer 14'), 14);
});

test('extractDays: !defer 1 → 1', () => {
  assert.equal(extractDays('!defer 1'), 1);
});

test('extractDays: !defer 365 → 365', () => {
  assert.equal(extractDays('!defer 365'), 365);
});

test('extractDays: !defer 0 → null (out of range)', () => {
  assert.equal(extractDays('!defer 0'), null);
});

test('extractDays: !defer 400 → null (out of range)', () => {
  assert.equal(extractDays('!defer 400'), null);
});

test('extractDays: !defer abc → null', () => {
  assert.equal(extractDays('!defer abc'), null);
});

test('extractDays: !defer with no arg → null', () => {
  assert.equal(extractDays('!defer'), null);
});

test('addDaysIso: returns ISO timestamp days in the future', () => {
  const result = addDaysIso(7);
  const parsed = new Date(result);
  const now = new Date();
  const diffDays = (parsed.getTime() - now.getTime()) / 86400000;
  assert.ok(diffDays > 6.9 && diffDays < 7.1, `diffDays=${diffDays}`);
});
