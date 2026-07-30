'use strict';
//
// voice-service.js — client for POST /api/voice/draft.
//
// Promoted from regina/lib/voice-service.js in R7 so sarah-coach (and any
// future Voice Service caller) can share one client instead of reaching
// across agents. Mirrors the R5 promotion of slack-post.js.
//
// Contract (from crm/routes/voice-draft.js):
//   request:  { intent, message_context, agent_id, language?, recipient_relationship?, contact_id?, draft_length?, exclude_ids? }
//   response: { draft_text, retrieved_exemplar_ids, voice_spec_version, model_used, embedding_model_used, tokens, cost_usd, voice_drafts_log_id, stop_reason, warning? }
//   errors:   400 (validation), 403 (localhost_only), 503 (chroma|openai_embeddings|anthropic — { service, retry_after, detail })
//
// Concurrency: callBatch fans out N requests with a configurable in-flight cap.
// Per-call failure does NOT abort the batch — failures come back in the result
// array as { ok: false, error, status } so the caller can decide.

const DEFAULT_URL = 'http://127.0.0.1:3456/api/voice/draft';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_CONCURRENCY = 3;

class VoiceServiceError extends Error {
  constructor(message, { status = null, service = null, detail = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'VoiceServiceError';
    this.status = status;
    this.service = service;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

async function callOne(payload, opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(t);
    // network-level (ECONNREFUSED, ENOTFOUND, abort)
    throw new VoiceServiceError(`network_error: ${e.message}`, { status: null, service: 'network' });
  }
  clearTimeout(t);

  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new VoiceServiceError(`bad_response_body: ${e.message}`, { status: res.status });
  }

  if (!res.ok) {
    if (res.status === 503) {
      throw new VoiceServiceError(
        `service_unavailable: ${body.service || 'unknown'} — ${body.detail || ''}`,
        {
          status: 503,
          service: body.service || null,
          detail: body.detail || null,
          retryAfter: body.retry_after || 30,
        }
      );
    }
    // Defensive: body.error may be a string (route's err()) or an object
    // (upstream proxy / unexpected handler). Stringify safely.
    const errLabel =
      typeof body.error === 'string'
        ? body.error
        : body.error
          ? JSON.stringify(body.error)
          : `http_${res.status}`;
    const detailLabel = body.detail || body.field || JSON.stringify(body).slice(0, 200);
    throw new VoiceServiceError(`${errLabel}: ${detailLabel}`, {
      status: res.status,
      detail: body.detail || null,
    });
  }
  return body;
}

/**
 * Run callOne for each payload with concurrency cap. Per-payload failures are
 * returned as { ok: false, error: VoiceServiceError } in the result array
 * (same index as input). Successes are { ok: true, result: <response> }.
 *
 * If the FIRST attempted call hits a service-unavailable error AND no other
 * call has succeeded yet, the caller may treat that as "abort the whole batch."
 * This function does not encode that policy — it just returns per-call results.
 *
 * @param {Array<object>} payloads
 * @param {object} [opts]
 * @returns {Promise<Array<{ok: boolean, result?: object, error?: VoiceServiceError, payload: object}>>}
 */
async function callBatch(payloads, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
  const results = new Array(payloads.length);

  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= payloads.length) return;
      try {
        const result = await callOne(payloads[i], opts);
        results[i] = { ok: true, result, payload: payloads[i] };
      } catch (err) {
        results[i] = { ok: false, error: err, payload: payloads[i] };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, payloads.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = {
  callOne,
  callBatch,
  VoiceServiceError,
  DEFAULT_URL,
  DEFAULT_CONCURRENCY,
};
