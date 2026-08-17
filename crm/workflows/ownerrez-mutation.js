'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { loadPolicy } = require('../lib/channel-policy');
const { AUTO_CONFIRM_TRIGGER, dispatchAutoConfirm } = require('../lib/auto-confirm-dispatch');
const { requestOwnerRez } = require('../lib/ownerrez-api');
const { resolvePath, validateMutationInput } = require('../lib/ownerrez-mutation-catalog');

const PROPOSAL_TTL_MS = 15 * 60_000;

function ownerRezClient(services = {}) {
  return services.ownerRezRequest || requestOwnerRez;
}

function entityId(value) {
  const candidates = [value?.id, value?.booking_id, value?.guest_id, value?.quote_id,
    value?.discount_id, value?.field_definition_id, value?.field_id, value?.surcharge_id,
    value?.tag_definition_id, value?.tag_id, value?.webhook_subscription_id, value?.message_id];
  const found = candidates.find(candidate => candidate !== undefined && candidate !== null && candidate !== '');
  return found === undefined ? null : found;
}

function listItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function childId(value) {
  return value?.id ?? value?.address_id ?? value?.email_address_id ?? value?.phone_id ?? null;
}

function partialMatch(expected, actual) {
  if (expected === null || typeof expected !== 'object') return Object.is(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((value, index) => partialMatch(value, actual[index]));
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => partialMatch(value, actual[key]));
}

function snapshotPayload(response) {
  if (!response || response.ok === false) return null;
  return response.data ?? null;
}

async function preflightSnapshot(client, operation, request) {
  const mode = operation.readback?.mode;
  if (mode === 'same_entity' || mode === 'deleted_entity') {
    return client({ method: 'GET', requestPath: resolvePath(operation, request.pathParams), allowNotFound: true });
  }
  if (mode === 'guest_child_absent') {
    return client({ method: 'GET', requestPath: `/v2/guests/${encodeURIComponent(String(request.pathParams.id))}` });
  }
  if (mode === 'field_definition_absent') {
    return client({
      method: 'GET', requestPath: '/v2/fields',
      query: { entity_id: request.query.entity_id, entity_type: request.query.entity_type },
    });
  }
  if (mode === 'tag_name_absent') {
    return client({
      method: 'GET', requestPath: '/v2/tags',
      query: { entity_id: request.query.entity_id, entity_type: request.query.entity_type },
    });
  }
  return null;
}

function assertPrecondition(proposal, current) {
  const currentPayload = snapshotPayload(current);
  const currentHash = currentPayload === null ? null : require('../lib/workflow-store').sha256(currentPayload);
  if ((proposal.before_hash || null) !== currentHash || (proposal.before_etag && proposal.before_etag !== current?.etag)) {
    const error = new Error('OwnerRez record changed after the proposal; create a new proposal from current data');
    error.code = 'ownerrez_precondition_changed';
    throw error;
  }
}

async function verifyMutation(client, operation, request, providerResponse) {
  const mode = operation.readback?.mode;
  if (mode === 'response_collection') {
    if (!Array.isArray(providerResponse.data)) throw new Error('OwnerRez did not return the expected verified collection');
    return { mode, verified: true, data: providerResponse.data };
  }

  if (mode === 'created_entity') {
    const createdId = entityId(providerResponse.data);
    if (createdId === null) throw new Error('OwnerRez create response did not contain an entity id');
    const readback = await client({
      method: 'GET', requestPath: `/v2/${operation.readback.resource}/${encodeURIComponent(String(createdId))}`,
    });
    if (!readback.ok || entityId(readback.data) === null) throw new Error('OwnerRez create readback did not return the new entity');
    return { mode, verified: true, providerRef: createdId, data: readback.data, etag: readback.etag };
  }

  if (mode === 'same_entity') {
    const readback = await client({ method: 'GET', requestPath: resolvePath(operation, request.pathParams) });
    if (request.body && !Array.isArray(request.body) && !partialMatch(request.body, readback.data)) {
      const error = new Error('OwnerRez readback does not match the accepted patch fields');
      error.code = 'ownerrez_readback_mismatch';
      throw error;
    }
    if (Array.isArray(request.body) && providerResponse.data && !partialMatch(providerResponse.data, readback.data)) {
      const error = new Error('OwnerRez readback does not match the provider patch response');
      error.code = 'ownerrez_readback_mismatch';
      throw error;
    }
    return { mode, verified: true, providerRef: request.pathParams.id, data: readback.data, etag: readback.etag };
  }

  if (mode === 'deleted_entity') {
    const readback = await client({
      method: 'GET', requestPath: resolvePath(operation, request.pathParams), allowNotFound: true,
    });
    if (readback.status !== 404) throw new Error('OwnerRez delete readback still found the entity');
    return { mode, verified: true, providerRef: request.pathParams.id, data: { absent: true } };
  }

  if (mode === 'guest_child_absent') {
    const readback = await client({ method: 'GET', requestPath: `/v2/guests/${request.pathParams.id}` });
    const expectedId = String(request.pathParams[operation.readback.childParam]);
    const children = Array.isArray(readback.data?.[operation.readback.collection])
      ? readback.data[operation.readback.collection] : [];
    if (children.some(item => String(childId(item)) === expectedId)) {
      throw new Error('OwnerRez delete readback still found the guest child record');
    }
    return { mode, verified: true, providerRef: expectedId, data: { absent: true } };
  }

  if (mode === 'field_definition_absent') {
    const readback = await client({
      method: 'GET', requestPath: '/v2/fields',
      query: { entity_id: request.query.entity_id, entity_type: request.query.entity_type },
    });
    const expectedId = String(request.query.field_definition_id);
    if (listItems(readback.data).some(item => String(item.field_definition_id) === expectedId)) {
      throw new Error('OwnerRez readback still found the field definition assignment');
    }
    return { mode, verified: true, providerRef: expectedId, data: { absent: true } };
  }

  if (mode === 'tag_name_absent') {
    const readback = await client({
      method: 'GET', requestPath: '/v2/tags',
      query: { entity_id: request.query.entity_id, entity_type: request.query.entity_type },
    });
    const expectedName = String(request.query.name).toLowerCase();
    if (listItems(readback.data).some(item => String(item.name || item.tag_name || '').toLowerCase() === expectedName)) {
      throw new Error('OwnerRez readback still found the named tag assignment');
    }
    return { mode, verified: true, providerRef: request.query.name, data: { absent: true } };
  }

  throw new Error(`unsupported OwnerRez readback mode: ${mode || '<none>'}`);
}

function proposalRequest(row) {
  return {
    pathParams: JSON.parse(row.path_params_json || '{}'),
    query: JSON.parse(row.query_json || '{}'),
    body: row.body_json === null ? undefined : JSON.parse(row.body_json),
    reason: row.reason,
  };
}

function notificationTargets(policy) {
  const channelId = Object.entries(policy.channels || {})
    .find(([, channel]) => channel.name === 'reservations')?.[0] || null;
  const mentions = (policy.write_notifications?.user_ids || []).map(id => `<@${id}>`).join(' ');
  return { channelId, mentions };
}

const proposeDefinition = {
  name: 'ownerrez.mutation.propose',
  version: 2,
  capability: 'ownerrez.write',
  // The proposal writes only to the local durable ledger. It cannot change
  // OwnerRez. When `ownerrez.mutation.confirm` is policy-armed for autonomy,
  // the final step hands the proposal to the confirm graph, which owns every
  // external effect.
  mutates: false,
  validate: validateMutationInput,
  steps: [
    {
      key: 'preflight', maxAttempts: 1,
      async run({ input, services }) {
        const validated = validateMutationInput(input);
        const request = {
          pathParams: validated.pathParams, query: validated.query,
          body: validated.body, reason: validated.reason,
        };
        const before = await preflightSnapshot(ownerRezClient(services), validated.operation, request);
        if (before?.status === 404) {
          throw new Error('OwnerRez proposal target does not exist');
        }
        return {
          operationId: validated.operation.operationId,
          method: validated.operation.method,
          requestPath: resolvePath(validated.operation, validated.pathParams),
          request,
          before: snapshotPayload(before),
          beforeEtag: before?.etag || null,
        };
      },
    },
    {
      key: 'persist_proposal', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        const value = state.preflight;
        const requestHash = store.sha256({
          operationId: value.operationId,
          pathParams: value.request.pathParams,
          query: value.request.query,
          body: value.request.body ?? null,
          reason: value.request.reason,
        });
        const proposalId = crypto.randomUUID();
        const acceptanceHash = store.sha256(`${proposalId}:${requestHash}`).slice(0, 12);
        const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
        const beforeHash = value.before === null ? null : store.sha256(value.before);
        await db.query(sql`INSERT INTO ownerrez_mutation_proposals (
          id, operation_id, method, request_path, path_params_json, query_json,
          body_json, reason, request_hash, acceptance_hash, before_json,
          before_hash, before_etag, proposed_by, proposal_run_id, expires_at
        ) VALUES (
          ${proposalId}, ${value.operationId}, ${value.method}, ${value.requestPath},
          ${store.stableJson(value.request.pathParams)}, ${store.stableJson(value.request.query)},
          ${value.request.body === undefined ? null : store.stableJson(value.request.body)},
          ${value.request.reason}, ${requestHash}, ${acceptanceHash},
          ${value.before === null ? null : store.stableJson(value.before)}, ${beforeHash},
          ${value.beforeEtag}, ${run.actor_user_id}, ${run.id}, ${expiresAt}
        )`);
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'ownerrez.preflight', sourceRef: proposalId,
          expiresAt, payload: { operationId: value.operationId, requestHash, beforeHash, beforeEtag: value.beforeEtag },
        });
        return {
          proposalId, acceptanceHash, expiresAt, requestHash,
          confirmationCommand: `!ownerrez confirm ${proposalId} ${acceptanceHash}`,
          evidenceId: evidence.id,
        };
      },
    },
    {
      key: 'dispatch_confirmation', effectClass: 'local_write', maxAttempts: 3,
      async run({ db, run, state, services, store, stepKey }) {
        return dispatchAutoConfirm({
          db,
          run,
          services,
          store,
          stepKey,
          confirmDefinition,
          proposalId: state.persist_proposal.proposalId,
          acceptanceHash: state.persist_proposal.acceptanceHash,
          idempotencyKey: `auto-confirm:ownerrez:${state.persist_proposal.proposalId}`,
        });
      },
    },
  ],
  output({ state }) {
    const base = {
      operationId: state.preflight.operationId,
      method: state.preflight.method,
      requestPath: state.preflight.requestPath,
      proposalId: state.persist_proposal.proposalId,
      requestHash: state.persist_proposal.requestHash,
      evidenceId: state.persist_proposal.evidenceId,
    };
    const dispatch = state.dispatch_confirmation || { dispatched: false };
    if (!dispatch.dispatched) {
      return {
        ...base,
        status: 'awaiting_explicit_confirmation',
        expiresAt: state.persist_proposal.expiresAt,
        confirmationCommand: state.persist_proposal.confirmationCommand,
        ...(dispatch.reason ? { autoConfirm: { dispatched: false, reason: dispatch.reason } } : {}),
      };
    }
    return {
      ...base,
      status: dispatch.confirmStatus === 'completed' ? 'auto_confirmed_executed'
        : dispatch.confirmStatus === 'failed' ? 'auto_confirm_failed'
          : 'auto_confirm_in_progress',
      autoConfirm: {
        dispatched: true,
        confirmRunId: dispatch.confirmRunId,
        confirmStatus: dispatch.confirmStatus,
        effectId: dispatch.confirmOutput?.effectId || null,
        evidenceId: dispatch.confirmOutput?.evidenceId || null,
        providerRef: dispatch.confirmOutput?.providerRef ?? null,
        error: dispatch.confirmError,
      },
    };
  },
};

function validateConfirmation(input) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input?.proposalId || ''))) {
    throw new Error('valid OwnerRez proposalId is required');
  }
  if (!/^[0-9a-f]{8,12}$/i.test(String(input?.acceptanceHash || ''))) {
    throw new Error('valid OwnerRez acceptanceHash is required');
  }
}

const confirmDefinition = {
  name: 'ownerrez.mutation.confirm',
  version: 2,
  capability: 'ownerrez.write',
  mutates: true,
  allowedTriggers: ['slack_ownerrez_command', AUTO_CONFIRM_TRIGGER],
  // OwnerRez does not document mutation idempotency keys. A crash after the
  // request crosses the network boundary must never cause an automatic replay.
  crashRecovery: 'manual',
  validate: validateConfirmation,
  steps: [
    {
      key: 'accept_proposal', effectClass: 'external_read', maxAttempts: 1,
      async run({ db, run, input, services }) {
        const [proposal] = await db.query(sql`SELECT * FROM ownerrez_mutation_proposals WHERE id=${input.proposalId}`);
        if (!proposal) throw new Error('OwnerRez mutation proposal was not found');
        if (proposal.status !== 'pending') throw new Error(`OwnerRez proposal is ${proposal.status}, not pending`);
        if (new Date(proposal.expires_at).getTime() <= Date.now()) {
          await db.query(sql`UPDATE ownerrez_mutation_proposals SET status='expired', updated_at=datetime('now') WHERE id=${proposal.id}`);
          throw new Error('OwnerRez proposal expired; create a new proposal');
        }
        if (proposal.proposed_by !== run.actor_user_id) {
          const error = new Error('the same authorized Slack user who proposed the mutation must confirm it');
          error.code = 'ownerrez_confirmer_mismatch';
          throw error;
        }
        if (proposal.acceptance_hash !== String(input.acceptanceHash).toLowerCase()) {
          throw new Error('OwnerRez acceptance hash does not match the proposal');
        }
        const validated = validateMutationInput({
          operationId: proposal.operation_id,
          ...proposalRequest(proposal),
        });
        const request = proposalRequest(proposal);
        const current = await preflightSnapshot(ownerRezClient(services), validated.operation, request);
        assertPrecondition(proposal, current);
        await db.query(sql`UPDATE ownerrez_mutation_proposals SET status='confirmed', confirmed_by=${run.actor_user_id},
          confirmation_run_id=${run.id}, confirmed_at=datetime('now'), updated_at=datetime('now') WHERE id=${proposal.id}`);
        return {
          proposalId: proposal.id,
          operationId: proposal.operation_id,
          request,
          requestPath: proposal.request_path,
          requestHash: proposal.request_hash,
        };
      },
    },
    {
      key: 'execute_once', effectClass: 'external_non_idempotent', maxAttempts: 1,
      async run({ db, run, state, services, store, stepKey }) {
        const accepted = state.accept_proposal;
        const validated = validateMutationInput({ operationId: accepted.operationId, ...accepted.request });
        const effect = await store.createEffect(db, {
          runId: run.id, stepKey, effectType: 'ownerrez_mutation', provider: 'ownerrez',
          operation: accepted.operationId, idempotencyKey: `${accepted.proposalId}:ownerrez:execute-once`,
          request: { operationId: accepted.operationId, requestHash: accepted.requestHash },
          target: { requestPath: accepted.requestPath },
        });
        let response;
        try {
          response = await ownerRezClient(services)({
            method: validated.operation.method,
            requestPath: accepted.requestPath,
            query: accepted.request.query,
            body: accepted.request.body,
          });
        } catch (error) {
          const ambiguous = !Number.isInteger(error.status) || error.status >= 500;
          await db.query(sql`UPDATE ownerrez_mutation_proposals SET status=${ambiguous ? 'ambiguous' : 'failed'},
            processing_error=${String(error.message).slice(0, 1000)}, updated_at=datetime('now') WHERE id=${accepted.proposalId}`);
          if (ambiguous) {
            error.code = 'ambiguous_external_result';
            error.retryable = false;
          } else {
            await store.transitionEffect(db, {
              effectId: effect.id, status: 'failed', providerStatus: String(error.status),
              errorCode: error.code || 'ownerrez_rejected', errorMessage: error.message,
            });
          }
          throw error;
        }
        await store.transitionEffect(db, {
          effectId: effect.id, status: 'accepted_by_provider', providerStatus: String(response.status),
          providerRef: entityId(response.data),
          response: { status: response.status, responseHash: store.sha256(response.data) },
        });
        return {
          effectId: effect.id,
          providerStatus: response.status,
          providerRef: entityId(response.data),
          response: response.data,
        };
      },
    },
    {
      key: 'verify_readback', effectClass: 'external_read', maxAttempts: 1,
      async run({ db, run, state, services, store, stepKey }) {
        const accepted = state.accept_proposal;
        const validated = validateMutationInput({ operationId: accepted.operationId, ...accepted.request });
        const provider = state.execute_once;
        const readback = await verifyMutation(ownerRezClient(services), validated.operation, accepted.request, {
          status: provider.providerStatus, data: provider.response,
        });
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'ownerrez.api.readback',
          sourceRef: String(readback.providerRef || accepted.proposalId),
          payload: { operationId: accepted.operationId, requestHash: accepted.requestHash, mode: readback.mode, data: readback.data },
        });
        await store.transitionEffect(db, {
          effectId: provider.effectId, status: 'verified_by_readback',
          providerStatus: `http_${provider.providerStatus}`, providerRef: readback.providerRef,
          response: { evidenceId: evidence.id, readbackHash: store.sha256(readback.data), mode: readback.mode },
        });
        await db.query(sql`UPDATE ownerrez_mutation_proposals SET status='completed',
          provider_ref=${readback.providerRef === null || readback.providerRef === undefined ? null : String(readback.providerRef)},
          provider_status=${String(provider.providerStatus)}, response_json=${store.stableJson(provider.response)},
          readback_json=${store.stableJson(readback.data)}, readback_hash=${store.sha256(readback.data)},
          processing_error=NULL, completed_at=datetime('now'), updated_at=datetime('now')
          WHERE id=${accepted.proposalId}`);
        return { evidenceId: evidence.id, readbackMode: readback.mode, providerRef: readback.providerRef };
      },
    },
    {
      key: 'notify_humans', effectClass: 'internal_notification', maxAttempts: 1,
      async run({ db, run, state, store }) {
        const target = notificationTargets(loadPolicy());
        if (!target.channelId) return { queued: false };
        const accepted = state.accept_proposal;
        const verified = state.verify_readback;
        const message = `${target.mentions ? `${target.mentions} ` : ''}OwnerRez change verified by readback. `
          + `Operation: ${accepted.operationId} · Proposal: ${accepted.proposalId} · `
          + `Workflow: ${run.id} · Evidence: ${verified.evidenceId}`;
        await store.enqueueOutbox(db, {
          runId: run.id, topic: 'slack.notification',
          idempotencyKey: `${run.id}:ownerrez-write-notification`,
          payload: { channelId: target.channelId, message },
        });
        return { queued: true, channelId: target.channelId };
      },
    },
  ],
  output({ state }) {
    return {
      status: 'verified_by_readback',
      proposalId: state.accept_proposal.proposalId,
      operationId: state.accept_proposal.operationId,
      effectId: state.execute_once.effectId,
      evidenceId: state.verify_readback.evidenceId,
      providerRef: state.verify_readback.providerRef,
      readbackMode: state.verify_readback.readbackMode,
      humansNotified: state.notify_humans.queued,
    };
  },
};

module.exports = {
  PROPOSAL_TTL_MS,
  assertPrecondition,
  confirmDefinition,
  entityId,
  partialMatch,
  preflightSnapshot,
  proposeDefinition,
  validateConfirmation,
  verifyMutation,
};
