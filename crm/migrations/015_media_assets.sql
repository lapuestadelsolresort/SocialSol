-- Migration 015: media assets pipeline
--
-- Adds the schema agents in #social-sol, #prospector-paulina, and
-- #reengager-regina use to query photos and videos by natural language,
-- persona, setting, mood, duration, etc.
--
-- One shoots row per body of footage (e.g. the Oct 28 2025 property
-- shoot on /Volumes/Sarah). One media_assets row per source file
-- (MXF / MP4 / WAV / JPG). Per-asset: a Whisper transcript (for audio),
-- N keyframe captions (for video/photo), and one clip synopsis that gets
-- embedded into the Chroma "media_corpus" collection alongside Sarah's
-- voice corpus.
--
-- Status machine: registered -> proxied -> transcribed -> captioned -> indexed.
-- Each pipeline script advances rows it can act on; re-runs are idempotent.

CREATE TABLE IF NOT EXISTS shoots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  shoot_date     DATE,
  location       TEXT,
  description    TEXT,
  source_root    TEXT NOT NULL,
  ingested_at    DATETIME,
  notes          TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media_assets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  shoot_id           INTEGER REFERENCES shoots(id),
  source_role        TEXT NOT NULL,
  kind               TEXT NOT NULL,
  filename           TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  proxy_path         TEXT,
  thumb_dir          TEXT,
  waveform_path      TEXT,
  size_bytes         INTEGER,
  duration_ms        INTEGER,
  container          TEXT,
  codec_v            TEXT,
  codec_a            TEXT,
  width              INTEGER,
  height             INTEGER,
  fps                REAL,
  sample_rate        INTEGER,
  channels           INTEGER,
  device_make        TEXT,
  device_model       TEXT,
  device_serial      TEXT,
  lens               TEXT,
  source_created_at  DATETIME,
  ingested_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status             TEXT NOT NULL DEFAULT 'registered',
  embedding_status   TEXT NOT NULL DEFAULT 'pending',
  last_error         TEXT,
  UNIQUE(shoot_id, source_role, filename)
);

CREATE TABLE IF NOT EXISTS media_transcripts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id        INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  source          TEXT,
  language        TEXT,
  text            TEXT NOT NULL,
  segments_json   TEXT,
  cost_usd        REAL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id, source)
);

CREATE TABLE IF NOT EXISTS media_keyframe_captions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id       INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  frame_idx      INTEGER NOT NULL,
  frame_path     TEXT,
  timestamp_ms   INTEGER,
  caption        TEXT,
  tags_json      TEXT,
  cost_usd       REAL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id, frame_idx)
);

CREATE TABLE IF NOT EXISTS media_clip_synopses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id          INTEGER NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  synopsis          TEXT NOT NULL,
  searchable_text   TEXT NOT NULL,
  tags_json         TEXT,
  persona_fit_json  TEXT,
  cost_usd          REAL,
  generated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  embedding_status  TEXT NOT NULL DEFAULT 'pending',
  embedding_model   TEXT,
  embedded_at       DATETIME,
  embedding_error   TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_assets_shoot     ON media_assets(shoot_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_kind      ON media_assets(kind);
CREATE INDEX IF NOT EXISTS idx_media_assets_status    ON media_assets(status);
CREATE INDEX IF NOT EXISTS idx_media_assets_role      ON media_assets(source_role);
CREATE INDEX IF NOT EXISTS idx_clip_synopses_embed    ON media_clip_synopses(embedding_status);
CREATE INDEX IF NOT EXISTS idx_kf_captions_asset      ON media_keyframe_captions(asset_id);
