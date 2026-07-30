'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../../regina/lib/slack-format');
process.env.RESORT_SENDER_EMAIL = 'sender@example.com';

const C_PATRICIA = {
  id: 100,
  name: 'Patricia Test',
  email: 'patricia@example.com',
  phone: '+15125551234',
  preferred_channel: 'email',
  contact_provenance: 'voluntary_share_message',
  airbnb_account_id: 12345,
  last_stay_date: '2024-08-15',
};

const D_PATRICIA = {
  decision_timeline: 'actively_deciding',
  why_no_book: 'price',
  notes_for_sarah: 'Patricia inquired about August family stay; nearly booked but went elsewhere on price.',
};

test('buildDraftMessage: fits in single message returns no overflow', () => {
  const { topLevel, bodyOverflow } = fmt.buildDraftMessage({
    campaignKind: 'ad_hoc',
    contact: C_PATRICIA,
    dossier: D_PATRICIA,
    draftText: 'Hi Patricia, hope you are well!',
  });
  assert.equal(bodyOverflow, null);
  assert.match(topLevel, /Patricia Test \(id 100\)/);
  assert.match(topLevel, /Channel: email/);
  assert.match(topLevel, /sender@example\.com → patricia@example\.com/);
  assert.match(topLevel, /Decision: actively_deciding/);
  assert.match(topLevel, /Why no book: price/);
  assert.match(topLevel, /Hi Patricia, hope you are well!/);
  assert.match(topLevel, /Reply in thread:.*!sent.*!skip.*!defer N/);
});

test('buildDraftMessage: overflow when body too long', () => {
  const big = 'x'.repeat(50000);
  const { topLevel, bodyOverflow } = fmt.buildDraftMessage({
    campaignKind: 'ad_hoc',
    contact: C_PATRICIA,
    dossier: D_PATRICIA,
    draftText: big,
    maxChars: 1000,
  });
  assert.ok(topLevel.length <= 1500);
  assert.ok(bodyOverflow !== null);
  assert.ok(bodyOverflow.startsWith(fmt.DRAFT_BODY_MARKER));
  assert.ok(bodyOverflow.includes(big));
  assert.match(topLevel, /draft body in threaded reply/);
});

test('buildDraftMessage: airbnb_thread_only contact uses airbnb-thread channel display', () => {
  const c = { ...C_PATRICIA, contact_provenance: 'airbnb_thread_only', preferred_channel: 'airbnb_thread' };
  const { topLevel } = fmt.buildDraftMessage({
    campaignKind: 'reactivation_anniversary',
    contact: c,
    dossier: D_PATRICIA,
    draftText: 'short draft',
  });
  assert.match(topLevel, /Airbnb thread \(account 12345\)/);
});

test('buildBatchSummary: includes count, slug, breakdown', () => {
  const s = fmt.buildBatchSummary({
    slug: 'smoke',
    count: 3,
    kindBreakdown: { ad_hoc: 2, reactivation_anniversary: 1 },
    runAt: '2026-05-07T15:00:00.000Z',
  });
  assert.match(s, /3 drafts posted/);
  assert.match(s, /!batch smoke/);
  assert.match(s, /ad_hoc:2/);
  assert.match(s, /reactivation_anniversary:1/);
});

test('buildBatchSummary: singular for count=1', () => {
  const s = fmt.buildBatchSummary({
    slug: 'smoke',
    count: 1,
    kindBreakdown: { ad_hoc: 1 },
    runAt: '2026-05-07T15:00:00.000Z',
  });
  assert.match(s, /1 draft posted/);
});

test('buildEmptyAnniversaryPost', () => {
  assert.match(fmt.buildEmptyAnniversaryPost('2026-05-07'), /Anniversary check.*2026-05-07.*no eligible contacts/);
});

test('buildVoiceServiceDownPost', () => {
  const s = fmt.buildVoiceServiceDownPost('chroma — connect refused');
  assert.match(s, /❌ Voice Service unreachable/);
  assert.match(s, /No drafts produced, no rows written/);
});

test('buildSentAck includes edit distance', () => {
  assert.equal(fmt.buildSentAck(0), '✅ Logged as sent. edit_distance=0.');
  assert.equal(fmt.buildSentAck(47), '✅ Logged as sent. edit_distance=47.');
});

test('buildDeferredAck: trims iso to YYYY-MM-DD', () => {
  assert.equal(fmt.buildDeferredAck('2026-05-21T00:00:00.000Z'), '⏸ Deferred until 2026-05-21.');
});

test('buildAutoReconcilePost', () => {
  const s = fmt.buildAutoReconcilePost({
    contact: { name: 'Patricia' },
    sentAtIso: '2026-05-09T14:00:00.000Z',
    editDistance: 47,
  });
  assert.match(s, /Auto-reconciled: Patricia's draft was sent on 2026-05-09/);
  assert.match(s, /Edit distance: 47/);
});

test('buildPossibleMatchPost: includes both texts and similarity %', () => {
  const s = fmt.buildPossibleMatchPost({
    contact: { name: 'Patricia' },
    draftText: 'original draft',
    gmailBody: 'edited heavily',
    similarity: 0.5,
  });
  assert.match(s, /Possible match.*Patricia.*similarity 50%/);
  assert.match(s, /\*Draft:\*/);
  assert.match(s, /\*Gmail Sent:\*/);
  assert.match(s, /original draft/);
  assert.match(s, /edited heavily/);
});

test('buildAutoSuppressPost', () => {
  const s = fmt.buildAutoSuppressPost({
    contact: { name: 'Patricia' },
    draftDate: '2026-04-22',
  });
  assert.match(s, /Auto-suppressed.*Patricia.*2026-04-22.*3 times/);
});
