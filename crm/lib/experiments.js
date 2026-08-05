'use strict';
//
// crm/lib/experiments.js -- resort optimizer experiments ledger.
//
// Every landing-page or paid-campaign change should have an observable primary
// metric and a review date. UTM-linked rows can pin a Meta campaign to a live
// variant through crm/lib/variants.js.
//

const WRITABLE = [
  'slug', 'title', 'status', 'kind', 'bucket', 'funnel_stage', 'blast_radius',
  'hypothesis', 'rationale', 'change_made', 'primary_metric',
  'guardrail_metrics', 'baseline_value', 'target_value', 'observation_window',
  'review_at', 'linked_variant_slug', 'linked_campaign_id',
  'linked_utm_campaign', 'result', 'conclusion', 'source', 'created_by',
];

const STATUSES = ['proposed', 'running', 'concluded', 'abandoned'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function createExperiment(opts) {
  const { db, sql } = opts;
  const f = pick(opts, WRITABLE);
  if (!f.slug) throw new Error('slug required');
  if (!f.title) throw new Error('title required');
  if (!f.primary_metric) throw new Error('primary_metric required');
  if (f.status && !STATUSES.includes(f.status)) throw new Error(`bad status: ${f.status}`);

  const cols = Object.keys(f);
  const colSql = cols.map((c) => sql.ident(c));
  const valSql = cols.map((c) => sql`${f[c]}`);
  await db.query(sql`
    INSERT INTO experiments (${sql.join(colSql, sql`, `)})
    VALUES (${sql.join(valSql, sql`, `)})
  `);
  return getExperiment({ db, sql, slug: f.slug });
}

async function getExperiment({ db, sql, slug }) {
  const rows = await db.query(sql`SELECT * FROM experiments WHERE slug = ${slug} LIMIT 1`);
  return rows[0] || null;
}

async function listExperiments({ db, sql, status }) {
  if (status) {
    return db.query(sql`SELECT * FROM experiments WHERE status = ${status} ORDER BY created_at DESC`);
  }
  return db.query(sql`SELECT * FROM experiments ORDER BY created_at DESC`);
}

async function updateExperiment({ db, sql, slug, patch }) {
  const f = pick(patch || {}, WRITABLE.filter((k) => k !== 'slug'));
  if (f.status && !STATUSES.includes(f.status)) throw new Error(`bad status: ${f.status}`);
  const existing = await getExperiment({ db, sql, slug });
  if (!existing) return null;

  const sets = Object.keys(f).map((c) => sql`${sql.ident(c)} = ${f[c]}`);
  sets.push(sql`updated_at = datetime('now')`);
  if (f.status === 'concluded' || f.status === 'abandoned') {
    sets.push(sql`concluded_at = COALESCE(concluded_at, datetime('now'))`);
  }
  await db.query(sql`UPDATE experiments SET ${sql.join(sets, sql`, `)} WHERE slug = ${slug}`);
  return getExperiment({ db, sql, slug });
}

async function snapshotFor({ db, sql }, exp) {
  const base = {
    scope: null,
    sessions: 0,
    qualified: 0,
    reached_cta: 0,
    cta_clicked: 0,
    converted: 0,
    leads: 0,
    bookings: 0,
    qualified_rate: null,
    cta_click_rate: null,
    lead_rate: null,
    booking_rate: null,
  };

  let where = null;
  if (exp.linked_variant_slug) {
    const v = (await db.query(sql`SELECT id FROM lp_variants WHERE slug = ${exp.linked_variant_slug} LIMIT 1`))[0];
    if (v) {
      where = sql`variant_id = ${v.id}`;
      base.scope = `variant:${exp.linked_variant_slug}`;
    }
  } else if (exp.linked_utm_campaign) {
    where = sql`utm_campaign = ${exp.linked_utm_campaign}`;
    base.scope = `utm_campaign:${exp.linked_utm_campaign}`;
  }
  if (!where) return base;

  const [agg] = await db.query(sql`
    SELECT
      COUNT(*) AS sessions,
      COALESCE(SUM(CASE WHEN max_scroll_pct > 0 OR reached_cta = 1 OR dwell_ms >= 10000 THEN 1 ELSE 0 END), 0) AS qualified,
      COALESCE(SUM(reached_cta), 0) AS reached_cta,
      COALESCE(SUM(cta_clicked), 0) AS cta_clicked,
      COALESCE(SUM(converted), 0) AS converted,
      COALESCE(SUM(CASE WHEN lead_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS leads_via_session
    FROM page_sessions WHERE is_bot=0 AND ${where}
  `);
  Object.assign(base, {
    sessions: agg.sessions || 0,
    qualified: agg.qualified || 0,
    reached_cta: agg.reached_cta || 0,
    cta_clicked: agg.cta_clicked || 0,
    converted: agg.converted || 0,
    leads: agg.leads_via_session || 0,
  });

  if (exp.linked_utm_campaign) {
    const [{ n: leads }] = await db.query(sql`SELECT COUNT(*) AS n FROM leads WHERE utm_campaign = ${exp.linked_utm_campaign}`);
    const [{ n: bookings }] = await db.query(sql`
      SELECT COUNT(*) AS n FROM leads
      WHERE utm_campaign = ${exp.linked_utm_campaign} AND status = 'booked'
    `);
    base.leads = leads || 0;
    base.bookings = bookings || 0;
  }

  const pct = (num, den) => (den ? +(100 * num / den).toFixed(1) : null);
  base.qualified_rate = pct(base.qualified, base.sessions);
  base.cta_click_rate = pct(base.cta_clicked, base.sessions);
  base.lead_rate = pct(base.leads, base.qualified || base.sessions);
  base.booking_rate = pct(base.bookings, base.leads);
  return base;
}

function daysBetween(fromIso, toDate) {
  if (!fromIso) return null;
  const a = new Date(fromIso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(a.getTime())) return null;
  return Math.floor((toDate - a) / 86400000);
}

async function scoreboard({ db, sql }) {
  const running = await db.query(sql`SELECT * FROM experiments WHERE status = 'running' ORDER BY created_at ASC`);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const experiments = [];
  for (const exp of running) {
    experiments.push({
      slug: exp.slug,
      title: exp.title,
      kind: exp.kind,
      bucket: exp.bucket,
      funnel_stage: exp.funnel_stage,
      blast_radius: exp.blast_radius,
      primary_metric: exp.primary_metric,
      target_value: exp.target_value,
      baseline_value: exp.baseline_value,
      review_at: exp.review_at,
      review_due: !!(exp.review_at && exp.review_at <= todayStr),
      days_running: daysBetween(exp.created_at, today),
      metrics: await snapshotFor({ db, sql }, exp),
    });
  }
  return { as_of: todayStr, count: experiments.length, experiments };
}

module.exports = {
  createExperiment,
  getExperiment,
  listExperiments,
  updateExperiment,
  snapshotFor,
  scoreboard,
  STATUSES,
  WRITABLE,
};
