#!/usr/bin/env node
'use strict';

/** Retry recent, failed Meta-attributed WhatsApp Lead deliveries. */

const path = require('node:path');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { isMetaAttributed, sendVerifiedLead } = require('../lib/meta-capi');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const eventIndex = args.indexOf('--event-id');
const EVENT_ID = eventIndex >= 0 ? args[eventIndex + 1] : null;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.META_CAPI_MAX_ATTEMPTS || 8));

function utcEventTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
}

async function candidates(db) {
  const base = sql`
    SELECT cd.event_id, cd.status, cd.attempts, cd.updated_at,
           ae.created_at AS event_time, ae.campaign,
           ae.utm_source, ae.utm_medium, ae.utm_campaign,
           l.phone, ps.page_slug
    FROM conversion_deliveries cd
    JOIN attribution_events ae
      ON ae.event_type='whatsapp_lead'
     AND json_extract(ae.meta, '$.message_id')=substr(cd.event_id, 8)
    JOIN leads l ON l.id=ae.lead_id
    LEFT JOIN page_sessions ps ON ps.id=ae.session_id
    WHERE cd.provider='meta-capi'
      AND cd.status IN ('failed','pending')
      AND cd.attempts < ${MAX_ATTEMPTS}
      AND ae.created_at >= datetime('now','-7 days')
  `;
  if (EVENT_ID) {
    return db.query(sql`${base} AND cd.event_id=${EVENT_ID} ORDER BY cd.created_at ASC`);
  }
  return db.query(sql`${base} AND cd.updated_at <= datetime('now','-10 minutes') ORDER BY cd.created_at ASC`);
}

async function run() {
  if (eventIndex >= 0 && !EVENT_ID) throw new Error('--event-id requires a value');
  const db = createDB(DB_PATH);
  let retried = 0;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const rows = await candidates(db);
    for (const row of rows) {
      const attribution = {
        utmSource: row.utm_source,
        utmMedium: row.utm_medium,
        utmCampaign: row.utm_campaign,
      };
      if (!isMetaAttributed(attribution)) {
        skipped++;
        console.warn(`[meta-capi-retry] skipped ${row.event_id}: not a configured Meta attribution`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`[meta-capi-retry] would retry ${row.event_id} (${row.utm_source}/${row.utm_medium}/${row.utm_campaign})`);
        continue;
      }
      retried++;
      try {
        const result = await sendVerifiedLead({
          db,
          sql,
          eventId: row.event_id,
          eventTime: utcEventTime(row.event_time),
          phone: row.phone,
          campaign: row.campaign,
          ...attribution,
          pageSlug: row.page_slug,
        });
        if (result.ok) delivered++;
      } catch (error) {
        failed++;
        console.error(`[meta-capi-retry] ${row.event_id} failed: ${error.message}`);
      }
    }
    console.log(`[meta-capi-retry] candidates=${rows.length} retried=${retried} delivered=${delivered} failed=${failed} skipped=${skipped} dry_run=${DRY_RUN}`);
  } finally {
    await db.dispose();
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[meta-capi-retry] fatal:', error.message);
    process.exit(1);
  });
}

module.exports = { candidates, run, utcEventTime };
