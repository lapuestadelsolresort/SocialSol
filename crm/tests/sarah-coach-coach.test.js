'use strict';
//
// sarah-coach-coach.test.js — pins the pure builders that coach.js relies on
// for its Slack output. The end-to-end fetch + Slack-subprocess path is left
// to production verification (per plan); these tests pin the message shapes
// so the OCR-preamble and code-fence contracts don't drift silently.

const test = require('node:test');
const assert = require('node:assert/strict');

const slackFmt = require('../../sarah-coach/lib/slack-format');

// ── buildDraftMessage ────────────────────────────────────────────────────

test('buildDraftMessage: text-only paste — no OCR preamble, fenced body', () => {
  const msg = slackFmt.buildDraftMessage({
    inboundText: 'Hi! Looking at March dates.',
    draftText: 'Hi Anna, March is wide open — would love to host.',
    isFromImage: false,
  });
  assert.match(msg, /^🪶 Draft for inbound message/);
  assert.doesNotMatch(msg, /Read this from your screenshot/);
  assert.match(msg, /```\nHi Anna, March is wide open — would love to host\.\n```/);
  assert.match(msg, /Reply `!sent`/);
});

test('buildDraftMessage: image paste — OCR preamble + quote block + fenced draft', () => {
  const msg = slackFmt.buildDraftMessage({
    inboundText: 'Hey is March 14 available?\nFor 6 people',
    draftText: 'Hi! Yes, March 14 is open.',
    isFromImage: true,
  });
  assert.match(msg, /Read this from your screenshot:/);
  // Quote block prefixes every non-empty line with `> `
  assert.match(msg, /> Hey is March 14 available\?/);
  assert.match(msg, /> For 6 people/);
  assert.match(msg, /```\nHi! Yes, March 14 is open\.\n```/);
});

test('buildDraftMessage: empty quoted line in image source becomes bare `>`', () => {
  const msg = slackFmt.buildDraftMessage({
    inboundText: 'first\n\nsecond',
    draftText: 'reply',
    isFromImage: true,
  });
  // The blank line between paragraphs becomes a bare `>` so the quote
  // block stays a single visual unit in Slack.
  assert.match(msg, /> first\n>\n> second/);
});

// ── error / status builders ──────────────────────────────────────────────

test('buildVoiceServiceDownPost: starts with ❌ and embeds the reason', () => {
  const msg = slackFmt.buildVoiceServiceDownPost('chroma timeout');
  assert.match(msg, /^❌ Voice Service unreachable: chroma timeout/);
  assert.match(msg, /openclaw doctor/);
});

test('buildCouldntReadWarning: starts with ⚠️', () => {
  assert.match(slackFmt.buildCouldntReadWarning(), /^⚠️ I couldn't read anything/);
});

test('buildGenericDraftFailure: points to #ops', () => {
  assert.match(slackFmt.buildGenericDraftFailure(), /#ops/);
});

test('buildNotAuthorized: ❌ Not authorized', () => {
  assert.equal(slackFmt.buildNotAuthorized(), '❌ Not authorized.');
});

test('buildSentAck: ✅ Logged.', () => {
  assert.equal(slackFmt.buildSentAck(), '✅ Logged.');
});

test('buildEditAck: ✅ Logged ({N} chars edited)', () => {
  assert.equal(slackFmt.buildEditAck(17), '✅ Logged (17 chars edited).');
});

test('buildNoDraftFoundForThread: ⚠️ couldn\'t find', () => {
  assert.match(slackFmt.buildNoDraftFoundForThread(), /^⚠️ Couldn't find/);
});
