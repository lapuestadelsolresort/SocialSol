'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _internal, searchEmailActivity, SEND_SCOPES } = require('../lib/gmail-client');

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

test('Gmail activity reads exact inbound and outbound windows without mutating mail', async () => {
  const lists = [];
  const messages = new Map([
    ['in-1', { id: 'in-1', threadId: 'thread-in', internalDate: String(Date.parse('2026-08-13T14:00:00Z')),
      labelIds: ['INBOX', 'UNREAD'], payload: { headers: [
        { name: 'From', value: 'Guest <guest@example.com>' },
        { name: 'To', value: 'Sarah <sarah@example.com>' },
        { name: 'Subject', value: 'Wedding dates' },
      ], mimeType: 'text/plain', body: { data: Buffer.from('Are your May dates open?').toString('base64url') } } }],
    ['out-1', { id: 'out-1', threadId: 'thread-out', internalDate: String(Date.parse('2026-08-13T15:00:00Z')),
      labelIds: ['SENT'], payload: { headers: [
        { name: 'From', value: 'Sarah <sarah@example.com>' },
        { name: 'To', value: 'Guest <guest@example.com>' },
        { name: 'Subject', value: 'Re: Wedding dates' },
      ], mimeType: 'text/plain', body: { data: Buffer.from('Yes, we have availability.').toString('base64url') } } }],
    ['edge', { id: 'edge', threadId: 'thread-edge', internalDate: String(Date.parse('2026-08-14T07:00:00Z')),
      labelIds: ['INBOX'], payload: { headers: [], mimeType: 'text/plain', body: { data: '' } } }],
  ]);
  const gmail = { users: { messages: {
    async list(input) {
      lists.push(input);
      return { data: { messages: input.q.startsWith('in:sent') ? [{ id: 'out-1' }] : [{ id: 'in-1' }, { id: 'edge' }] } };
    },
    async get({ id }) { return { data: messages.get(id) }; },
  } } };

  const result = await searchEmailActivity({
    start: '2026-08-13T07:00:00.000Z', end: '2026-08-14T07:00:00.000Z',
    direction: 'all', limit: 25,
  }, { gmail });
  assert.equal(result.total, 2);
  assert.equal(result.inbound, 1);
  assert.equal(result.outbound, 1);
  assert.equal(result.unread, 1);
  assert.deepEqual(result.messages.map(message => message.id), ['out-1', 'in-1']);
  assert.equal(lists.length, 2);
  assert.equal(lists.find(call => call.q.startsWith('-in:trash')).includeSpamTrash, true);
  assert.match(lists.find(call => call.q.startsWith('-in:trash')).q, /-in:drafts/);
  assert.match(lists.find(call => call.q.startsWith('in:sent')).q, /-in:drafts/);
});
