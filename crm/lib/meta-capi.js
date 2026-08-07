'use strict';

/** Send an idempotent, verified inbound WhatsApp Lead to Meta CAPI. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const META_PATH = path.join(SECRETS_DIR, 'meta.json');
const REGISTRY_PATH = path.join(REPO_ROOT, 'campaigns', 'active-campaigns.json');

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function config() {
  const secrets = readJson(META_PATH);
  const registryRaw = readJson(REGISTRY_PATH, []);
  const registry = Array.isArray(registryRaw) ? registryRaw : (registryRaw.campaigns || []);
  const pixelId = process.env.META_PIXEL_ID || secrets.pixel_id
    || registry.find((row) => row.pixel_id)?.pixel_id;
  let base = String(secrets.graph_api_base || 'https://graph.facebook.com').replace(/\/$/, '');
  if (!/\/v\d+\.\d+$/.test(base)) base += `/${secrets.graph_api_version || 'v21.0'}`;
  return { accessToken: secrets.access_token, pixelId, base };
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? digits : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildPayload({ eventId, eventTime, phone, campaign, utmCampaign, pageSlug, testEventCode }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('verified lead phone is required for CAPI');
  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(new Date(eventTime).getTime() / 1000),
      event_id: eventId,
      action_source: 'business_messaging',
      user_data: { ph: [sha256(normalized)] },
      custom_data: {
        lead_source: 'verified_whatsapp_inbound',
        campaign: campaign || null,
        utm_campaign: utmCampaign || null,
        page_slug: pageSlug || null,
      },
    }],
  };
  if (testEventCode) payload.test_event_code = testEventCode;
  return payload;
}

async function sendVerifiedLead({ db, sql, eventId, eventTime, phone, campaign, utmCampaign, pageSlug, fetchImpl = fetch }) {
  if (!eventId) throw new Error('stable inbound message event ID is required for CAPI');
  const provider = 'meta-capi';
  const existing = await db.query(sql`
    SELECT status FROM conversion_deliveries
    WHERE provider=${provider} AND event_id=${eventId} LIMIT 1
  `);
  if (existing[0]?.status === 'sent') return { ok: true, deduplicated: true };

  const cfg = config();
  if (!cfg.accessToken || !cfg.pixelId) throw new Error('Meta CAPI token or pixel ID is not configured');
  const payload = buildPayload({
    eventId, eventTime, phone, campaign, utmCampaign, pageSlug,
    testEventCode: process.env.META_TEST_EVENT_CODE,
  });
  await db.query(sql`
    INSERT INTO conversion_deliveries (provider, event_id, event_name, status, attempts, request_meta)
    VALUES (${provider}, ${eventId}, 'Lead', 'pending', 1, ${JSON.stringify(payload.data[0].custom_data)})
    ON CONFLICT(provider,event_id) DO UPDATE SET
      status='pending', attempts=conversion_deliveries.attempts+1,
      request_meta=excluded.request_meta, updated_at=datetime('now')
  `);

  try {
    const response = await fetchImpl(`${cfg.base}/${cfg.pixelId}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error || Number(result.events_received || 0) < 1) {
      throw new Error(result.error?.message || `Meta CAPI rejected event (${response.status})`);
    }
    await db.query(sql`
      UPDATE conversion_deliveries SET status='sent', response_meta=${JSON.stringify(result)},
        error=NULL, delivered_at=datetime('now'), updated_at=datetime('now')
      WHERE provider=${provider} AND event_id=${eventId}
    `);
    return { ok: true, response: result };
  } catch (error) {
    await db.query(sql`
      UPDATE conversion_deliveries SET status='failed', error=${String(error.message).slice(0, 500)},
        updated_at=datetime('now') WHERE provider=${provider} AND event_id=${eventId}
    `);
    throw error;
  }
}

module.exports = { buildPayload, normalizePhone, sendVerifiedLead };
