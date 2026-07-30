-- Migration 017 — IG-ready renditions for media assets.
--
-- This .sql is the canonical DDL reference. Idempotency lives in the
-- accompanying .sh wrapper (mirrors 011_vip_and_feedback_columns.sh).
--
-- Adds one column to media_assets:
--   renditions_json — JSON object keyed by aspect ("9x16", "1x1"), each
--                     value {path, width, height, rendered_at, from_proxy}.
--                     Written by media/scripts/render-vertical.js; served
--                     by GET /api/media/rendition/:id/:aspect. Renditions
--                     are rendered on demand per campaign pick, not in bulk.

ALTER TABLE media_assets ADD COLUMN renditions_json TEXT;
