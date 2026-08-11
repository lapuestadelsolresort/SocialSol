'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');

const EFFECT_STATES = Object.freeze([
  'requested',
  'accepted_by_provider',
  'queued',
  'sent',
  'delivered',
  'read',
  'verified_by_readback',
  'failed',
]);

const EFFECT_RANK = new Map(EFFECT_STATES.map((state, index) => [state, index]));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value === undefined ? null : value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

function cleanError(error) {
  const message = String(error?.message || error || 'unknown error').slice(0, 1000);
  const code = String(error?.code || error?.name || 'workflow_error').slice(0, 120);
  return { code, message };
}

async function recordEvent(db, { runId, stepKey = null, type, payload = null }) {
  const payloadJson = payload === null ? null : stableJson(payload);
  await db.query(sql`INSERT INTO workflow_events
    (run_id, step_key, event_type, payload_json, payload_hash)
    VALUES (${runId}, ${stepKey}, ${type}, ${payloadJson}, ${payloadJson ? sha256(payloadJson) : null})`);
}

async function createRun(db, {
  definition,
  idempotencyKey,
  triggerType,
  triggerRef = null,
  channelId = null,
  actorUserId = null,
  input = {},
}) {
  if (!definition?.name || !Number.isInteger(definition.version) || !Array.isArray(definition.steps)) {
    throw new Error('invalid workflow definition');
  }
  if (!idempotencyKey) throw new Error('workflow idempotency key is required');

  const [existing] = await db.query(sql`SELECT id FROM workflow_runs WHERE idempotency_key = ${idempotencyKey}`);
  if (existing) return { created: false, run: await getRun(db, existing.id) };

  const runId = crypto.randomUUID();
  const inputJson = stableJson(input);
  const startedAt = nowIso();
  try {
    await db.tx(async tx => {
      await tx.query(sql`INSERT INTO workflow_runs (
          id, workflow_name, workflow_version, idempotency_key, status,
          trigger_type, trigger_ref, channel_id, actor_user_id, input_json,
          started_at, updated_at
        ) VALUES (
          ${runId}, ${definition.name}, ${definition.version}, ${idempotencyKey}, 'running',
          ${triggerType}, ${triggerRef}, ${channelId}, ${actorUserId}, ${inputJson},
          ${startedAt}, ${startedAt}
        )`);
      for (let ordinal = 0; ordinal < definition.steps.length; ordinal += 1) {
        const step = definition.steps[ordinal];
        await tx.query(sql`INSERT INTO workflow_steps
          (run_id, step_key, ordinal, status, max_attempts)
          VALUES (${runId}, ${step.key}, ${ordinal}, 'pending', ${step.maxAttempts || 3})`);
      }
      await tx.query(sql`INSERT INTO workflow_events
        (run_id, event_type, payload_json, payload_hash)
        VALUES (${runId}, 'run_created', ${inputJson}, ${sha256(inputJson)})`);
    });
  } catch (error) {
    const [raced] = await db.query(sql`SELECT id FROM workflow_runs WHERE idempotency_key = ${idempotencyKey}`);
    if (raced) return { created: false, run: await getRun(db, raced.id) };
    throw error;
  }
  return { created: true, run: await getRun(db, runId) };
}

async function getRun(db, runId) {
  const [row] = await db.query(sql`SELECT * FROM workflow_runs WHERE id = ${runId}`);
  if (!row) return null;
  const steps = await db.query(sql`SELECT * FROM workflow_steps WHERE run_id = ${runId} ORDER BY ordinal`);
  const effects = await db.query(sql`SELECT * FROM workflow_effects WHERE run_id = ${runId} ORDER BY requested_at, id`);
  return {
    ...row,
    input: parseJson(row.input_json, {}),
    state: parseJson(row.state_json, {}),
    output: parseJson(row.output_json, null),
    steps: steps.map(step => ({
      ...step,
      input: parseJson(step.input_json, null),
      output: parseJson(step.output_json, null),
    })),
    effects: effects.map(effect => ({
      ...effect,
      request: parseJson(effect.request_json, null),
      response: parseJson(effect.response_json, null),
      target: parseJson(effect.target_json, null),
    })),
  };
}

async function beginStep(db, runId, stepKey, input, leaseOwner, leaseMs = 5 * 60_000) {
  const now = nowIso();
  const owner = leaseOwner || crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  await db.query(sql`UPDATE workflow_steps
    SET status='running', attempts=attempts+1, input_json=${stableJson(input)},
        started_at=COALESCE(started_at, ${now}), updated_at=${now},
        lease_owner=${owner}, lease_expires_at=${leaseExpiresAt},
        error_code=NULL, error_message=NULL
    WHERE run_id=${runId} AND step_key=${stepKey}
      AND status IN ('pending','retry') AND available_at <= ${now}`);
  const [claimed] = await db.query(sql`SELECT id FROM workflow_steps
    WHERE run_id=${runId} AND step_key=${stepKey} AND status='running' AND lease_owner=${owner}`);
  if (!claimed) return null;
  await db.query(sql`UPDATE workflow_runs
    SET status='running', current_step=${stepKey}, updated_at=${now},
        error_code=NULL, error_message=NULL
    WHERE id=${runId}`);
  await recordEvent(db, { runId, stepKey, type: 'step_started', payload: input });
  return { leaseOwner: owner, leaseExpiresAt };
}

async function completeStep(db, runId, stepKey, output, nextState) {
  const now = nowIso();
  const outputJson = stableJson(output);
  await db.tx(async tx => {
    await tx.query(sql`UPDATE workflow_steps
      SET status='completed', output_json=${outputJson}, completed_at=${now}, updated_at=${now},
          lease_owner=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND step_key=${stepKey}`);
    await tx.query(sql`UPDATE workflow_runs
      SET state_json=${stableJson(nextState)}, updated_at=${now}
      WHERE id=${runId}`);
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, step_key, event_type, payload_json, payload_hash)
      VALUES (${runId}, ${stepKey}, 'step_completed', ${outputJson}, ${sha256(outputJson)})`);
  });
}

async function failStep(db, runId, stepKey, error, { retry = false, retryAt = null } = {}) {
  const now = nowIso();
  const cleaned = cleanError(error);
  const nextStatus = retry ? 'retry' : 'failed';
  await db.tx(async tx => {
    await tx.query(sql`UPDATE workflow_steps
      SET status=${nextStatus}, available_at=${retryAt || now}, error_code=${cleaned.code},
          error_message=${cleaned.message}, updated_at=${now},
          completed_at=${retry ? null : now}, lease_owner=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND step_key=${stepKey}`);
    await tx.query(sql`UPDATE workflow_runs
      SET status=${retry ? 'retry' : 'failed'}, error_code=${cleaned.code},
          error_message=${cleaned.message}, updated_at=${now},
          completed_at=${retry ? null : now}
      WHERE id=${runId}`);
    const payload = stableJson({ ...cleaned, retry, retryAt });
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, step_key, event_type, payload_json, payload_hash)
      VALUES (${runId}, ${stepKey}, ${retry ? 'step_retry_scheduled' : 'step_failed'},
              ${payload}, ${sha256(payload)})`);
  });
}

async function completeRun(db, runId, output) {
  const now = nowIso();
  const outputJson = stableJson(output);
  await db.tx(async tx => {
    await tx.query(sql`UPDATE workflow_runs
      SET status='completed', output_json=${outputJson}, current_step=NULL,
          completed_at=${now}, updated_at=${now}
      WHERE id=${runId}`);
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, event_type, payload_json, payload_hash)
      VALUES (${runId}, 'run_completed', ${outputJson}, ${sha256(outputJson)})`);
  });
}

async function createEffect(db, {
  runId,
  stepKey = null,
  effectType,
  provider,
  operation,
  idempotencyKey,
  request,
  target = null,
}) {
  const requestJson = stableJson(request);
  const requestHash = sha256(requestJson);
  const [existing] = await db.query(sql`SELECT * FROM workflow_effects WHERE idempotency_key=${idempotencyKey}`);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      const error = new Error('effect idempotency key was reused with a different request');
      error.code = 'idempotency_collision';
      throw error;
    }
    return existing;
  }
  const id = crypto.randomUUID();
  await db.query(sql`INSERT INTO workflow_effects (
      id, run_id, step_key, effect_type, provider, operation,
      idempotency_key, request_hash, request_json, target_json, status
    ) VALUES (
      ${id}, ${runId}, ${stepKey}, ${effectType}, ${provider}, ${operation},
      ${idempotencyKey}, ${requestHash}, ${requestJson}, ${target === null ? null : stableJson(target)}, 'requested'
    )`);
  await recordEvent(db, { runId, stepKey, type: 'effect_requested', payload: { effectId: id, provider, operation, requestHash } });
  const [created] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${id}`);
  return created;
}

function validateEffectState(state) {
  if (!EFFECT_RANK.has(state)) throw new Error(`invalid effect state: ${state}`);
}

async function transitionEffect(db, {
  effectId = null,
  provider = null,
  providerRef = null,
  status,
  providerStatus = null,
  response = null,
  errorCode = null,
  errorMessage = null,
}) {
  validateEffectState(status);
  const rows = effectId
    ? await db.query(sql`SELECT * FROM workflow_effects WHERE id=${effectId}`)
    : await db.query(sql`SELECT * FROM workflow_effects WHERE provider=${provider} AND provider_ref=${providerRef}`);
  const current = rows[0];
  if (!current) return { found: false, changed: false, effect: null };

  // Failed is a terminal exception. Otherwise ignore out-of-order callbacks so
  // a late "sent" event can never erase a durable "delivered" or "read" fact.
  const shouldChange = status === 'failed'
    ? !['delivered', 'read', 'verified_by_readback'].includes(current.status)
    : current.status !== 'failed' && EFFECT_RANK.get(status) >= EFFECT_RANK.get(current.status);
  if (!shouldChange) return { found: true, changed: false, effect: current };

  const now = nowIso();
  const acceptedAt = ['accepted_by_provider', 'queued', 'sent', 'delivered', 'read', 'verified_by_readback'].includes(status) ? now : current.accepted_at;
  const sentAt = ['sent', 'delivered', 'read'].includes(status) ? now : current.sent_at;
  const deliveredAt = ['delivered', 'read'].includes(status) ? now : current.delivered_at;
  const readAt = status === 'read' ? now : current.read_at;
  const verifiedAt = status === 'verified_by_readback' ? now : current.verified_at;
  const failedAt = status === 'failed' ? now : current.failed_at;
  const nextProviderRef = providerRef || current.provider_ref;
  const responseJson = response === null ? current.response_json : stableJson(response);

  await db.query(sql`UPDATE workflow_effects SET
    status=${status}, provider_status=${providerStatus || current.provider_status},
    provider_ref=${nextProviderRef}, response_json=${responseJson},
    error_code=${errorCode}, error_message=${errorMessage ? String(errorMessage).slice(0, 1000) : null},
    accepted_at=${acceptedAt}, sent_at=${sentAt}, delivered_at=${deliveredAt},
    read_at=${readAt}, verified_at=${verifiedAt}, failed_at=${failedAt}, updated_at=${now}
    WHERE id=${current.id}`);
  await recordEvent(db, {
    runId: current.run_id,
    stepKey: current.step_key,
    type: 'effect_status_changed',
    payload: { effectId: current.id, from: current.status, to: status, providerStatus, providerRef: nextProviderRef },
  });
  const [effect] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${current.id}`);
  return { found: true, changed: true, effect };
}

async function enqueueOutbox(db, {
  runId = null,
  topic,
  idempotencyKey,
  payload,
  maxAttempts = 12,
  availableAt = nowIso(),
}) {
  const id = crypto.randomUUID();
  await db.query(sql`INSERT OR IGNORE INTO workflow_outbox
    (id, run_id, topic, idempotency_key, payload_json, max_attempts, available_at)
    VALUES (${id}, ${runId}, ${topic}, ${idempotencyKey}, ${stableJson(payload)}, ${maxAttempts}, ${availableAt})`);
  const [row] = await db.query(sql`SELECT * FROM workflow_outbox WHERE idempotency_key=${idempotencyKey}`);
  return row;
}

async function createEvidence(db, {
  runId = null,
  stepKey = null,
  source,
  sourceRef = null,
  observedAt = nowIso(),
  expiresAt = null,
  confidence = 1,
  payload,
}) {
  if (!source) throw new Error('evidence source is required');
  const payloadJson = stableJson(payload);
  const id = crypto.randomUUID();
  await db.query(sql`INSERT INTO workflow_evidence (
      id, run_id, step_key, source, source_ref, observed_at, expires_at,
      confidence, payload_json, payload_hash
    ) VALUES (
      ${id}, ${runId}, ${stepKey}, ${source}, ${sourceRef}, ${observedAt}, ${expiresAt},
      ${confidence}, ${payloadJson}, ${sha256(payloadJson)}
    )`);
  return { id, source, sourceRef, observedAt, expiresAt, confidence, payloadHash: sha256(payloadJson) };
}

module.exports = {
  EFFECT_STATES,
  beginStep,
  cleanError,
  completeRun,
  completeStep,
  createEffect,
  createEvidence,
  createRun,
  enqueueOutbox,
  failStep,
  getRun,
  nowIso,
  parseJson,
  recordEvent,
  sha256,
  stableJson,
  transitionEffect,
};
