-- Migration 016: landing-page video provisioning
--
-- Tracks which media_assets clip is currently provisioned to which
-- (landing_slug, slot) on the public landing pages under landing/apps/.
-- Used by media/scripts/provision-landing-video.js + /api/landing/*.
--
-- One row per provisioning event. The `active` row for a given
-- (landing_slug, slot) is the one currently serving. Older rows are
-- marked `superseded` (replaced by a newer provision) or `rolled_back`
-- (operator restored the previous file). Partial unique index enforces
-- one active row per slot.

CREATE TABLE IF NOT EXISTS landing_video_assignments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  landing_slug         TEXT NOT NULL,
  slot                 TEXT NOT NULL,
  asset_id             INTEGER NOT NULL REFERENCES media_assets(id),
  transcoded_path      TEXT NOT NULL,
  prev_path            TEXT,
  target_height        INTEGER NOT NULL,
  target_bitrate_kbps  INTEGER,
  duration_ms          INTEGER,
  start_offset_ms      INTEGER NOT NULL DEFAULT 0,
  size_bytes           INTEGER,
  status               TEXT NOT NULL DEFAULT 'active',
  provisioned_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provisioned_by       TEXT,
  notes                TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_landing_video_active
  ON landing_video_assignments(landing_slug, slot)
  WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_landing_video_slug_slot
  ON landing_video_assignments(landing_slug, slot);

CREATE INDEX IF NOT EXISTS idx_landing_video_asset
  ON landing_video_assignments(asset_id);
