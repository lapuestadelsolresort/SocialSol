'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const {
  buildPayload,
  configuredMetaUtms,
  isMetaAttributed,
  normalizePhone,
  sendVerifiedLead,
} = require('../lib/meta-capi');

const REGISTRY = [{
  utm_campaign: 'us-corporate',
  utm_aliases: ['corporate_retreats_video'],
  destinations: [{ utm_campaign: 'planner-prospecting' }],
}];

async function withDeliveryDb(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-capi-test-'));
  const db = createDB(path.join(dir, 'crm.db'));
  try {
    await db.query(sql`CREATE TABLE conversion_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      request_meta TEXT,
      response_meta TEXT,
      error TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider,event_id)
    )`);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('verified WhatsApp Meta CAPI payload', () => {
  it('uses chat for a website-to-WhatsApp conversion', () => {
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
    assert.equal(event.action_source, 'chat');
    assert.equal(event.event_id, 'twilio-SM-test');
    assert.equal(event.custom_data.lead_source, 'verified_whatsapp_inbound');
    assert.equal(event.custom_data.acquisition_channel, 'meta_paid');
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

  it('recognizes only configured paid Meta UTMs', () => {
    assert.equal(isMetaAttributed({
      utmSource: 'meta', utmMedium: 'paid', utmCampaign: 'us-corporate',
    }, REGISTRY), true);
    assert.equal(isMetaAttributed({
      utmSource: 'instagram', utmMedium: 'paid', utmCampaign: 'planner-prospecting',
    }, REGISTRY), true);
    assert.equal(isMetaAttributed({
      utmSource: 'paulina', utmMedium: 'email', utmCampaign: 'planner_partner_program_v1',
    }, REGISTRY), false);
    assert.equal(isMetaAttributed({
      utmSource: 'meta', utmMedium: 'paid', utmCampaign: 'unknown-campaign',
    }, REGISTRY), false);
  });

  it('indexes primary, alias, and destination campaign tags', () => {
    assert.deepEqual([...configuredMetaUtms(REGISTRY)].sort(), [
      'corporate_retreats_video', 'planner-prospecting', 'us-corporate',
    ]);
  });

  it('skips non-Meta attribution before any delivery write', async () => {
    await withDeliveryDb(async (db) => {
      const result = await sendVerifiedLead({
        db,
        sql,
        eventId: 'twilio-email',
        eventTime: '2026-08-09T12:00:00Z',
        phone: '+14155550100',
        utmSource: 'paulina',
        utmMedium: 'email',
        utmCampaign: 'planner_partner_program_v1',
        registryRaw: REGISTRY,
        fetchImpl: async () => { throw new Error('must not call Meta'); },
      });
      assert.equal(result.skipped, true);
      const rows = await db.query(sql`SELECT * FROM conversion_deliveries`);
      assert.equal(rows.length, 0);
    });
  });

  it('persists a successful Meta delivery with safe request metadata', async () => {
    await withDeliveryDb(async (db) => {
      const result = await sendVerifiedLead({
        db,
        sql,
        eventId: 'twilio-paid',
        eventTime: '2026-08-09T12:00:00Z',
        phone: '+14155550100',
        campaign: 'us-corporate',
        utmSource: 'meta',
        utmMedium: 'paid',
        utmCampaign: 'us-corporate',
        pageSlug: 'retreats',
        registryRaw: REGISTRY,
        configOverride: { accessToken: 'test-token', pixelId: 'test-pixel', base: 'https://example.test' },
        fetchImpl: async (_url, request) => {
          const event = JSON.parse(request.body).data[0];
          assert.equal(event.action_source, 'chat');
          return {
            ok: true,
            status: 200,
            json: async () => ({ events_received: 1, fbtrace_id: 'test-trace' }),
          };
        },
      });
      assert.equal(result.ok, true);
      const [row] = await db.query(sql`SELECT * FROM conversion_deliveries`);
      assert.equal(row.status, 'sent');
      assert.equal(row.attempts, 1);
      assert.equal(JSON.parse(row.request_meta).action_source, 'chat');
      assert.equal(row.error, null);
    });
  });
});
