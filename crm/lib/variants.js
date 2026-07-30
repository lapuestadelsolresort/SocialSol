'use strict';
//
// crm/lib/variants.js — landing-page variant resolution + sticky assignment.
//
// Ported from GoldRoute, adapted for the resort: the tenancy key is page_slug
// (weddings | fitness | retreats) instead of partner_id. A visitor is assigned
// exactly one live variant per session and always sees the same one (sticky via
// lp_assignments).
//
// Match precedence (most specific first) within a page_slug+language:
//   1. experiments.linked_utm_campaign -> linked_variant_slug
//   2. source = utm_source  AND audience = utm_content
//   3. source = utm_source  AND audience IS NULL
//   4. source IS NULL       AND audience IS NULL   (default)
// Within the most-specific non-empty tier we weighted-random by traffic_weight.
//

const crypto = require('crypto');

function weightedPick(rows) {
  const total = rows.reduce((s, r) => s + (r.traffic_weight || 0), 0);
  if (total <= 0) return rows[0] || null;
  let n = crypto.randomInt(0, total);
  for (const r of rows) {
    n -= (r.traffic_weight || 0);
    if (n < 0) return r;
  }
  return rows[rows.length - 1];
}

// Pick the most specific tier that has at least one candidate.
function tierFor(rows, source, audience) {
  const tiers = [
    rows.filter((r) => r.source === source && source != null && r.audience === audience && audience != null),
    rows.filter((r) => r.source === source && source != null && r.audience == null),
    rows.filter((r) => r.source == null && r.audience == null),
  ];
  for (const t of tiers) if (t.length) return t;
  // Nothing matched the targeting rules but variants exist — fall back to any.
  return rows;
}

async function resolveVariant({ db, sql, page_slug, language, source, audience, campaign }) {
  const rows = await db.query(sql`
    SELECT * FROM lp_variants
    WHERE status = 'live' AND page_slug = ${page_slug} AND language = ${language}
  `);
  if (!rows.length) {
    // Last-resort: any live variant for this page, ignoring language targeting.
    const any = await db.query(sql`
      SELECT * FROM lp_variants WHERE status='live' AND page_slug=${page_slug} LIMIT 1
    `);
    return any[0] || null;
  }
  if (campaign) {
    try {
      const linked = await db.query(sql`
        SELECT v.* FROM experiments e
        JOIN lp_variants v ON v.slug = e.linked_variant_slug
        WHERE e.linked_utm_campaign = ${campaign}
          AND e.linked_variant_slug IS NOT NULL
          AND e.status = 'running'
          AND v.status = 'live'
          AND v.page_slug = ${page_slug}
          AND v.language = ${language}
        ORDER BY e.created_at DESC
        LIMIT 1
      `);
      if (linked.length) return linked[0];
    } catch (_) {
      // Campaign-linked variants are an optimization layer. Fallback serving
      // keeps the page alive if an older DB has not booted the ledger yet.
    }
  }
  return weightedPick(tierFor(rows, source || null, audience || null));
}

async function getOrAssignVariant(opts) {
  const { db, sql, session_id } = opts;
  const existing = await db.query(sql`
    SELECT v.* FROM lp_assignments a JOIN lp_variants v ON v.id = a.variant_id
    WHERE a.session_id = ${session_id}
  `);
  if (existing.length) return existing[0];

  const v = await resolveVariant(opts);
  if (!v) return null;

  await db.query(sql`
    INSERT INTO lp_assignments (session_id, variant_id)
    VALUES (${session_id}, ${v.id})
    ON CONFLICT(session_id) DO NOTHING
  `);
  return v;
}

module.exports = { resolveVariant, getOrAssignVariant, weightedPick, tierFor };
