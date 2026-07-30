'use strict';
//
// routes/track.js — POST /api/track : beacon ingest for landing-page telemetry.
//
// Body: an array of events, each { sid, kind, target, meta, ts }. The tracker
// batches events and flushes via navigator.sendBeacon so they survive unload.
// Ported from GoldRoute, adapted for the WhatsApp-click funnel:
//   - cta_view on a wa-cta  → page_sessions.reached_cta = 1
//   - wa_click              → page_sessions.cta_clicked = 1, converted = 1
// (the form-funnel flags reached_form/started_form/completed_form are dropped —
//  these pages have no form; the WhatsApp click IS the conversion.)
//
// All side effects are best-effort — a failed beacon must never 5xx to the
// visitor. PRIVACY: event metadata only (lengths, ids, scroll %, timings) —
// never the characters a visitor typed.
//

const express = require('express');
const { sql } = require('@databases/sqlite');

const SID_RE = /^[0-9a-z-]{8,64}$/i;
const WA_REF_RE = /^[A-Z0-9]{12,24}$/;
const ALLOWED_KINDS = new Set([
  'pageview', 'scroll', 'click', 'deadclick', 'rageclick', 'cta_view',
  'heartbeat', 'visible', 'hidden', 'abandon', 'wa_click', 'cta_click',
]);

function buildRouter(getDb) {
  const router = express.Router();

  // sendBeacon posts a Blob; ensure we can parse JSON even if the app-level
  // parser didn't (defensive — server.js already mounts express.json).
  router.use(express.json({ limit: '64kb' }));

  router.post('/', async (req, res) => {
    const db = getDb();
    const inputEvents = Array.isArray(req.body) ? req.body : (req.body && req.body.events) || [];
    const events = inputEvents.slice(0, 100);
    if (!events.length) return res.json({ ok: true, n: 0 });

    const ip = String(req.ip || req.socket.remoteAddress || '').slice(0, 64);
    const ua = String(req.headers['user-agent'] || '').slice(0, 255);

    // Group by session so we can bootstrap the row once per beacon.
    const bySid = new Map();
    for (const e of events) {
      const sid = e && String(e.sid || '');
      const kind = e && String(e.kind || '');
      if (!SID_RE.test(sid) || !ALLOWED_KINDS.has(kind)) continue;
      if (!bySid.has(sid)) bySid.set(sid, []);
      bySid.get(sid).push({ ...e, sid, kind });
    }

    try {
      for (const [sid, evs] of bySid) {
        const pv = evs.find((e) => e.kind === 'pageview') || evs[0];
        const m = (pv && pv.meta) || {};
        const suppliedRef = String(m.wa_ref || '').toUpperCase();
        const expectedRef = sid.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 16);
        const whatsappRef = WA_REF_RE.test(suppliedRef) && suppliedRef === expectedRef
          ? suppliedRef
          : null;

        // Upsert the session. COALESCE on conflict so whichever of /api/track
        // and /api/lp/config arrives second only fills gaps (config sets
        // page_slug/variant_id; track sets device/utm/referrer).
        await db.query(sql`
          INSERT INTO page_sessions (
            id, page_slug, language, ip_address, user_agent, referrer,
            utm_source, utm_medium, utm_campaign, utm_content,
            device, viewport_w, viewport_h, whatsapp_ref
          ) VALUES (
            ${sid}, ${m.page || null}, ${m.lang || null}, ${ip}, ${ua}, ${m.ref || null},
            ${m.utm_source || null}, ${m.utm_medium || null}, ${m.utm_campaign || null}, ${m.utm_content || null},
            ${m.dev || null}, ${m.vw || null}, ${m.vh || null}, ${whatsappRef}
          )
          ON CONFLICT(id) DO UPDATE SET
            page_slug   = COALESCE(page_sessions.page_slug, excluded.page_slug),
            language    = COALESCE(page_sessions.language, excluded.language),
            ip_address  = COALESCE(page_sessions.ip_address, excluded.ip_address),
            user_agent  = COALESCE(page_sessions.user_agent, excluded.user_agent),
            referrer    = COALESCE(page_sessions.referrer, excluded.referrer),
            utm_source  = COALESCE(page_sessions.utm_source, excluded.utm_source),
            utm_medium  = COALESCE(page_sessions.utm_medium, excluded.utm_medium),
            utm_campaign= COALESCE(page_sessions.utm_campaign, excluded.utm_campaign),
            utm_content = COALESCE(page_sessions.utm_content, excluded.utm_content),
            device      = COALESCE(page_sessions.device, excluded.device),
            viewport_w  = COALESCE(page_sessions.viewport_w, excluded.viewport_w),
            viewport_h  = COALESCE(page_sessions.viewport_h, excluded.viewport_h),
            whatsapp_ref= COALESCE(page_sessions.whatsapp_ref, excluded.whatsapp_ref)
        `);

        for (const e of evs) {
          let meta = e.meta != null ? JSON.stringify(e.meta) : null;
          if (meta && meta.length > 4000) meta = meta.slice(0, 4000);
          const parsedTs = Number(e.ts);
          const eventMs = Number.isFinite(parsedTs) && Math.abs(Date.now() - parsedTs) < 7 * 86400000
            ? parsedTs
            : Date.now();
          const ts = new Date(eventMs).toISOString();
          await db.query(sql`
            INSERT INTO page_events (session_id, ts, kind, target, value_meta)
            VALUES (${sid}, ${ts}, ${String(e.kind).slice(0, 40)}, ${e.target ? String(e.target).slice(0, 120) : null}, ${meta})
          `);

          // Maintain summary fields by event kind.
          if (e.kind === 'wa_click') {
            await db.query(sql`
              UPDATE page_sessions
              SET cta_clicked = 1, converted = 1, last_seen = datetime('now')
              WHERE id = ${sid}
            `);
          } else if (e.kind === 'cta_view' && typeof e.target === 'string' && e.target.indexOf('cta:') === 0) {
            await db.query(sql`UPDATE page_sessions SET reached_cta = 1, last_seen = datetime('now') WHERE id = ${sid}`);
          } else if (e.kind === 'scroll' && e.meta && typeof e.meta.pct === 'number') {
            await db.query(sql`
              UPDATE page_sessions
              SET max_scroll_pct = MAX(max_scroll_pct, ${e.meta.pct}), last_seen = datetime('now')
              WHERE id = ${sid}
            `);
          } else if (e.kind === 'heartbeat' && e.meta && typeof e.meta.active_ms === 'number') {
            await db.query(sql`
              UPDATE page_sessions
              SET dwell_ms = MAX(dwell_ms, ${Math.round(e.meta.active_ms)}),
                  max_scroll_pct = MAX(max_scroll_pct, ${e.meta.max_scroll || 0}),
                  last_seen = datetime('now')
              WHERE id = ${sid}
            `);
          } else if (e.kind === 'abandon') {
            await db.query(sql`
              UPDATE page_sessions
              SET abandoned_field = ${e.target || null},
                  dwell_ms = MAX(dwell_ms, ${e.meta && e.meta.active_ms ? Math.round(e.meta.active_ms) : 0}),
                  max_scroll_pct = MAX(max_scroll_pct, ${e.meta && e.meta.max_scroll ? e.meta.max_scroll : 0}),
                  last_seen = datetime('now')
              WHERE id = ${sid}
            `);
          } else {
            await db.query(sql`UPDATE page_sessions SET last_seen = datetime('now') WHERE id = ${sid}`);
          }
        }
      }
      res.json({ ok: true, n: events.length });
    } catch (e) {
      console.warn('[track] insert failed (non-fatal):', e.message);
      res.json({ ok: false });
    }
  });

  return router;
}

module.exports = { buildRouter };
