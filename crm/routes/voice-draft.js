'use strict';
//
// routes/voice-draft.js — POST /api/voice/draft
//
// Mounted at /api/voice in server.js.
//
// Localhost-only. Lazy Chroma reconnect via connectOnce when the boot-time
// handle is missing. Every successful draft writes one row to voice_drafts_log
// with outcome='pending'; downstream sent_as_is/sent_with_edits/discarded
// updates come from Slack approval (not implemented in R3).

const express = require('express');
const { sql } = require('@databases/sqlite');
const { connectOnce } = require('../lib/chroma-connect');
const { retrieveExemplars } = require('../lib/voice-retrieval');
const { generateDraft } = require('../lib/voice-draft');
const { embedQuery, EMBEDDING_MODEL } = require('../lib/openai-embed');
const { INTENT_SET, INTENT_VALUES } = require('../lib/voice-intents');

const CHROMA_URL = 'http://localhost:8000';

// Reserved intents — single source of truth in crm/lib/voice-intents.js.
// Re-exported here for backwards compat with tests / external imports.
const VALID_INTENTS = INTENT_SET;

const VALID_AGENTS = new Set(['regina', 'paulina', 'sol', 'adhoc', 'sarah-coach']);

function isLocal(req) {
  // app.set('trust proxy', 1) is set in server.js; req.ip respects it.
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function err(res, status, body) {
  return res.status(status).json(body);
}

// healthcheckFail mirrors the helper at server.js:376–395 (Resend webhook),
// but reads a different check key. Skips silently if the key is missing —
// the endpoint still works, but unmonitored.
function pingHealthcheckFail(reason) {
  try {
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const secretsDir = process.env.SOCIALSOL_SECRETS_DIR || path.join(repoRoot, 'secrets');
    const hcPath = path.join(secretsDir, 'healthchecks.json');
    const hc = JSON.parse(fs.readFileSync(hcPath, 'utf8'));
    const id = hc.checks && hc.checks['voice-draft-endpoint'];
    if (!hc.base_url || !id) return; // not configured yet → skip
    const url = `${hc.base_url}/${id}/fail`;
    execFileSync('curl', [
      '-fsS', '--max-time', '5', url,
      '--data', String(reason).slice(0, 200),
    ], { stdio: 'ignore' });
  } catch { /* non-fatal */ }
}

function getCollection(req) {
  return req.app.locals.chromaVoiceCorpus || null;
}

async function ensureCollection(req) {
  let collection = getCollection(req);
  if (collection) return collection;
  // Lazy reconnect: a single fresh attempt — same pattern as /api/chroma/status.
  const client = await connectOnce({ url: CHROMA_URL });
  collection = await client.getOrCreateCollection({ name: 'sarah_voice_corpus' });
  // Stash on app.locals so the next request reuses it.
  req.app.locals.chromaClient = client;
  req.app.locals.chromaVoiceCorpus = collection;
  return collection;
}

function attachRoutes(router, getDb) {
  router.post('/draft', express.json(), async (req, res) => {
    if (!isLocal(req)) {
      return err(res, 403, { error: 'localhost_only' });
    }

    const body = req.body || {};
    const intent = body.intent;
    const messageContext = body.message_context;
    const agentId = body.agent_id;
    const language = body.language || 'en';
    const recipientRelationship = body.recipient_relationship || null;
    const draftLength = body.draft_length || { min: 40, max: 160 };
    const contactId = body.contact_id != null ? Number(body.contact_id) : null;
    const excludeIds = Array.isArray(body.exclude_ids) ? body.exclude_ids.map(String) : [];
    const debug = String(req.query.debug || '') === '1';

    if (!intent) return err(res, 400, { error: 'missing_required_field', field: 'intent' });
    if (!messageContext) return err(res, 400, { error: 'missing_required_field', field: 'message_context' });
    if (!agentId) return err(res, 400, { error: 'missing_required_field', field: 'agent_id' });
    if (!VALID_INTENTS.has(intent)) {
      return err(res, 400, { error: 'invalid_value', field: 'intent', allowed: INTENT_VALUES });
    }
    if (!VALID_AGENTS.has(agentId)) {
      return err(res, 400, { error: 'invalid_value', field: 'agent_id', allowed: Array.from(VALID_AGENTS) });
    }
    if (language !== 'en') {
      return err(res, 400, { error: 'unsupported_language', detail: 'v1 only retrieves from EN corpus' });
    }

    // ── Chroma ────────────────────────────────────────────────────────
    let collection;
    try {
      collection = await ensureCollection(req);
    } catch (e) {
      pingHealthcheckFail(`chroma: ${e.message}`);
      return err(res, 503, { error: 'service_unavailable', service: 'chroma', retry_after: 30, detail: e.message });
    }

    // ── Retrieval ─────────────────────────────────────────────────────
    let retrieval;
    try {
      retrieval = await retrieveExemplars(collection, {
        queryText: messageContext,
        language,
        recipientRelationship,
        // intentTag intentionally omitted in v1 until tag-corpus-intents.js
        // populates intent_tags. Once populated, callers can opt in by
        // passing intent in the future; we'll wire it through here.
        intentTag: null,
        excludeIds,
      });
    } catch (e) {
      const isOpenAI = /openai|embed/i.test(e.message || '');
      const service = isOpenAI ? 'openai_embeddings' : 'chroma';
      pingHealthcheckFail(`${service}: ${e.message}`);
      return err(res, 503, { error: 'service_unavailable', service, retry_after: 30, detail: e.message });
    }

    // ── Generation ────────────────────────────────────────────────────
    let draft;
    try {
      draft = await generateDraft({
        intent,
        recipientRelationship,
        messageContext,
        draftLength,
        exemplars: retrieval.exemplars,
      });
    } catch (e) {
      pingHealthcheckFail(`anthropic: ${e.message}`);
      return err(res, 503, { error: 'service_unavailable', service: 'anthropic', retry_after: 30, detail: e.message });
    }

    // ── Log ───────────────────────────────────────────────────────────
    const exemplarIds = retrieval.exemplars.map((e) => e.id);
    let logId = null;
    try {
      const db = getDb();
      if (db) {
        await db.query(sql`
          INSERT INTO voice_drafts_log (intent, agent, contact_id, draft_text, retrieved_example_ids, cost_usd, outcome)
          VALUES (${intent}, ${agentId}, ${contactId}, ${draft.draftText}, ${JSON.stringify(exemplarIds)}, ${draft.costUsd}, 'pending')
        `);
        const [{ id }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
        logId = id || null;
      }
    } catch (e) {
      // Non-fatal: draft is already generated; just log the failure.
      console.warn('[voice-draft] log insert failed (non-fatal):', e.message);
    }

    const response = {
      draft_text: draft.draftText,
      retrieved_exemplar_ids: exemplarIds,
      voice_spec_version: draft.voiceSpecVersion,
      model_used: draft.modelUsed,
      embedding_model_used: EMBEDDING_MODEL,
      tokens: draft.tokens,
      cost_usd: draft.costUsd,
      voice_drafts_log_id: logId,
      stop_reason: draft.stopReason,
    };

    if (exemplarIds.length < 3) {
      response.warning = 'low_exemplar_count';
    }

    if (debug) {
      response.retrieved_exemplars = retrieval.exemplars.map((e) => ({
        id: e.id,
        distance: e.distance,
        snippet: (e.document || '').slice(0, 160),
        relationship: (e.metadata && e.metadata.recipient_relationship) || null,
        sent_at: (e.metadata && e.metadata.sent_at) || null,
      }));
    }

    return res.json(response);
  });

  return router;
}

function buildRouter(getDb) {
  const router = express.Router();
  attachRoutes(router, getDb);
  return router;
}

module.exports = { buildRouter, VALID_INTENTS, VALID_AGENTS };
