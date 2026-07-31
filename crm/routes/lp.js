'use strict';
//
// routes/lp.js — landing-page variant config + funnel stats.
//
//   GET /api/lp/config?sid=<UUID>&lang=en&page_slug=weddings&utm_source=..&utm_content=..
//     ─► { session_id, variant_id, variant_slug, page_slug, config }
//
//   GET /api/lp/stats[?page_slug=weddings]
//     ─► { variants: [ { page_slug, variant_slug, sessions, reached_cta,
//                        wa_clicks, conversions, conv_rate_pct, ... } ] }
//
// Resolves the visitor's variant (sticky via lp_assignments), stamps
// page_slug/variant_id onto the page_sessions row, and returns the JSON config
// the page uses to hydrate copy / CTAs. Served cross-origin to the Astro pages.
//

const express = require('express');
const { sql } = require('@databases/sqlite');
const { getOrAssignVariant } = require('../lib/variants');

const PAGE_SLUGS = ['weddings', 'fitness', 'retreats', 'summer-sale', 'planners'];

function buildRouter(getDb) {
  const router = express.Router();

  router.get('/config', async (req, res) => {
    try {
      const db = getDb();
      const sid = String(req.query.sid || '').trim();
      if (!/^[0-9a-z-]{8,64}$/i.test(sid)) return res.status(400).json({ error: 'sid required' });

      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 64);
      const ua = String(req.headers['user-agent'] || '').slice(0, 255);
      const lang = req.query.lang === 'es' ? 'es' : 'en';
      const source = req.query.utm_source ? String(req.query.utm_source).slice(0, 40) : null;
      const audience = req.query.utm_content ? String(req.query.utm_content).slice(0, 40) : null;
      const utmMedium = req.query.utm_medium ? String(req.query.utm_medium).slice(0, 40) : null;
      const utmCampaign = req.query.utm_campaign ? String(req.query.utm_campaign).slice(0, 80) : null;
      const page_slug = PAGE_SLUGS.includes(String(req.query.page_slug || '').toLowerCase())
        ? String(req.query.page_slug).toLowerCase()
        : null;
      if (!page_slug) return res.status(400).json({ error: 'valid page_slug required' });

      const v = await getOrAssignVariant({
        db,
        sql,
        session_id: sid,
        page_slug,
        language: lang,
        source,
        audience,
        campaign: utmCampaign,
      });
      if (!v) return res.status(503).json({ error: 'no live variant configured' });

      // Upsert the session row with page/variant + UTMs/IP/UA from this GET request.
      // COALESCE so whichever of /api/lp/config and /api/track arrives second only fills gaps.
      await db.query(sql`
        INSERT INTO page_sessions (id, page_slug, variant_id, language, ip_address, user_agent, utm_source, utm_medium, utm_campaign, utm_content)
        VALUES (${sid}, ${page_slug}, ${v.id}, ${lang}, ${ip}, ${ua}, ${source}, ${utmMedium}, ${utmCampaign}, ${audience})
        ON CONFLICT(id) DO UPDATE SET
          page_slug   = COALESCE(page_sessions.page_slug, excluded.page_slug),
          variant_id  = COALESCE(page_sessions.variant_id, excluded.variant_id),
          language    = COALESCE(page_sessions.language, excluded.language),
          ip_address  = COALESCE(page_sessions.ip_address, excluded.ip_address),
          user_agent  = COALESCE(page_sessions.user_agent, excluded.user_agent),
          utm_source  = COALESCE(page_sessions.utm_source, excluded.utm_source),
          utm_medium  = COALESCE(page_sessions.utm_medium, excluded.utm_medium),
          utm_campaign= COALESCE(page_sessions.utm_campaign, excluded.utm_campaign),
          utm_content = COALESCE(page_sessions.utm_content, excluded.utm_content),
          last_seen   = datetime('now')
      `);

      let config;
      try { config = JSON.parse(v.config); } catch (_) { config = {}; }

      res.json({
        session_id: sid,
        variant_id: v.id,
        variant_slug: v.slug,
        page_slug,
        config,
      });
    } catch (e) {
      console.warn('[lp] config failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/stats', async (req, res) => {
    try {
      const db = getDb();
      const page = PAGE_SLUGS.includes(String(req.query.page_slug || '').toLowerCase())
        ? String(req.query.page_slug).toLowerCase()
        : null;
      const rows = await db.query(page ? sql`
        SELECT v.page_slug, v.slug AS variant_slug, v.id AS variant_id, v.traffic_weight,
               COUNT(ps.id) AS sessions,
               COALESCE(SUM(ps.reached_cta),0) AS reached_cta,
               COALESCE(SUM(ps.cta_clicked),0) AS wa_clicks,
               COALESCE(SUM(ps.converted),0) AS conversions,
               ROUND(100.0 * COALESCE(SUM(ps.converted),0) / NULLIF(COUNT(ps.id),0), 1) AS conv_rate_pct,
               ROUND(AVG(ps.dwell_ms)) AS avg_dwell_ms,
               ROUND(AVG(ps.max_scroll_pct)) AS avg_scroll_pct
        FROM lp_variants v
        LEFT JOIN page_sessions ps ON ps.variant_id = v.id
        WHERE v.status = 'live' AND v.page_slug = ${page}
        GROUP BY v.id
        ORDER BY sessions DESC
      ` : sql`
        SELECT v.page_slug, v.slug AS variant_slug, v.id AS variant_id, v.traffic_weight,
               COUNT(ps.id) AS sessions,
               COALESCE(SUM(ps.reached_cta),0) AS reached_cta,
               COALESCE(SUM(ps.cta_clicked),0) AS wa_clicks,
               COALESCE(SUM(ps.converted),0) AS conversions,
               ROUND(100.0 * COALESCE(SUM(ps.converted),0) / NULLIF(COUNT(ps.id),0), 1) AS conv_rate_pct,
               ROUND(AVG(ps.dwell_ms)) AS avg_dwell_ms,
               ROUND(AVG(ps.max_scroll_pct)) AS avg_scroll_pct
        FROM lp_variants v
        LEFT JOIN page_sessions ps ON ps.variant_id = v.id
        WHERE v.status = 'live'
        GROUP BY v.id
        ORDER BY v.page_slug, sessions DESC
      `);
      res.json({ variants: rows });
    } catch (e) {
      console.warn('[lp] stats failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
