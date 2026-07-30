'use strict';
//
// routes/landing.js — landing-page video provisioning.
//
// Mounted at /api/landing in server.js. Localhost-only. Handles the
// post-transcode "place file + record assignment" step. The actual
// ffmpeg encode happens in the operator CLI (media/scripts/
// provision-landing-video.js) because the CRM cannot read source
// footage on /Volumes/<external>/ — TCC denies launchd-spawned
// processes Full Disk Access on removable volumes.
//
// Endpoints:
//   POST /api/landing/finalize-video   move transcoded file into landing/apps/<slug>/public/video/<slot>.mp4 + record assignment
//   GET  /api/landing/assignments      current active assignments (optional ?slug=<slug>)
//   POST /api/landing/rollback         restore the previous file for a (slug, slot) and reactivate its DB row

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sql } = require('@databases/sqlite');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LANDING_ROOT = path.resolve(
  process.env.LANDING_APPS_ROOT || path.join(REPO_ROOT, 'landing', 'apps'),
);

function isLocal(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function err(res, status, body) { return res.status(status).json(body); }

function listSlugs() {
  if (!fs.existsSync(LANDING_ROOT)) return [];
  return fs.readdirSync(LANDING_ROOT).filter((d) =>
    fs.statSync(path.join(LANDING_ROOT, d)).isDirectory()
  );
}

function attachRoutes(router, getDb) {

  // ─── Finalize provisioning ─────────────────────────────────────────────
  router.post('/finalize-video', express.json(), async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const b = req.body || {};
    const required = ['asset_id', 'slug', 'slot', 'transcoded_path'];
    for (const k of required) {
      if (b[k] == null || b[k] === '') return err(res, 400, { error: 'missing_required_field', field: k });
    }
    if (!/^[a-z0-9-]+$/.test(b.slug)) return err(res, 400, { error: 'invalid_slug', slug: b.slug });
    if (!/^[a-z0-9-]+$/.test(b.slot)) return err(res, 400, { error: 'invalid_slot', slot: b.slot });

    const slugs = listSlugs();
    if (!slugs.includes(b.slug)) return err(res, 400, { error: 'unknown_slug', slug: b.slug, available: slugs });

    if (!fs.existsSync(b.transcoded_path)) return err(res, 400, { error: 'transcoded_file_missing', path: b.transcoded_path });

    const db = getDb();
    const [asset] = await db.query(sql`SELECT id, kind FROM media_assets WHERE id=${b.asset_id}`);
    if (!asset) return err(res, 404, { error: 'asset_not_found', asset_id: b.asset_id });
    if (asset.kind !== 'video') return err(res, 400, { error: 'asset_not_video', kind: asset.kind });

    const targetDir = path.join(LANDING_ROOT, b.slug, 'public', 'video');
    const backupDir = path.join(LANDING_ROOT, b.slug, 'videos-backup');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const targetPath = path.join(targetDir, `${b.slot}.mp4`);
    // Backups live OUTSIDE public/ — Astro copies everything under public/
    // to dist/ verbatim (empirically verified by sentinel-file test), so a
    // .prev sibling of the active file would deploy to Cloudflare. The
    // sibling videos-backup/ directory is not copied by `astro build`.
    const prevPath = path.join(backupDir, `${b.slot}.mp4.prev`);

    // Backup existing slot file, atomically move transcoded into place.
    try {
      if (fs.existsSync(targetPath)) {
        if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
        fs.renameSync(targetPath, prevPath);
      }
      fs.renameSync(b.transcoded_path, targetPath);
    } catch (e) {
      return err(res, 500, { error: 'file_placement_failed', detail: e.message });
    }

    const stat = fs.statSync(targetPath);

    // Supersede any prior active row, insert new active row.
    await db.query(sql`
      UPDATE landing_video_assignments
         SET status='superseded'
       WHERE landing_slug=${b.slug} AND slot=${b.slot} AND status='active'
    `);
    await db.query(sql`
      INSERT INTO landing_video_assignments
        (landing_slug, slot, asset_id, transcoded_path, prev_path,
         target_height, target_bitrate_kbps, duration_ms, start_offset_ms,
         size_bytes, status, provisioned_by, notes)
      VALUES
        (${b.slug}, ${b.slot}, ${b.asset_id}, ${targetPath}, ${prevPath},
         ${b.target_height || 1080}, ${b.target_bitrate_kbps || null},
         ${b.duration_ms || null}, ${b.start_offset_ms || 0},
         ${stat.size}, 'active', ${b.provisioned_by || null}, ${b.notes || null})
    `);
    const [row] = await db.query(sql`
      SELECT id, provisioned_at FROM landing_video_assignments
       WHERE landing_slug=${b.slug} AND slot=${b.slot} AND status='active'
    `);

    return res.json({
      ok: true,
      assignment_id: row.id,
      provisioned_at: row.provisioned_at,
      placed_at: targetPath,
      size_bytes: stat.size,
      backed_up_prev: fs.existsSync(prevPath) ? prevPath : null,
      deploy_hint: `cd landing/apps/${b.slug} && npx astro build && npx wrangler pages deploy`,
    });
  });

  // ─── List active assignments ───────────────────────────────────────────
  router.get('/assignments', async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const db = getDb();
    const slug = req.query.slug;
    const rows = slug
      ? await db.query(sql`SELECT * FROM landing_video_assignments WHERE status='active' AND landing_slug=${slug} ORDER BY provisioned_at DESC`)
      : await db.query(sql`SELECT * FROM landing_video_assignments WHERE status='active' ORDER BY landing_slug, slot`);
    return res.json(rows);
  });

  // ─── Rollback (restore .prev for a slot) ───────────────────────────────
  router.post('/rollback', express.json(), async (req, res) => {
    if (!isLocal(req)) return err(res, 403, { error: 'localhost_only' });
    const { slug, slot } = req.body || {};
    if (!slug || !slot) return err(res, 400, { error: 'missing_required_field', need: ['slug', 'slot'] });
    const db = getDb();
    const [active] = await db.query(sql`
      SELECT * FROM landing_video_assignments
       WHERE landing_slug=${slug} AND slot=${slot} AND status='active'
    `);
    if (!active) return err(res, 404, { error: 'no_active_assignment', slug, slot });
    if (!active.prev_path || !fs.existsSync(active.prev_path)) {
      return err(res, 400, { error: 'no_prev_to_restore', prev_path: active.prev_path });
    }
    try {
      if (fs.existsSync(active.transcoded_path)) fs.unlinkSync(active.transcoded_path);
      fs.renameSync(active.prev_path, active.transcoded_path);
    } catch (e) {
      return err(res, 500, { error: 'restore_failed', detail: e.message });
    }
    await db.query(sql`UPDATE landing_video_assignments SET status='rolled_back' WHERE id=${active.id}`);
    const [prior] = await db.query(sql`
      SELECT id FROM landing_video_assignments
       WHERE landing_slug=${slug} AND slot=${slot} AND status='superseded'
       ORDER BY id DESC LIMIT 1
    `);
    if (prior) {
      await db.query(sql`UPDATE landing_video_assignments SET status='active' WHERE id=${prior.id}`);
    }
    return res.json({
      ok: true,
      restored: active.transcoded_path,
      rolled_back_assignment_id: active.id,
      reactivated_assignment_id: prior ? prior.id : null,
    });
  });

  return router;
}

function buildRouter(getDb) {
  const router = express.Router();
  attachRoutes(router, getDb);
  return router;
}

module.exports = { buildRouter };
