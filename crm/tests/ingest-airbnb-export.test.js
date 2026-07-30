'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const lib = require('../scripts/lib/airbnb-export');

const FX = path.join(__dirname, 'fixtures/airbnb-export');
const directory = JSON.parse(fs.readFileSync(path.join(FX, 'guest_directory.json'), 'utf8'));
const contacts  = JSON.parse(fs.readFileSync(path.join(FX, 'guest_contacts.json'), 'utf8'));
const messagesRaw = JSON.parse(fs.readFileSync(path.join(FX, 'messages.json'), 'utf8'));
const threads = messagesRaw[0].messageThreads;
const mapText = fs.readFileSync(path.join(FX, 'GUEST_DATA_MAP.md'), 'utf8');

const contactsByAccountId = new Map(contacts.map(c => [c.accountId, c]));
const HOST_ID = 99999;

// ── #1: Known guest with email → voluntary_share_message ─────────────────
test('buildContactRow upgrades provenance for guest in guest_contacts.json', () => {
  const guestAlpha = directory.find(g => g.accountId === 11111);
  const row = lib.buildContactRow(guestAlpha, contactsByAccountId);
  assert.equal(row.contact_provenance, 'voluntary_share_message');
  assert.equal(row.email, 'guest.alpha@example.com');
  assert.equal(row.phone, '713-555-0127');
  assert.equal(row.airbnb_account_id, 11111);
});

// ── #2: Guest NOT in guest_contacts → airbnb_thread_only ─────────────────
test('buildContactRow defaults provenance for guest NOT in guest_contacts.json', () => {
  const guestBeta = directory.find(g => g.accountId === 22222);
  const row = lib.buildContactRow(guestBeta, contactsByAccountId);
  assert.equal(row.contact_provenance, 'airbnb_thread_only');
  assert.equal(row.email, null);
  assert.equal(row.phone, null);
});

// ── #3: relationship_type mapping ────────────────────────────────────────
test('mapRelationshipType maps reservationStatus correctly', () => {
  const stayed = directory.find(g => g.accountId === 11111);
  const inquired = directory.find(g => g.accountId === 22222);
  const cancelled = directory.find(g => g.accountId === 33333);
  const threadOnly = directory.find(g => g.accountId === 55555);
  assert.equal(lib.mapRelationshipType(stayed),     'past_guest_stayed');
  assert.equal(lib.mapRelationshipType(inquired),   'past_guest_inquired');
  assert.equal(lib.mapRelationshipType(cancelled),  'past_guest_cancelled');
  // 'unknown' (reservationCount=0, message-thread-only) → past_guest_inquired
  assert.equal(lib.mapRelationshipType(threadOnly), 'past_guest_inquired');
});

// ── #4: validateCountsAgainstMap happy path ──────────────────────────────
test('validateCountsAgainstMap passes when counts match', () => {
  const map = lib.parseGuestDataMap(mapText);
  map.threadCount = 4;
  map.messageCount = 9;
  map.contactsRowsRaw = 3; // 3 rows in fixture guest_contacts.json
  const result = lib.validateCountsAgainstMap({
    map,
    exportData: {
      directory,
      contacts,
      threadCount: 4,
      messageCount: 9
    },
    tolerance: 0.05
  });
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0);
});

// ── #5: validateCountsAgainstMap divergence throws ───────────────────────
test('validateCountsAgainstMap throws on divergence > tolerance', () => {
  const map = lib.parseGuestDataMap(mapText);
  map.threadCount = 4;
  map.messageCount = 9;
  map.contactsRowsRaw = 3;
  // Pretend the directory grew by ~50% (6 → 9)
  const fakeDirectory = [...directory, ...directory.slice(0, 3)];
  assert.throws(
    () => lib.validateCountsAgainstMap({
      map,
      exportData: { directory: fakeDirectory, contacts, threadCount: 4, messageCount: 9 },
      tolerance: 0.05
    }),
    /GUEST_DATA_MAP\.md disagrees/
  );
});

// ── #6: Host accountId resolver ──────────────────────────────────────────
test('resolveHostAccountId picks the most prolific sender as the host', () => {
  // In the fixture, accountId 99999 sends the most messages (5 of 9).
  const { hostAccountId, candidates } = lib.resolveHostAccountId(threads);
  assert.equal(hostAccountId, HOST_ID);
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].accountId, HOST_ID);
});

test('resolveHostAccountId honors override', () => {
  const { hostAccountId } = lib.resolveHostAccountId(threads, { override: 12345 });
  assert.equal(hostAccountId, 12345);
});

test('resolveHostAccountId ignores service messages', () => {
  const t = [{
    id: 1,
    messageThreadParticipants: [{accountId: 1}, {accountId: 2}],
    messagesAndContents: [
      { message: { accountId: null, accountType: 'service', id: 99, createdAt: 'x' },
        messageContent: { textContent: { text: 'system: booking confirmed' } } },
      { message: { accountId: 1, accountType: 'user', id: 100, createdAt: 'x' },
        messageContent: { textContent: { text: 'hi' } } }
    ]
  }];
  const { hostAccountId } = lib.resolveHostAccountId(t);
  assert.equal(hostAccountId, 1);
});

// ── #7: language heuristic ───────────────────────────────────────────────
test('detectLanguage classifies Spanish vs English', () => {
  assert.equal(lib.detectLanguage('Hola, gracias por tu mensaje. Tengo unas fechas en mente.'), 'es');
  assert.equal(lib.detectLanguage('Thanks, looking forward to hosting you all soon!'), 'en');
  // Single Spanish token below the threshold (need ≥2)
  assert.equal(lib.detectLanguage('Hola — please send your check-in time'), 'en');
});

// ── #8: Idempotency simulation ───────────────────────────────────────────
test('buildContactRow is deterministic across repeated calls', () => {
  const guestAlpha = directory.find(g => g.accountId === 11111);
  const a = lib.buildContactRow(guestAlpha, contactsByAccountId);
  const b = lib.buildContactRow(guestAlpha, contactsByAccountId);
  assert.deepEqual(a, b);
});

// ── #9: contact_id resolution on voice corpus rows ───────────────────────
test('buildVoiceCorpusRow attaches contact_id and source_account_id', () => {
  const contactIdByAirbnbAccountId = new Map([[11111, 101], [22222, 102]]);
  const { contactIdByThreadId, unmatched } = lib.buildContactIdByThreadId(
    threads, new Set([HOST_ID]), contactIdByAirbnbAccountId
  );

  assert.equal(contactIdByThreadId.get(91001), 101);
  assert.equal(contactIdByThreadId.get(92002), 102);
  assert.equal(contactIdByThreadId.has(93003), false);
  assert.equal(contactIdByThreadId.has(94004), false);
  assert.equal(unmatched.length, 2);

  const guestAlphaThread = threads.find(t => t.id === 91001);
  const hostMsg = guestAlphaThread.messagesAndContents.find(e => e.message.id === 1002);
  const row = lib.buildVoiceCorpusRow({
    thread: guestAlphaThread,
    envelope: hostMsg,
    hostAccountIds: new Set([HOST_ID]),
    contactIdByThreadId
  });
  assert.equal(row.contact_id, 101);
  assert.equal(row.source_account_id, HOST_ID);
  assert.equal(row.direction, 'outbound');
  assert.equal(row.body, 'Thanks, looking forward to hosting you and your group!');
  assert.equal(row.language, 'en');

  const unmatchedThread = threads.find(t => t.id === 94004);
  const unmatchedHostMsg = unmatchedThread.messagesAndContents.find(e => e.message.id === 4002);
  const row2 = lib.buildVoiceCorpusRow({
    thread: unmatchedThread,
    envelope: unmatchedHostMsg,
    hostAccountIds: new Set([HOST_ID]),
    contactIdByThreadId
  });
  assert.equal(row2.contact_id, null);
  assert.equal(row2.source_account_id, HOST_ID);

  // Inbound message → null
  const inboundEnvelope = guestAlphaThread.messagesAndContents.find(e => e.message.id === 1001);
  const inboundRow = lib.buildVoiceCorpusRow({
    thread: guestAlphaThread,
    envelope: inboundEnvelope,
    hostAccountIds: new Set([HOST_ID]),
    contactIdByThreadId
  });
  assert.equal(inboundRow, null);
});

// ── #10: dedup picks the row matching the directory firstName ────────────
test('dedupGuestContacts picks the row whose name matches the directory firstName', () => {
  const { deduped, collisions } = lib.dedupGuestContacts(contacts, directory);
  // 3 raw rows → 2 distinct accountIds
  assert.equal(deduped.length, 2);
  assert.equal(collisions.length, 1);

  const collision = collisions[0];
  assert.equal(collision.accountId, 66666);
  assert.equal(collision.directoryFirstName, 'Alex');
  // Alex's row was kept (matches firstName 'Alex'), Jordan's was dropped
  assert.equal(collision.kept.name, 'Alex Example');
  assert.equal(collision.kept.phone, '505-555-0134');
  assert.match(collision.reason, /directory-firstName-match/);
  assert.equal(collision.dropped.length, 1);
  assert.equal(collision.dropped[0].name, 'Jordan Example');

  // After dedup, accountId 66666 maps to Alex's row
  const alexRow = deduped.find(c => c.accountId === 66666);
  assert.equal(alexRow.phone, '505-555-0134');
  assert.equal(alexRow.name, 'Alex Example');
});

// ── #11: dedup falls back to first row when no firstName match ───────────
test('dedupGuestContacts falls back to first row when no name matches firstName', () => {
  const fakeDirectory = [{ accountId: 66666, firstName: 'Beatrice' }];
  const fakeContacts = [
    { accountId: 66666, name: 'Alex Example',   phone: '505-555-0134' },
    { accountId: 66666, name: 'Jordan Example', phone: '719-555-0156' }
  ];
  const { deduped, collisions } = lib.dedupGuestContacts(fakeContacts, fakeDirectory);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].name, 'Alex Example');
  assert.match(collisions[0].reason, /no-name-match-fallback/);
});

// ── #12: multi-host buildContactIdByThreadId & buildVoiceCorpusRow ───────
test('buildVoiceCorpusRow accepts multiple hostAccountIds and tags source_account_id', () => {
  const hosts = new Set([HOST_ID, 88888]);
  const contactIdByAirbnbAccountId = new Map([[11111, 101]]);
  const { contactIdByThreadId } = lib.buildContactIdByThreadId(
    threads, hosts, contactIdByAirbnbAccountId
  );
  // Synthesize a message from the second host in Guest Alpha's thread
  const alphaThread = threads.find(t => t.id === 91001);
  const altHostEnvelope = {
    message: { id: 9001, accountId: 88888, createdAt: '2025-06-13T12:00:00.000Z', accountType: 'user', contentType: 'TextContent' },
    messageContent: { textContent: { body: 'Quick follow-up from a co-host account.' } }
  };
  const row = lib.buildVoiceCorpusRow({
    thread: alphaThread,
    envelope: altHostEnvelope,
    hostAccountIds: hosts,
    contactIdByThreadId
  });
  assert.ok(row !== null);
  assert.equal(row.source_account_id, 88888);
  assert.equal(row.contact_id, 101);
});

// ── parseGuestDataMap ────────────────────────────────────────────────────
test('parseGuestDataMap extracts the executive-summary counts', () => {
  const map = lib.parseGuestDataMap(mapText);
  assert.equal(map.contactsTotal, 6);
  assert.equal(map.contactsWithEmail, 1);
  assert.equal(map.contactsWithPhone, 3);
  assert.equal(map.contactsWithBoth, 1);
  assert.equal(map.stays, 3);
  assert.equal(map.cancelled, 1);
  assert.equal(map.inquiryOnly, 1);
  assert.equal(map.threadOnly, 1);
  assert.equal(map.reviewsLeft, 1);
});
