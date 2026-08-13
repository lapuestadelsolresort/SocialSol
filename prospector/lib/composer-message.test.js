'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDraftMessage } = require('../composer');

function fixture(autoApprove) {
  return buildDraftMessage({
    draftId: 10343,
    contact: { name: 'Jason', email: 'jason@example.com', company: 'Jedburgh' },
    campaign: { slug: 'planner_partner_program_v1' },
    persona: {
      path: '/tmp/wedding-planner.md',
      frontMatter: { status: 'v0', last_reviewed_by_sarah: '2026-07-31' },
    },
    hookAngle: 'direct-intro',
    subject: 'La Puesta del Sol — 10% referral commission',
    body: 'Hello Jason',
    autoApprove,
  });
}

test('auto-approved draft posts advertise only the conversation reply command', () => {
  const message = fixture(true);
  assert.match(message, /queued for automatic approval/);
  assert.match(message, /!email reply <message>/);
  assert.doesNotMatch(message, /!approve|!edit|!reject/);
});

test('manual-review draft posts retain draft review commands', () => {
  const message = fixture(false);
  assert.match(message, /ready for review/);
  assert.match(message, /!approve 10343/);
  assert.match(message, /!edit 10343/);
  assert.match(message, /!reject 10343 <reason>/);
});
