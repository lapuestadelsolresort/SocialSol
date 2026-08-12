'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');

const EFFECT_STATES = Object.freeze([
  'requested',
  'manual_review',
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
  policySnapshot = null,
}) {
  if (!definition?.name || !Number.isInteger(definition.version) || !Array.isArray(definition.steps)) {
    throw new Error('invalid workflow definition');
  }
  if (!idempotencyKey) throw new Error('workflow idempotency key is required');

  const inputJson = stableJson(input);
  const inputHash = sha256(inputJson);
  const policySnapshotJson = policySnapshot === null ? null : stableJson(policySnapshot);
  const policySnapshotHash = policySnapshotJson === null ? null : sha256(policySnapshotJson);
  const serializationKey = definition.serializeMutations === true ? definition.name : null;

  async function existingRun(row) {
    const run = await getRun(db, row.id);
    const existingHash = run.input_hash || sha256(run.input_json);
    if (
      run.workflow_name !== definition.name
      || Number(run.workflow_version) !== definition.version
      || existingHash !== inputHash
    ) {
      const error = new Error('workflow idempotency key was reused with a different request');
      error.code = 'idempotency_collision';
      throw error;
    }
    return { created: false, run };
  }

  const [existing] = await db.query(sql`SELECT id FROM workflow_runs WHERE idempotency_key = ${idempotencyKey}`);
  if (existing) return existingRun(existing);

  if (definition.mutates !== false) {
    const [openReview] = await db.query(sql`SELECT mr.id FROM workflow_manual_reviews mr
      JOIN workflow_runs r ON r.id=mr.run_id
      WHERE mr.status='open' AND r.workflow_name=${definition.name}
      ORDER BY mr.created_at LIMIT 1`);
    if (openReview) {
      const error = new Error(`workflow is paused by unresolved manual review ${openReview.id}`);
      error.code = 'workflow_manual_review_open';
      error.status = 409;
      throw error;
    }
    if (definition.serializeMutations === true) {
      const [active] = await db.query(sql`SELECT id FROM workflow_runs
        WHERE workflow_name=${definition.name} AND status IN ('queued','running','retry')
        ORDER BY created_at LIMIT 1`);
      if (active) {
        const error = new Error(`workflow already has an active mutation ${active.id}`);
        error.code = 'workflow_mutation_in_progress';
        error.status = 409;
        throw error;
      }
    }
  }

  const runId = crypto.randomUUID();
  const createdAt = nowIso();
  try {
    await db.tx(async tx => {
      await tx.query(sql`INSERT INTO workflow_runs (
          id, workflow_name, workflow_version, idempotency_key, status,
          trigger_type, trigger_ref, channel_id, actor_user_id, input_json, input_hash,
          policy_snapshot_json, policy_snapshot_hash, serialization_key, updated_at
        ) VALUES (
          ${runId}, ${definition.name}, ${definition.version}, ${idempotencyKey}, 'queued',
          ${triggerType}, ${triggerRef}, ${channelId}, ${actorUserId}, ${inputJson}, ${inputHash},
          ${policySnapshotJson}, ${policySnapshotHash}, ${serializationKey}, ${createdAt}
        )`);
      for (let ordinal = 0; ordinal < definition.steps.length; ordinal += 1) {
        const step = definition.steps[ordinal];
        await tx.query(sql`INSERT INTO workflow_steps
          (run_id, step_key, ordinal, status, max_attempts)
          VALUES (${runId}, ${step.key}, ${ordinal}, 'pending', ${step.maxAttempts || 3})`);
      }
      await tx.query(sql`INSERT INTO workflow_events
        (run_id, event_type, payload_json, payload_hash)
        VALUES (${runId}, 'run_created',
          ${stableJson({ inputHash, policySnapshotHash, triggerType })},
          ${sha256(stableJson({ inputHash, policySnapshotHash, triggerType }))})`);
    });
  } catch (error) {
    const [raced] = await db.query(sql`SELECT id FROM workflow_runs WHERE idempotency_key = ${idempotencyKey}`);
    if (raced) return existingRun(raced);
    if (serializationKey) {
      const [active] = await db.query(sql`SELECT id FROM workflow_runs WHERE serialization_key=${serializationKey}`);
      if (active) {
        const conflict = new Error(`workflow already has an active mutation ${active.id}`);
        conflict.code = 'workflow_mutation_in_progress';
        conflict.status = 409;
        throw conflict;
      }
    }
    throw error;
  }
  return { created: true, run: await getRun(db, runId) };
}

async function getRun(db, runId) {
  const [row] = await db.query(sql`SELECT * FROM workflow_runs WHERE id = ${runId}`);
  if (!row) return null;
  const steps = await db.query(sql`SELECT * FROM workflow_steps WHERE run_id = ${runId} ORDER BY ordinal`);
  const effects = await db.query(sql`SELECT * FROM workflow_effects WHERE run_id = ${runId} ORDER BY requested_at, id`);
  const manualReviews = await db.query(sql`SELECT * FROM workflow_manual_reviews WHERE run_id = ${runId} ORDER BY created_at, id`);
  return {
    ...row,
    input: parseJson(row.input_json, {}),
    state: parseJson(row.state_json, {}),
    output: parseJson(row.output_json, null),
    policySnapshot: parseJson(row.policy_snapshot_json, null),
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
    manualReviews,
  };
}

async function beginStep(db, runId, stepKey, input, leaseOwner, leaseMs = 5 * 60_000) {
  const now = nowIso();
  const owner = leaseOwner || crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  await db.query(sql`UPDATE workflow_steps
    SET status='running', attempts=attempts+1, input_json=${stableJson(input)},
        started_at=COALESCE(started_at, ${now}), updated_at=${now},
        lease_owner=${owner}, lease_token=${leaseToken}, lease_version=lease_version+1,
        lease_expires_at=${leaseExpiresAt},
        error_code=NULL, error_message=NULL
    WHERE run_id=${runId} AND step_key=${stepKey}
      AND status IN ('pending','retry') AND available_at <= ${now}`);
  const [claimed] = await db.query(sql`SELECT id, lease_version FROM workflow_steps
    WHERE run_id=${runId} AND step_key=${stepKey} AND status='running'
      AND lease_owner=${owner} AND lease_token=${leaseToken}`);
  if (!claimed) return null;
  await db.query(sql`UPDATE workflow_runs
    SET status='running', current_step=${stepKey}, started_at=COALESCE(started_at, ${now}), updated_at=${now},
        error_code=NULL, error_message=NULL
    WHERE id=${runId}`);
  await recordEvent(db, { runId, stepKey, type: 'step_started', payload: input });
  return { leaseOwner: owner, leaseToken, leaseVersion: claimed.lease_version, leaseExpiresAt };
}

function leaseLostError(stepKey) {
  const error = new Error(`workflow step lease was lost before ${stepKey} could commit`);
  error.code = 'workflow_lease_lost';
  error.retryable = false;
  return error;
}

async function renewStepLease(db, runId, stepKey, leaseToken, leaseMs = 5 * 60_000) {
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  await db.query(sql`UPDATE workflow_steps SET lease_expires_at=${leaseExpiresAt}, updated_at=${now}
    WHERE run_id=${runId} AND step_key=${stepKey} AND status='running' AND lease_token=${leaseToken}`);
  const [renewed] = await db.query(sql`SELECT lease_expires_at FROM workflow_steps
    WHERE run_id=${runId} AND step_key=${stepKey} AND status='running' AND lease_token=${leaseToken}`);
  if (!renewed) throw leaseLostError(stepKey);
  await db.query(sql`UPDATE workflow_runs SET updated_at=${now} WHERE id=${runId}`);
  return { leaseExpiresAt: renewed.lease_expires_at };
}

async function completeStep(db, runId, stepKey, output, nextState, { leaseToken } = {}) {
  const now = nowIso();
  const outputJson = stableJson(output);
  await db.tx(async tx => {
    const [current] = await tx.query(sql`SELECT status, lease_token FROM workflow_steps
      WHERE run_id=${runId} AND step_key=${stepKey}`);
    if (!current || current.status !== 'running' || !leaseToken || current.lease_token !== leaseToken) {
      throw leaseLostError(stepKey);
    }
    await tx.query(sql`UPDATE workflow_steps
      SET status='completed', output_json=${outputJson}, completed_at=${now}, updated_at=${now},
          lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND step_key=${stepKey} AND status='running' AND lease_token=${leaseToken}`);
    await tx.query(sql`UPDATE workflow_runs
      SET state_json=${stableJson(nextState)}, updated_at=${now}
      WHERE id=${runId}`);
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, step_key, event_type, payload_json, payload_hash)
      VALUES (${runId}, ${stepKey}, 'step_completed', ${outputJson}, ${sha256(outputJson)})`);
  });
}

async function failStep(db, runId, stepKey, error, {
  retry = false,
  retryAt = null,
  leaseToken = null,
  leaseExpiredBefore = null,
} = {}) {
  const now = nowIso();
  const cleaned = cleanError(error);
  const nextStatus = retry ? 'retry' : 'failed';
  await db.tx(async tx => {
    const [current] = await tx.query(sql`SELECT status, lease_token, lease_expires_at FROM workflow_steps
      WHERE run_id=${runId} AND step_key=${stepKey}`);
    const expired = !leaseExpiredBefore
      || (current?.lease_expires_at && new Date(current.lease_expires_at).getTime() < new Date(leaseExpiredBefore).getTime());
    if (
      !current || current.status !== 'running' || !leaseToken
      || current.lease_token !== leaseToken || !expired
    ) {
      throw leaseLostError(stepKey);
    }
    await tx.query(sql`UPDATE workflow_steps
      SET status=${nextStatus}, available_at=${retryAt || now}, error_code=${cleaned.code},
          error_message=${cleaned.message}, updated_at=${now},
          completed_at=${retry ? null : now}, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND step_key=${stepKey} AND status='running' AND lease_token=${leaseToken}`);
    await tx.query(sql`UPDATE workflow_runs
      SET status=${retry ? 'retry' : 'failed'}, error_code=${cleaned.code},
          error_message=${cleaned.message}, updated_at=${now},
          completed_at=${retry ? null : now},
          serialization_key=CASE WHEN ${retry ? 1 : 0}=1 THEN serialization_key ELSE NULL END
      WHERE id=${runId}`);
    const payload = stableJson({ ...cleaned, retry, retryAt });
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, step_key, event_type, payload_json, payload_hash)
      VALUES (${runId}, ${stepKey}, ${retry ? 'step_retry_scheduled' : 'step_failed'},
              ${payload}, ${sha256(payload)})`);
  });
}

async function failExpiredStepForManualReview(db, {
  runId,
  stepKey,
  leaseToken,
  expiredBefore,
  reasonMessage,
  reviewChannelId = null,
}) {
  const now = nowIso();
  const error = new Error(reasonMessage || 'worker lease expired across a non-idempotent external-effect boundary');
  error.code = 'ambiguous_external_result';
  const cleaned = cleanError(error);
  return db.tx(async tx => {
    const claimed = await tx.query(sql`UPDATE workflow_steps
      SET status='failed', available_at=${now}, error_code=${cleaned.code},
          error_message=${cleaned.message}, updated_at=${now}, completed_at=${now},
          lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND step_key=${stepKey} AND status='running'
        AND lease_token=${leaseToken} AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ${expiredBefore}
      RETURNING id`);
    if (!claimed.length) throw leaseLostError(stepKey);
    await tx.query(sql`UPDATE workflow_runs
      SET status='failed', error_code=${cleaned.code}, error_message=${cleaned.message},
          updated_at=${now}, completed_at=${now}, serialization_key=NULL
      WHERE id=${runId}`);
    const payload = stableJson({ ...cleaned, retry: false, retryAt: null, leaseExpiredBefore: expiredBefore });
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, step_key, event_type, payload_json, payload_hash)
      VALUES (${runId}, ${stepKey}, 'step_failed', ${payload}, ${sha256(payload)})`);
    return createManualReviewOn(tx, {
      runId,
      stepKey,
      reviewChannelId,
      reasonCode: 'ambiguous_external_result',
      reasonMessage: cleaned.message,
    });
  });
}

async function retryExpiredStep(db, {
  runId,
  stepKey,
  leaseToken,
  expiredBefore,
}) {
  const now = nowIso();
  return db.tx(async tx => {
    const claimed = await tx.query(sql`UPDATE workflow_steps
      SET status='retry', available_at=${now}, lease_owner=NULL, lease_token=NULL,
          lease_expires_at=NULL, error_code='worker_lease_expired',
          error_message='safe retry scheduled after worker lease expiration', updated_at=${now}
      WHERE run_id=${runId} AND step_key=${stepKey} AND status='running'
        AND lease_token=${leaseToken} AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ${expiredBefore}
      RETURNING id`);
    if (!claimed.length) return false;
    await tx.query(sql`UPDATE workflow_runs SET status='retry',
      error_code='worker_lease_expired', error_message='safe retry scheduled after worker lease expiration',
      updated_at=${now} WHERE id=${runId} AND status='running'`);
    await recordEvent(tx, {
      runId,
      stepKey,
      type: 'step_retry_scheduled',
      payload: { code: 'worker_lease_expired', retry: true, retryAt: now },
    });
    return true;
  });
}

async function failRun(db, runId, error) {
  const now = nowIso();
  const cleaned = cleanError(error);
  await db.tx(async tx => {
    await tx.query(sql`UPDATE workflow_steps
      SET status='failed', error_code=${cleaned.code}, error_message=${cleaned.message},
          updated_at=${now}, completed_at=${now}, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND status IN ('pending','retry')`);
    await tx.query(sql`UPDATE workflow_runs
      SET status='failed', error_code=${cleaned.code}, error_message=${cleaned.message},
          updated_at=${now}, completed_at=${now}, serialization_key=NULL
      WHERE id=${runId} AND status NOT IN ('completed','failed')`);
    await recordEvent(tx, { runId, type: 'run_failed', payload: cleaned });
  });
}

async function skipStep(db, runId, stepKey, output, nextState) {
  const now = nowIso();
  const outputJson = stableJson(output);
  await db.tx(async tx => {
    const [current] = await tx.query(sql`SELECT status FROM workflow_steps
      WHERE run_id=${runId} AND step_key=${stepKey}`);
    if (!current || !['pending', 'retry'].includes(current.status)) return;
    await tx.query(sql`UPDATE workflow_steps SET status='skipped', output_json=${outputJson},
      completed_at=${now}, updated_at=${now}, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE run_id=${runId} AND step_key=${stepKey} AND status IN ('pending','retry')`);
    await tx.query(sql`UPDATE workflow_runs SET state_json=${stableJson(nextState)}, updated_at=${now}
      WHERE id=${runId}`);
    await tx.query(sql`INSERT INTO workflow_events
      (run_id, step_key, event_type, payload_json, payload_hash)
      VALUES (${runId}, ${stepKey}, 'step_skipped', ${outputJson}, ${sha256(outputJson)})`);
  });
}

async function createManualReviewOn(connection, {
  runId,
  stepKey,
  effectId = null,
  reviewChannelId = null,
  reasonCode = 'ambiguous_external_result',
  reasonMessage,
}) {
  const [existingReview] = await connection.query(sql`SELECT * FROM workflow_manual_reviews
    WHERE run_id=${runId} AND step_key=${stepKey} AND reason_code=${reasonCode}`);
  if (existingReview) return existingReview;
  let resolvedEffectId = effectId;
  if (!resolvedEffectId) {
    const [effect] = await connection.query(sql`SELECT id FROM workflow_effects
      WHERE run_id=${runId} AND status NOT IN ('failed','verified_by_readback','delivered','read')
      ORDER BY requested_at DESC LIMIT 1`);
    resolvedEffectId = effect?.id || null;
  }
  const id = crypto.randomUUID();
  const message = String(reasonMessage || reasonCode).slice(0, 1000);
  await connection.query(sql`INSERT OR IGNORE INTO workflow_manual_reviews
    (id, run_id, step_key, effect_id, review_channel_id, reason_code, reason_message)
    VALUES (${id}, ${runId}, ${stepKey}, ${resolvedEffectId}, ${reviewChannelId}, ${reasonCode}, ${message})`);
  const [review] = await connection.query(sql`SELECT * FROM workflow_manual_reviews
    WHERE run_id=${runId} AND step_key=${stepKey} AND reason_code=${reasonCode}`);
  if (resolvedEffectId) {
    await transitionEffectOn(connection, {
      effectId: resolvedEffectId,
      status: 'manual_review',
      providerStatus: 'ambiguous_external_result',
      errorCode: reasonCode,
      errorMessage: message,
    });
  }
  await recordEvent(connection, {
    runId,
    stepKey,
    type: 'manual_review_required',
    payload: { reviewId: review.id, effectId: resolvedEffectId, reasonCode },
  });
  return review;
}

async function createManualReview(db, args) {
  if (typeof db.tx === 'function') {
    return db.tx(tx => createManualReviewOn(tx, args));
  }
  return createManualReviewOn(db, args);
}

function manualReviewConflict(review) {
  const error = new Error(`manual review was already resolved as ${review.resolution}`);
  error.code = 'manual_review_resolution_conflict';
  error.status = 409;
  error.review = review;
  return error;
}

async function resolveManualReview(db, {
  reviewId,
  resolution,
  resolvedBy,
  providerRef = null,
}) {
  if (!['confirmed_sent', 'confirmed_not_sent', 'abandoned'].includes(resolution)) {
    throw new Error('invalid manual-review resolution');
  }
  if (resolution === 'confirmed_sent' && !providerRef) {
    throw new Error('providerRef is required when confirming an external send');
  }
  const now = nowIso();
  return db.tx(async tx => {
    const claimed = await tx.query(sql`UPDATE workflow_manual_reviews
      SET status='resolved', resolution=${resolution}, resolution_provider_ref=${providerRef},
          resolved_by=${resolvedBy}, resolved_at=${now}, updated_at=${now}
      WHERE id=${reviewId} AND status='open'
      RETURNING *`);
    if (!claimed.length) {
      const [current] = await tx.query(sql`SELECT * FROM workflow_manual_reviews WHERE id=${reviewId}`);
      if (!current) throw new Error('manual review was not found');
      const sameResolution = current.resolution === resolution
        && (current.resolution_provider_ref || null) === (providerRef || null);
      if (sameResolution) return current;
      throw manualReviewConflict(current);
    }
    const review = claimed[0];
    const evidence = await createEvidence(tx, {
      runId: review.run_id,
      stepKey: review.step_key,
      source: 'human.provider_console_review',
      sourceRef: providerRef,
      payload: { reviewId, resolution, providerRef, resolvedBy },
    });
    if (review.effect_id && resolution === 'confirmed_sent') {
      await transitionEffectOn(tx, {
        effectId: review.effect_id,
        providerRef,
        status: 'sent',
        providerStatus: 'human_confirmed_sent',
        response: { manualReviewId: reviewId, evidenceId: evidence.id },
      });
    } else if (review.effect_id && resolution === 'confirmed_not_sent') {
      await transitionEffectOn(tx, {
        effectId: review.effect_id,
        status: 'failed',
        providerStatus: 'human_confirmed_not_sent',
        errorCode: 'confirmed_not_sent',
        errorMessage: 'human provider-console review confirmed that the mutation was not accepted',
        response: { manualReviewId: reviewId, evidenceId: evidence.id },
      });
    } else if (review.effect_id && resolution === 'abandoned') {
      await transitionEffectOn(tx, {
        effectId: review.effect_id,
        status: 'manual_review',
        providerStatus: 'human_abandoned_without_determination',
        response: { manualReviewId: reviewId, evidenceId: evidence.id },
      });
    }
    await recordEvent(tx, {
      runId: review.run_id,
      stepKey: review.step_key,
      type: 'manual_review_resolved',
      payload: { reviewId, resolution, providerRef, resolvedBy, evidenceId: evidence.id },
    });
    const [resolved] = await tx.query(sql`SELECT * FROM workflow_manual_reviews WHERE id=${reviewId}`);
    return resolved;
  });
}

async function completeRun(db, runId, output) {
  const now = nowIso();
  const outputJson = stableJson(output);
  await db.tx(async tx => {
    await tx.query(sql`UPDATE workflow_runs
      SET status='completed', output_json=${outputJson}, current_step=NULL,
          completed_at=${now}, updated_at=${now}, serialization_key=NULL
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
  verificationMode = 'readback_required',
  verificationDeadlineAt = null,
}) {
  if (!['readback_required', 'provider_acceptance', 'callback_optional'].includes(verificationMode)) {
    throw new Error(`invalid effect verification mode: ${verificationMode}`);
  }
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
      idempotency_key, request_hash, request_json, target_json, status,
      verification_mode, verification_deadline_at
    ) VALUES (
      ${id}, ${runId}, ${stepKey}, ${effectType}, ${provider}, ${operation},
      ${idempotencyKey}, ${requestHash}, ${requestJson}, ${target === null ? null : stableJson(target)}, 'requested',
      ${verificationMode}, ${verificationDeadlineAt}
    )`);
  await recordEvent(db, { runId, stepKey, type: 'effect_requested', payload: { effectId: id, provider, operation, requestHash } });
  const [created] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${id}`);
  return created;
}

function validateEffectState(state) {
  if (!EFFECT_RANK.has(state)) throw new Error(`invalid effect state: ${state}`);
}

async function transitionEffectOn(connection, {
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
    ? await connection.query(sql`SELECT * FROM workflow_effects WHERE id=${effectId}`)
    : await connection.query(sql`SELECT * FROM workflow_effects WHERE provider=${provider} AND provider_ref=${providerRef}`);
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
  const manualReviewAt = status === 'manual_review' ? now : current.manual_review_at;
  const nextProviderRef = providerRef || current.provider_ref;
  const responseJson = response === null ? current.response_json : stableJson(response);

  await connection.query(sql`UPDATE workflow_effects SET
    status=${status}, provider_status=${providerStatus || current.provider_status},
    provider_ref=${nextProviderRef}, response_json=${responseJson},
    error_code=${errorCode}, error_message=${errorMessage ? String(errorMessage).slice(0, 1000) : null},
    accepted_at=${acceptedAt}, sent_at=${sentAt}, delivered_at=${deliveredAt},
    read_at=${readAt}, verified_at=${verifiedAt}, failed_at=${failedAt},
    manual_review_at=${manualReviewAt}, updated_at=${now}
    WHERE id=${current.id}`);
  await recordEvent(connection, {
    runId: current.run_id,
    stepKey: current.step_key,
    type: 'effect_status_changed',
    payload: { effectId: current.id, from: current.status, to: status, providerStatus, providerRef: nextProviderRef },
  });
  const [effect] = await connection.query(sql`SELECT * FROM workflow_effects WHERE id=${current.id}`);
  return { found: true, changed: true, effect };
}

async function transitionEffect(db, args) {
  if (typeof db.tx === 'function') {
    return db.tx(tx => transitionEffectOn(tx, args));
  }
  return transitionEffectOn(db, args);
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
  createManualReview,
  createEffect,
  createEvidence,
  createRun,
  enqueueOutbox,
  failExpiredStepForManualReview,
  failRun,
  failStep,
  getRun,
  nowIso,
  parseJson,
  recordEvent,
  renewStepLease,
  retryExpiredStep,
  resolveManualReview,
  sha256,
  stableJson,
  skipStep,
  transitionEffect,
};
