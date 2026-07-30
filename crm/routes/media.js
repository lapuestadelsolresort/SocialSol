'use strict';
//
// routes/media.js — agent-facing media query + serve API.
//
// Mounted at /api/media in server.js (alongside /api/voice).
// Localhost-only. Hybrid Chroma + SQL filtering:
//   - q (natural language) → embed via OpenAI → Chroma kNN against media_corpus
//   - persona → blend Chroma score with that persona_fit weight (default 0.7/0.3)
//   - kind, setting, mood, source_role, min/max duration → SQL/metadata filters
//
// Endpoints:
//   GET  /api/media/search             ranked search
//   GET  /api/media/list               paged flat listing (no Chroma)
//   GET  /api/media/asset/:id          full record
//   GET  /api/media/proxy/:id          stream local proxy file
//   GET  /api/media/rendition/:id/:aspect  IG-ready rendition (9x16, 1x1)
//   GET  /api/media/thumb/:id/:n       keyframe JPEG
//   GET  /api/media/waveform/:id       audio waveform PNG
//   GET  /api/media/photo/:id          cached Drive photo
//   POST /api/media/reingest           flip a shoot's assets to 'registered'
//   GET  /api/media/health             pipeline counters

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sql } = require('@databases/sqlite');
const { connectOnce } = require('../lib/chroma-connect');
const { embedQuery } = require('../lib/openai-embed');

const CHROMA_URL = 'http://localhost:8000';
const PERSONA_FITS = [
  'wedding_planner_outreach',
  'corporate_retreat_outreach',
  'past_guest_reactivation',
  'organic_social_aspirational',
  'paid_social_conversion',
  'landing_page_hero',
];

function isLocal(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function err(res, status, body) { return res.status(status).json(body); }

async function ensureCollection(req) {
  if (req.app.locals.chromaMediaCorpus) return req.app.locals.chromaMediaCorpus;
  const client = req.app.locals.chromaClient || await connectOnce({ url: CHROMA_URL });
  const col = await client.getOrCreateCollection({ name: 'media_corpus' });
  req.app.locals.chromaClient = client;
  req.app.locals.chromaMediaCorpus = col;
  return col;
}

// Compose a Chroma `where` filter from query params.
function buildChromaWhere(params) {
  const ands = [];
  if (params.kind) ands.push({ kind: { '$eq': String(params.kind) } });
  if (params.source_role) ands.push({ source_role: { '$eq': String(params.source_role) } });
  if (params.shoot_id) ands.push({ shoot_id: { '$eq': Number(params.shoot_id) } });
  if (params.min_duration_ms) ands.push({ duration_ms: { '$gte': Number(params.min_duration_ms) } });
  if (params.max_duration_ms) ands.push({ duration_ms: { '$lte': Number(params.max_duration_ms) } });
  if (ands.length === 0) return null;
  if (ands.length === 1) return ands[0];
  return { '$and': ands };
}

function attachRoutes(router, getDb) {

  // ─── Search ─────────────────────────────────────────────────────────────
  router.get('/search', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const q = req.query.q || req.query.query;
    if (!q) return err(res, 400, { error: 'missing_required_field', field: 'q' });
    const persona = req.query.persona || null;
    if (persona && !PERSONA_FITS.includes(persona)) {
      return err(res, 400, { error: 'invalid_value', field: 'persona', allowed: PERSONA_FITS });
    }
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10)));
    const kSemantic = Math.max(limit * 3, 30); // overshoot for rerank
    const debug = String(req.query.debug || '') === '1';

    let collection;
    try { collection = await ensureCollection(req); }
    catch (e) { return err(res, 503, { error: 'service_unavailable', service: 'chroma', detail: e.message }); }

    let queryEmbedding;
    try {
      const r = await embedQuery(String(q));
      queryEmbedding = r.embedding;
    } catch (e) {
      return err(res, 503, { error: 'service_unavailable', service: 'openai_embeddings', detail: e.message });
    }

    const where = buildChromaWhere(req.query);
    let result;
    try {
      result = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: kSemantic,
        where: where || undefined,
      });
    } catch (e) {
      return err(res, 503, { error: 'service_unavailable', service: 'chroma_query', detail: e.message });
    }

    const ids = (result.ids && result.ids[0]) || [];
    const dists = (result.distances && result.distances[0]) || [];
    const metas = (result.metadatas && result.metadatas[0]) || [];
    const docs = (result.documents && result.documents[0]) || [];

    // Convert cosine distance ([0,2]) to a [0,1] score where higher = better.
    function semScore(d) { if (d == null) return 0; return Math.max(0, 1 - d / 2); }

    const blendedRows = [];
    for (let i = 0; i < ids.length; i++) {
      const md = metas[i] || {};
      const score = semScore(dists[i]);
      const personaScore = persona ? Number(md[`pf_${persona}`] || 0) : 0;
      const final = persona ? 0.7 * score + 0.3 * personaScore : score;
      // Apply optional setting/mood filter (Chroma `where` doesn't grok
      // comma-substring matches, so we post-filter here).
      if (req.query.setting && !String(md.setting || '').split(',').includes(req.query.setting)) continue;
      if (req.query.mood && !String(md.mood || '').split(',').includes(req.query.mood)) continue;
      blendedRows.push({ id: ids[i], asset_id: Number(md.asset_id), doc: docs[i], md, score, personaScore, final });
    }
    blendedRows.sort((a, b) => b.final - a.final);
    const top = blendedRows.slice(0, limit);

    if (!top.length) return res.json([]);

    // Hydrate from SQL (proxy_path, filename, source_path). N is small
    // (limit <= 50), so per-id lookups are fine and avoid @databases'
    // "Expected query to be an SQLQuery" restriction on dynamic IN clauses.
    const db = getDb();
    const rows = [];
    for (const r of top) {
      const found = await db.query(sql`
        SELECT a.id, a.shoot_id, a.source_role, a.kind, a.filename,
               a.duration_ms, a.proxy_path, a.thumb_dir, a.waveform_path,
               a.width, a.height,
               s.slug AS shoot_slug,
               cs.synopsis, cs.tags_json, cs.persona_fit_json
          FROM media_assets a
          JOIN shoots s ON s.id = a.shoot_id
          LEFT JOIN media_clip_synopses cs ON cs.asset_id = a.id
         WHERE a.id=${r.asset_id}
      `);
      if (found.length) rows.push(found[0]);
    }
    const byId = new Map(rows.map(r => [r.id, r]));
    const out = top.map(r => {
      const a = byId.get(r.asset_id);
      if (!a) return null;
      const tagFile = a.kind === 'audio' ? null : `/api/media/thumb/${a.id}/0`;
      const proxyUrl = a.proxy_path ? `/api/media/proxy/${a.id}` : null;
      return {
        asset_id: a.id,
        shoot: a.shoot_slug,
        kind: a.kind,
        source_role: a.source_role,
        filename: a.filename,
        duration_ms: a.duration_ms,
        width: a.width, height: a.height,
        synopsis: a.synopsis || r.doc,
        tags: a.tags_json ? JSON.parse(a.tags_json) : null,
        persona_fit: a.persona_fit_json ? JSON.parse(a.persona_fit_json) : null,
        score: Number(r.final.toFixed(4)),
        semantic_score: Number(r.score.toFixed(4)),
        persona_score: persona ? Number(r.personaScore.toFixed(4)) : null,
        proxy_url: proxyUrl,
        thumb_url: tagFile,
        waveform_url: a.waveform_path ? `/api/media/waveform/${a.id}` : null,
      };
    }).filter(Boolean);

    if (debug) return res.json({ results: out, raw_count: blendedRows.length, persona, q });
    return res.json(out);
  });

  // ─── List ───────────────────────────────────────────────────────────────
  // Flat paged listing straight from SQL — no Chroma, no query embedding.
  // Exists so the media browser (and any audit) can enumerate the whole
  // library instead of approximating it with broad searches.
  router.get('/list', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '250', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const db = getDb();
    const kindFilter = req.query.kind ? sql`AND a.kind=${String(req.query.kind)}` : sql``;
    const roleFilter = req.query.source_role ? sql`AND a.source_role=${String(req.query.source_role)}` : sql``;
    const rows = await db.query(sql`
      SELECT a.id, a.shoot_id, a.source_role, a.kind, a.filename,
             a.duration_ms, a.width, a.height, a.status,
             a.proxy_path, a.thumb_dir, a.waveform_path, a.renditions_json,
             s.slug AS shoot_slug,
             cs.synopsis, cs.tags_json
        FROM media_assets a
        JOIN shoots s ON s.id = a.shoot_id
        LEFT JOIN media_clip_synopses cs ON cs.asset_id = a.id
       WHERE 1=1 ${kindFilter} ${roleFilter}
       ORDER BY a.id
       LIMIT ${limit} OFFSET ${offset}
    `);
    res.json(rows.map((a) => ({
      asset_id: a.id,
      shoot: a.shoot_slug,
      kind: a.kind,
      source_role: a.source_role,
      filename: a.filename,
      status: a.status,
      duration_ms: a.duration_ms,
      width: a.width, height: a.height,
      synopsis: a.synopsis || null,
      tags: a.tags_json ? JSON.parse(a.tags_json) : null,
      renditions: a.renditions_json ? JSON.parse(a.renditions_json) : null,
      proxy_url: (a.proxy_path || a.kind === 'photo') ? `/api/media/proxy/${a.id}` : null,
      thumb_url: a.kind === 'audio' ? null : `/api/media/thumb/${a.id}/0`,
      waveform_url: a.waveform_path ? `/api/media/waveform/${a.id}` : null,
    })));
  });

  // ─── Asset detail ───────────────────────────────────────────────────────
  router.get('/asset/:id', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return err(res, 400, { error: 'invalid_id' });
    const db = getDb();
    const [a] = await db.query(sql`
      SELECT a.*, s.slug AS shoot_slug
        FROM media_assets a JOIN shoots s ON s.id = a.shoot_id
       WHERE a.id=${id}
    `);
    if (!a) return err(res, 404, { error: 'not_found' });
    const kfs = await db.query(sql`SELECT frame_idx, timestamp_ms, caption, tags_json FROM media_keyframe_captions WHERE asset_id=${id} ORDER BY frame_idx`);
    const [syn] = await db.query(sql`SELECT synopsis, tags_json, persona_fit_json FROM media_clip_synopses WHERE asset_id=${id}`);
    const tr = await db.query(sql`SELECT source, language, text, cost_usd FROM media_transcripts WHERE asset_id=${id}`);
    res.json({
      asset: a,
      keyframes: kfs.map(k => ({ ...k, tags: k.tags_json ? JSON.parse(k.tags_json) : null })),
      synopsis: syn ? { ...syn, tags: syn.tags_json ? JSON.parse(syn.tags_json) : null, persona_fit: syn.persona_fit_json ? JSON.parse(syn.persona_fit_json) : null } : null,
      transcripts: tr,
      proxy_url: a.proxy_path ? `/api/media/proxy/${a.id}` : null,
      thumb_url: a.thumb_dir ? `/api/media/thumb/${a.id}/0` : null,
      waveform_url: a.waveform_path ? `/api/media/waveform/${a.id}` : null,
    });
  });

  // ─── Proxy file ─────────────────────────────────────────────────────────
  router.get('/proxy/:id', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return err(res, 400, { error: 'invalid_id' });
    const db = getDb();
    const [a] = await db.query(sql`SELECT proxy_path, kind, source_path FROM media_assets WHERE id=${id}`);
    if (!a) return err(res, 404, { error: 'not_found' });
    // Photos: serve the cached file (source_path doubles as the local cache for kind=photo).
    const target = a.kind === 'photo' ? a.source_path : a.proxy_path;
    if (!target || !fs.existsSync(target)) return err(res, 404, { error: 'proxy_missing' });
    res.setHeader('Content-Type', a.kind === 'photo' ? 'image/jpeg' : 'video/mp4');
    return fs.createReadStream(target).pipe(res);
  });

  // ─── Rendition ──────────────────────────────────────────────────────────
  // IG-ready renditions written by media/scripts/render-vertical.js.
  // :aspect accepts "9x16" / "1x1", or the rendition filename ("8-9x16.mp4").
  router.get('/rendition/:id/:aspect', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return err(res, 400, { error: 'invalid_id' });
    const aspect = req.params.aspect.replace(/\.mp4$/i, '').replace(new RegExp(`^${id}-`), '');
    const db = getDb();
    const [a] = await db.query(sql`SELECT renditions_json FROM media_assets WHERE id=${id}`);
    if (!a) return err(res, 404, { error: 'not_found' });
    const renditions = a.renditions_json ? JSON.parse(a.renditions_json) : {};
    const r = renditions[aspect];
    if (!r || !r.path || !fs.existsSync(r.path)) {
      return err(res, 404, {
        error: 'rendition_missing',
        available: Object.keys(renditions),
        hint: `node media/scripts/render-vertical.js --asset-id=${id} --aspect=${aspect}`,
      });
    }
    res.setHeader('Content-Type', 'video/mp4');
    return fs.createReadStream(r.path).pipe(res);
  });

  // ─── Keyframe ───────────────────────────────────────────────────────────
  router.get('/thumb/:id/:n', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const id = parseInt(req.params.id, 10);
    const n = parseInt(req.params.n, 10);
    if (!Number.isInteger(id) || !Number.isInteger(n)) return err(res, 400, { error: 'invalid_id' });
    const db = getDb();
    const [k] = await db.query(sql`SELECT frame_path FROM media_keyframe_captions WHERE asset_id=${id} AND frame_idx=${n}`);
    if (!k || !k.frame_path || !fs.existsSync(k.frame_path)) return err(res, 404, { error: 'thumb_missing' });
    res.setHeader('Content-Type', 'image/jpeg');
    return fs.createReadStream(k.frame_path).pipe(res);
  });

  // ─── Waveform ───────────────────────────────────────────────────────────
  router.get('/waveform/:id', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return err(res, 400, { error: 'invalid_id' });
    const db = getDb();
    const [a] = await db.query(sql`SELECT waveform_path FROM media_assets WHERE id=${id}`);
    if (!a || !a.waveform_path || !fs.existsSync(a.waveform_path)) return err(res, 404, { error: 'waveform_missing' });
    res.setHeader('Content-Type', 'image/png');
    return fs.createReadStream(a.waveform_path).pipe(res);
  });

  // ─── Reingest ───────────────────────────────────────────────────────────
  router.post('/reingest', express.json(), async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const shootId = req.body && req.body.shoot_id;
    if (!shootId) return err(res, 400, { error: 'missing_field', field: 'shoot_id' });
    const db = getDb();
    await db.query(sql`UPDATE media_assets SET status='registered' WHERE shoot_id=${shootId}`);
    res.json({ ok: true });
  });

  // ─── Health ─────────────────────────────────────────────────────────────
  router.get('/health', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const db = getDb();
    const counts = await db.query(sql`SELECT status, COUNT(*) AS n FROM media_assets GROUP BY status`);
    const synopsisCount = await db.query(sql`SELECT COUNT(*) AS n FROM media_clip_synopses`);
    const transcriptCount = await db.query(sql`SELECT COUNT(*) AS n FROM media_transcripts`);
    const captionCount = await db.query(sql`SELECT COUNT(*) AS n FROM media_keyframe_captions WHERE caption IS NOT NULL`);
    res.json({
      assets_by_status: counts,
      synopses: (synopsisCount[0] || {}).n,
      transcripts: (transcriptCount[0] || {}).n,
      captioned_keyframes: (captionCount[0] || {}).n,
    });
  });

  return router;
}

function buildRouter(getDb) {
  const router = express.Router();
  attachRoutes(router, getDb);
  return router;
}

module.exports = { buildRouter, PERSONA_FITS };
