'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildPayload, normalizePhone } = require('../lib/meta-capi');

describe('verified WhatsApp Meta CAPI payload', () => {
  it('uses a real Lead only for a business messaging source', () => {
    const payload = buildPayload({
      eventId: 'twilio-SM-test',
      eventTime: '2026-08-07T12:00:00Z',
      phone: '+1 (415) 555-0100',
      campaign: null,
      utmCampaign: null,
      pageSlug: null,
    });
    const event = payload.data[0];
    assert.equal(event.event_name, 'Lead');
    assert.equal(event.action_source, 'business_messaging');
    assert.equal(event.event_id, 'twilio-SM-test');
    assert.equal(event.custom_data.lead_source, 'verified_whatsapp_inbound');
  });

  it('hashes normalized phone and never includes raw PII', () => {
    const payload = buildPayload({
      eventId: 'twilio-SM-test-2',
      eventTime: '2026-08-07T12:00:00Z',
      phone: '+1 (415) 555-0100',
    });
    const serialized = JSON.stringify(payload);
    assert.equal(normalizePhone('+1 (415) 555-0100'), '14155550100');
    assert.ok(/^[a-f0-9]{64}$/.test(payload.data[0].user_data.ph[0]));
    assert.ok(!serialized.includes('14155550100'));
    assert.ok(!serialized.includes('+1 (415)'));
  });
});
