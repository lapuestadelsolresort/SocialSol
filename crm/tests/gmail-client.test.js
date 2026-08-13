'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _internal, SEND_SCOPES } = require('../lib/gmail-client');

test('Gmail reply MIME encoding preserves threading and blocks header injection', () => {
  const encoded = _internal.encodeRawMessage({
    from: 'sarah@example.com',
    to: 'planner@example.com\r\nBcc: attacker@example.com',
    subject: 'Re: Partnership\nBcc: attacker@example.com',
    body: 'Hello planner,\n\nHere are the details.',
    inReplyTo: '<reply-1@example.com>',
    references: '<original@example.com> <reply-1@example.com>',
    messageId: 'socialsol-proposal@example.com',
  });
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  assert.match(raw, /^From: sarah@example\.com\r\nTo: planner@example\.com Bcc: attacker@example\.com/m);
  assert.match(raw, /Subject: Re: Partnership Bcc: attacker@example\.com/);
  assert.match(raw, /Message-ID: <socialsol-proposal@example\.com>/);
  assert.match(raw, /In-Reply-To: <reply-1@example\.com>/);
  assert.match(raw, /References: <original@example\.com> <reply-1@example\.com>/);
  assert.doesNotMatch(raw, /\r\nBcc:/);
  assert.match(raw, /\r\n\r\nHello planner,\r\n\r\nHere are the details\.\r\n$/);
});

test('Gmail reply MIME encodes Unicode subjects as bounded RFC 2047 words', () => {
  const subject = 'Re: La Puesta del Sol — 10% referral commission, Riviera Nayarit';
  const encoded = _internal.encodeRawMessage({
    from: 'sarah@example.com',
    to: 'planner@example.com',
    subject,
    body: 'How about 5?',
  });
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  const folded = raw.match(/^Subject: ([^\r\n]*(?:\r\n [^\r\n]*)*)/m)?.[1] || '';
  const words = [...folded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  assert.ok(words.length >= 1);
  assert.equal(words.map(match => Buffer.from(match[1], 'base64').toString('utf8')).join(''), subject);
  assert.ok(words.every(match => match[0].length <= 75));
  assert.doesNotMatch(folded, /—/);
});

test('Gmail sending requests both readback and send delegation scopes', () => {
  assert.deepEqual(new Set(SEND_SCOPES), new Set([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ]));
});

test('Gmail mailbox listing can include Spam without including Trash', async () => {
  const calls = [];
  const gmail = {
    users: { messages: { list: async input => {
      calls.push(input);
      return { data: { messages: [{ id: 'm1' }] } };
    } } },
  };
  const ids = await _internal.listMessageIds(
    gmail,
    '-in:trash -in:chats -in:sent after:123',
    500,
    { includeSpamTrash: true },
  );
  assert.deepEqual(ids, ['m1']);
  assert.equal(calls[0].includeSpamTrash, true);
  assert.match(calls[0].q, /-in:trash/);
});
