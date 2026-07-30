-- Migration 008: Phase R — embedding provenance on sarah_voice_corpus
--
-- Apply with the wrapper script (idempotent):
--   bash crm/migrations/008_voice_corpus_embedding_model.sh
--
-- R2 indexes sarah_voice_corpus into Chroma. We need three things on the row
-- after each successful (or failed) embedding pass:
--
--   embedding_model  — which model produced the vector ("text-embedding-3-small" for v1)
--   embedded_at      — when the embedding was written (ISO8601, UTC)
--   embedding_error  — last error message if embedding_status='failed' (NULL otherwise)
--
-- These let us:
--   - swap models cleanly: UPDATE … SET embedding_status='pending', embedding_model=NULL …
--   - retry only failures: WHERE embedding_status='failed' AND embedding_error IS NOT NULL
--   - audit per-model retrieval quality without re-deriving from logs
--
-- All three are nullable so existing rows pre-R2 do not need backfill.

ALTER TABLE sarah_voice_corpus ADD COLUMN embedding_model TEXT;
ALTER TABLE sarah_voice_corpus ADD COLUMN embedded_at TEXT;
ALTER TABLE sarah_voice_corpus ADD COLUMN embedding_error TEXT;

CREATE INDEX idx_voice_corpus_embedding_model ON sarah_voice_corpus(embedding_model);

-- Verification
SELECT 'sarah_voice_corpus new columns:' AS info;
SELECT name FROM pragma_table_info('sarah_voice_corpus')
  WHERE name IN ('embedding_model','embedded_at','embedding_error');
