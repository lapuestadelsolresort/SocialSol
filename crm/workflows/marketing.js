'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { AUTO_CONFIRM_TRIGGER, dispatchAutoConfirm } = require('../lib/auto-confirm-dispatch');
const { pythonCommand } = require('../lib/workflow-command');
const { evidenceReadDefinition } = require('./read-models');
const { makeDurableJob } = require('./durable-job');

const CHANGE_TTL_MS = 15 * 60_000;
const SNAPSHOT_TTL_MS = 4 * 60 * 60_000;
const CONFIRMED_OPERATIONS = new Set([
  'campaign_pause',
  'campaign_budget',
  'campaign_activate',
  'campaign_provision_paused',
  'landing_reweight',
  'landing_status',
]);
const ALL_OPERATIONS = new Set(CONFIRMED_OPERATIONS);

function parseCommandJson(result, label) {
  let parsed;
  try { parsed = JSON.parse(String(result?.stdout || '').trim()); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    const error = new Error(`${label} did not emit machine-readable JSON`);
    error.code = 'marketing_adapter_invalid_output';
    throw error;
  }
  return parsed;
}

function validateDate(value, name) {
  if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
}

function validateSnapshotInput(input) {
  validateDate(input.start, 'start');
  validateDate(input.end, 'end');
  if (input.start && input.end && input.end < input.start) throw new Error('end must be on or after start');
  if (input.start && input.end) {
    const days = (new Date(`${input.end}T00:00:00Z`) - new Date(`${input.start}T00:00:00Z`)) / 86400000;
    if (days > 31) throw new Error('marketing snapshot window may not exceed 31 days');
  }
}

function marketingSnapshotCommand(input, run = null) {
  const args = [];
  if (input.start) args.push('--start', String(input.start));
  if (input.end) args.push('--end', String(input.end));
  const env = run?.id ? { WORKFLOW_RUN_ID: run.id } : {};
  return pythonCommand('automation/marketing_snapshot.py', args, { timeoutMs: 5 * 60_000, env });
}

const marketingSnapshotRead = evidenceReadDefinition({
  name: 'marketing.snapshot.read',
  capability: 'marketing.read',
  validate: validateSnapshotInput,
  async collect({ input, run, services }) {
    if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
    const result = await services.runCommand(marketingSnapshotCommand(input, run));
    const snapshot = parseCommandJson(result, 'marketing snapshot');
    if (!snapshot.generated_at || !Array.isArray(snapshot.campaigns) || !Array.isArray(snapshot.authorized_actions)) {
      throw new Error('marketing snapshot is missing its authority contract');
    }
    return {
      source: 'marketing.live_snapshot',
      sourceRef: `${snapshot.window?.start || 'unknown'}:${snapshot.window?.end || 'unknown'}`,
      observedAt: snapshot.generated_at,
      expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString(),
      payload: snapshot,
    };
  },
});

const marketingDailyReport = {
  name: 'marketing.report.daily',
  version: 1,
  capability: 'marketing.read',
  mutates: true,
  autonomous: true,
  notificationChannelName: 'social-sol',
  steps: [
    {
      key: 'build_snapshot', effectClass: 'external_read', maxAttempts: 3,
      async run({ db, run, input, services, store, stepKey }) {
        if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
        validateDate(input.date, 'date');
        const args = ['--json', ...(input.date ? ['--date', String(input.date)] : [])];
        const result = await services.runCommand(pythonCommand(
          'automation/daily_consolidated_report.py', args,
          { timeoutMs: 5 * 60_000, env: { WORKFLOW_RUN_ID: run.id } },
        ));
        const parsed = parseCommandJson(result, 'daily marketing report');
        if (!parsed.snapshot?.generated_at || typeof parsed.message !== 'string' || !parsed.message.trim()) {
          throw new Error('daily marketing report did not contain a snapshot and message');
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: 'marketing.live_snapshot',
          sourceRef: parsed.snapshot.window?.end || input.date || null,
          observedAt: parsed.snapshot.generated_at,
          expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString(),
          payload: parsed.snapshot,
        });
        return { snapshot: parsed.snapshot, message: parsed.message, evidenceId: evidence.id };
      },
    },
    {
      key: 'enqueue_report', effectClass: 'internal_notification', maxAttempts: 1,
      async run({ db, run, state, store }) {
        const policy = require('../lib/channel-policy').loadPolicy();
        const channelId = Object.entries(policy.channels || {})
          .find(([, channel]) => channel.name === 'social-sol')?.[0];
        if (!channelId) throw new Error('social-sol notification channel is not configured');
        const outbox = await store.enqueueOutbox(db, {
          runId: run.id,
          topic: 'slack.notification',
          idempotencyKey: `${run.id}:marketing-daily-report:${channelId}`,
          payload: { channelId, message: `${state.build_snapshot.message}\n\nWorkflow: ${run.id} · Evidence: ${state.build_snapshot.evidenceId}` },
        });
        return { outboxId: outbox.id, channelId };
      },
    },
  ],
  output({ state }) {
    return {
      status: 'report_queued',
      evidenceId: state.build_snapshot.evidenceId,
      outboxId: state.enqueue_report.outboxId,
      window: state.build_snapshot.snapshot.window,
      authorizedActions: state.build_snapshot.snapshot.authorized_actions.length,
    };
  },
};

const metaAudienceSync = makeDurableJob({
  name: 'meta.audience.sync',
  version: 1,
  capability: 'marketing.write',
  provider: 'meta',
  operation: 'custom_audience.sync_fixed_segments',
  autonomous: true,
  notificationChannelName: 'social-sol',
  mentionUsers: false,
  requestSummary: () => ({
    segments: ['past_guests_and_inquiries', 'verified_planners_and_partners'],
    suppressionEnforced: true,
    stateAuthority: 'crm.marketing_audience_state',
  }),
  buildCommand: ({ run }) => pythonCommand(
    'automation/crm_audience_sync.py',
    ['--workflow-managed', '--json'],
    { timeoutMs: 15 * 60_000, env: { WORKFLOW_RUN_ID: run.id } },
  ),
  async verify({ services, state }) {
    const result = await services.runCommand(pythonCommand(
      'automation/crm_audience_sync.py', ['--verify', '--json'], { timeoutMs: 5 * 60_000 },
    ));
    const readback = parseCommandJson(result, 'Meta audience readback');
    if (readback.verified !== true || !Array.isArray(readback.audiences) || readback.audiences.length !== 2) {
      return { verified: false, reason: 'Meta audience readback did not verify both fixed segments', retryable: true };
    }
    const command = state.execute.parsed;
    if (!command?.ok || !Array.isArray(command.results)) {
      return { verified: false, reason: 'Meta audience sync did not emit a complete result', retryable: false };
    }
    return {
      verified: true,
      source: 'meta.customaudiences.readback+crm.marketing_audience_state',
      providerStatus: 'two_segments_verified',
      evidence: { mutation: command, readback },
      summary: {
        changed: Number(command.changed || 0),
        audiences: readback.audiences.map(row => ({
          key: row.key, audienceId: row.audience_id, emailCount: row.email_count,
        })),
      },
    };
  },
  shouldNotify: ({ state }) => Number(state.verify_readback?.summary?.changed || 0) > 0,
  buildNotificationMessage: ({ run, state }) => {
    const summary = state.verify_readback.summary;
    const segments = summary.audiences.map(row => `${row.key} ${row.emailCount}`).join(', ');
    return `CRM → Meta audiences verified after ${summary.changed} changed segment(s): ${segments}. Workflow ${run.id} · Evidence ${state.verify_readback.evidenceId}.`;
  },
  summarize: ({ verification }) => ({ report: verification.summary }),
});

function validateReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 8 || reason.length > 500) throw new Error('reason must be 8-500 characters');
  return reason;
}

function normalizeChangeInput(input) {
  const operation = String(input?.operation || '');
  if (!ALL_OPERATIONS.has(operation)) throw new Error('unsupported marketing operation');
  const output = { operation, reason: validateReason(input.reason) };
  if (operation.startsWith('campaign_')) {
    const briefId = String(input.briefId || '');
    if (!/^[a-z0-9][a-z0-9_-]{1,119}$/.test(briefId)) throw new Error('valid briefId is required');
    output.briefId = briefId;
  }
  if (operation === 'campaign_budget') {
    const dailyBudgetUsd = Number(input.dailyBudgetUsd);
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 5 || dailyBudgetUsd > 500) {
      throw new Error('dailyBudgetUsd must be from 5 to 500');
    }
    output.dailyBudgetUsd = Math.round(dailyBudgetUsd * 100) / 100;
  }
  if (operation.startsWith('landing_')) {
    const slug = String(input.slug || '');
    if (!/^[a-z0-9][a-z0-9_-]{1,119}$/.test(slug)) throw new Error('valid landing variant slug is required');
    output.slug = slug;
  }
  if (operation === 'landing_reweight') {
    if (!Number.isInteger(input.trafficWeight) || input.trafficWeight < 0 || input.trafficWeight > 100) {
      throw new Error('trafficWeight must be an integer from 0 to 100');
    }
    output.trafficWeight = input.trafficWeight;
  }
  if (operation === 'landing_status') {
    const status = String(input.status || '');
    if (!['draft', 'live', 'paused', 'retired'].includes(status)) {
      throw new Error('status must be draft, live, paused, or retired');
    }
    output.status = status;
  }
  return output;
}

function adapterCommand(phase, request, preflightHash = null) {
  const args = [phase, '--request-json', JSON.stringify(request)];
  if (preflightHash) args.push('--preflight-hash', preflightHash);
  return pythonCommand('automation/marketing_workflow.py', args, { timeoutMs: 15 * 60_000 });
}

async function runAdapter(services, phase, request, preflightHash = null) {
  if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
  const result = await services.runCommand(adapterCommand(phase, request, preflightHash));
  return parseCommandJson(result, `marketing ${phase}`);
}

function scopeRef(preflight) {
  return String(preflight.campaignId || preflight.targetRef || '');
}

async function persistChangeRequest({ db, run, store, stepKey, request, preflight, authorityTier, sourceEvidenceId = null }) {
  const requestHash = store.sha256(request);
  const proposalId = crypto.randomUUID();
  const acceptanceHash = authorityTier === 'confirmed'
    ? store.sha256(`${proposalId}:${requestHash}:${preflight.preflightHash}`).slice(0, 12)
    : null;
  const expiresAt = authorityTier === 'confirmed'
    ? new Date(Date.now() + CHANGE_TTL_MS).toISOString()
    : null;
  await db.query(sql`INSERT INTO marketing_change_requests (
    id, operation, target_ref, scope_ref, authority_tier, request_json, request_hash,
    acceptance_hash, preflight_json, preflight_hash, source_evidence_id,
    status, reason, proposed_by, proposal_run_id, execution_run_id, expires_at
  ) VALUES (
    ${proposalId}, ${request.operation}, ${String(preflight.targetRef)}, ${scopeRef(preflight)},
    ${authorityTier}, ${store.stableJson(request)}, ${requestHash}, ${acceptanceHash},
    ${store.stableJson(preflight)}, ${preflight.preflightHash}, ${sourceEvidenceId},
    ${authorityTier === 'autonomous' ? 'authorized' : 'pending'}, ${request.reason},
    ${run.actor_user_id || 'system'}, ${authorityTier === 'confirmed' ? run.id : null},
    ${authorityTier === 'autonomous' ? run.id : null}, ${expiresAt}
  )`);
  const evidence = await store.createEvidence(db, {
    runId: run.id,
    stepKey,
    source: 'marketing.preflight',
    sourceRef: proposalId,
    expiresAt,
    payload: {
      proposalId, operation: request.operation, requestHash,
      preflightHash: preflight.preflightHash, briefHash: preflight.briefHash || null,
      sourceEvidenceId, authorityTier,
    },
  });
  return { proposalId, acceptanceHash, expiresAt, requestHash, evidenceId: evidence.id };
}

const marketingChangePropose = {
  name: 'marketing.change.propose',
  version: 2,
  capability: 'marketing.write',
  // The proposal writes only the local immutable request. When
  // `marketing.change.confirm` is policy-armed for autonomy AND the proposal's
  // exact operation is named in the policy's `autonomous_operations` allowlist
  // (D-001 grants Meta autonomy per operation), the final step hands the
  // proposal to the confirm graph, which owns every provider effect — and the
  // adapter's F-001 review invariant still gates activation inside it.
  mutates: false,
  validate: normalizeChangeInput,
  steps: [
    {
      key: 'preflight', effectClass: 'external_read', maxAttempts: 2,
      async run({ input, services }) {
        const request = normalizeChangeInput(input);
        if (!CONFIRMED_OPERATIONS.has(request.operation)) throw new Error('operation is not confirmation-gated');
        return runAdapter(services, 'preflight', request);
      },
    },
    {
      key: 'persist_proposal', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, input, state, store, stepKey }) {
        const request = normalizeChangeInput(input);
        const persisted = await persistChangeRequest({
          db, run, store, stepKey, request, preflight: state.preflight, authorityTier: 'confirmed',
        });
        return {
          ...persisted,
          confirmationCommand: `!meta confirm ${persisted.proposalId} ${persisted.acceptanceHash}`,
        };
      },
    },
    {
      key: 'dispatch_confirmation', effectClass: 'local_write', maxAttempts: 3,
      async run({ db, run, input, state, services, store, stepKey }) {
        return dispatchAutoConfirm({
          db,
          run,
          services,
          store,
          stepKey,
          confirmDefinition: marketingChangeConfirm,
          proposalId: state.persist_proposal.proposalId,
          acceptanceHash: state.persist_proposal.acceptanceHash,
          idempotencyKey: `auto-confirm:marketing:${state.persist_proposal.proposalId}`,
          operation: normalizeChangeInput(input).operation,
        });
      },
    },
  ],
  output({ input, state }) {
    const base = {
      operation: input.operation,
      targetRef: state.preflight.targetRef,
      briefHash: state.preflight.briefHash || null,
      proposalId: state.persist_proposal.proposalId,
      requestHash: state.persist_proposal.requestHash,
      expiresAt: state.persist_proposal.expiresAt,
      evidenceId: state.persist_proposal.evidenceId,
    };
    const dispatch = state.dispatch_confirmation || { dispatched: false };
    if (!dispatch.dispatched) {
      return {
        ...base,
        status: 'awaiting_explicit_confirmation',
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
        providerRef: dispatch.confirmOutput?.providerRef || null,
        error: dispatch.confirmError,
      },
    };
  },
};

function validateConfirmation(input) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input?.proposalId || ''))) {
    throw new Error('valid marketing proposalId is required');
  }
  if (!/^[0-9a-f]{12}$/i.test(String(input?.acceptanceHash || ''))) {
    throw new Error('valid marketing acceptanceHash is required');
  }
}

async function registerMutationEffect({ db, run, store, stepKey, requestId, request, preflight }) {
  const effect = await store.createEffect(db, {
    runId: run.id,
    stepKey,
    effectType: request.operation.startsWith('landing_') ? 'local_serving_change' : 'paid_media_mutation',
    provider: preflight.provider,
    operation: request.operation,
    idempotencyKey: `${requestId}:${preflight.provider}:${request.operation}`,
    request: {
      requestId,
      requestHash: store.sha256(request),
      preflightHash: preflight.preflightHash,
      briefHash: preflight.briefHash || null,
    },
    target: { targetRef: preflight.targetRef, scopeRef: scopeRef(preflight) },
  });
  await db.query(sql`UPDATE marketing_change_requests SET effect_id=${effect.id},
    execution_run_id=${run.id}, status='executing', updated_at=datetime('now') WHERE id=${requestId}`);
  return { effectId: effect.id, status: effect.status };
}

async function executeMutation({ db, state, services, store }) {
  const accepted = state.accept_request || state.authorize_action;
  const [effect] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${state.register_effect.effectId}`);
  if (!effect) throw new Error('marketing workflow effect was not found');
  if (effect.provider_ref && effect.status !== 'requested') {
    return { effectId: effect.id, providerRef: effect.provider_ref, status: effect.status, replayed: true };
  }
  let result;
  try {
    result = await runAdapter(services, 'execute', accepted.request, accepted.preflight.preflightHash);
  } catch (error) {
    error.code = 'ambiguous_external_result';
    error.retryable = false;
    throw error;
  }
  try {
    await store.transitionEffect(db, {
      effectId: effect.id,
      status: 'accepted_by_provider',
      providerStatus: 'adapter_exit_0',
      providerRef: String(result.providerRef || accepted.preflight.targetRef),
      response: { responseHash: store.sha256(result), accepted: result.accepted === true },
    });
    await db.query(sql`UPDATE marketing_change_requests SET provider_ref=${String(result.providerRef || accepted.preflight.targetRef)},
      status='accepted_by_provider', updated_at=datetime('now') WHERE id=${accepted.requestId}`);
  } catch (error) {
    error.code = 'post_dispatch_projection_failed';
    error.retryable = false;
    error.requiresManualReview = true;
    throw error;
  }
  return {
    effectId: effect.id,
    providerRef: String(result.providerRef || accepted.preflight.targetRef),
    status: 'accepted_by_provider',
    replayed: false,
  };
}

async function verifyMutation({ db, run, state, services, store, stepKey }) {
  const accepted = state.accept_request || state.authorize_action;
  let result;
  try {
    result = await runAdapter(services, 'readback', accepted.request);
  } catch (error) {
    error.code = 'marketing_readback_unavailable';
    error.retryable = true;
    error.requiresManualReview = true;
    throw error;
  }
  if (result.verified !== true) {
    const error = new Error('marketing mutation was not verified by readback');
    error.code = 'marketing_readback_mismatch';
    error.retryable = true;
    error.requiresManualReview = true;
    throw error;
  }
  const evidence = await store.createEvidence(db, {
    runId: run.id,
    stepKey,
    source: `${accepted.preflight.provider}.marketing_readback`,
    sourceRef: String(result.providerRef || state.execute_once.providerRef),
    payload: result,
  });
  await store.transitionEffect(db, {
    effectId: state.register_effect.effectId,
    status: 'verified_by_readback',
    providerStatus: 'verified',
    providerRef: String(result.providerRef || state.execute_once.providerRef),
    response: { evidenceId: evidence.id, payloadHash: evidence.payloadHash },
  });
  await db.query(sql`UPDATE marketing_change_requests SET status='completed',
    readback_evidence_id=${evidence.id}, completed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=${accepted.requestId}`);
  return { evidenceId: evidence.id, providerRef: result.providerRef, readback: result.readback || null };
}

async function notifyMutation({ db, run, state, store }) {
  const accepted = state.accept_request || state.authorize_action;
  const policy = require('../lib/channel-policy').loadPolicy();
  const channelId = run.channel_id || Object.entries(policy.channels || {})
    .find(([, channel]) => channel.name === 'social-sol')?.[0];
  if (!channelId) return { queued: 0 };
  const mode = accepted.authorityTier === 'autonomous' ? 'autonomous bounded action' : 'human-confirmed action';
  const message = `${accepted.request.operation} completed as a ${mode} and was verified by readback. `
    + `Target ${accepted.preflight.targetRef}. Workflow ${run.id} · Effect ${state.register_effect.effectId} `
    + `· Evidence ${state.verify_readback.evidenceId}.`;
  const outbox = await store.enqueueOutbox(db, {
    runId: run.id,
    topic: 'slack.notification',
    idempotencyKey: `${run.id}:marketing-write-notification:${channelId}`,
    payload: { channelId, message },
  });
  return { queued: 1, outboxId: outbox.id };
}

function mutationTailSteps() {
  return [
    {
      key: 'register_effect', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        const accepted = state.accept_request || state.authorize_action;
        return registerMutationEffect({
          db, run, store, stepKey, requestId: accepted.requestId,
          request: accepted.request, preflight: accepted.preflight,
        });
      },
    },
    {
      key: 'execute_once', effectClass: 'external_non_idempotent', maxAttempts: 1,
      run: executeMutation,
    },
    {
      key: 'verify_readback', effectClass: 'external_read', maxAttempts: 4,
      run: verifyMutation,
    },
    {
      key: 'notify_humans', effectClass: 'internal_notification', maxAttempts: 1,
      run: notifyMutation,
    },
  ];
}

const marketingChangeConfirm = {
  name: 'marketing.change.confirm',
  version: 1,
  capability: 'marketing.write',
  mutates: true,
  serializeMutations: true,
  serializationKey: 'marketing.mutation',
  crashRecovery: 'manual',
  allowedTriggers: ['slack_meta_campaign_confirm_command', AUTO_CONFIRM_TRIGGER],
  validate: validateConfirmation,
  steps: [
    {
      key: 'accept_request', effectClass: 'external_read', maxAttempts: 1,
      async run({ db, run, input, services, store }) {
        const [row] = await db.query(sql`SELECT * FROM marketing_change_requests WHERE id=${input.proposalId}`);
        if (!row) throw new Error('marketing change proposal was not found');
        if (row.status !== 'pending') throw new Error(`marketing change proposal is ${row.status}, not pending`);
        if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
          await db.query(sql`UPDATE marketing_change_requests SET status='expired', updated_at=datetime('now') WHERE id=${row.id}`);
          throw new Error('marketing change proposal expired; create a fresh proposal');
        }
        if (row.proposed_by !== run.actor_user_id) {
          const error = new Error('the same authorized Slack user who proposed the change must confirm it');
          error.code = 'marketing_confirmer_mismatch';
          throw error;
        }
        if (row.acceptance_hash !== String(input.acceptanceHash).toLowerCase()) {
          throw new Error('marketing acceptance hash does not match the proposal');
        }
        const request = store.parseJson(row.request_json, {});
        const preflight = store.parseJson(row.preflight_json, {});
        const fresh = await runAdapter(services, 'preflight', request);
        if (fresh.preflightHash !== row.preflight_hash || store.sha256(request) !== row.request_hash) {
          throw new Error('marketing target or immutable request changed after proposal');
        }
        await db.query(sql`UPDATE marketing_change_requests SET status='confirmed', confirmed_by=${run.actor_user_id},
          execution_run_id=${run.id}, confirmed_at=datetime('now'), updated_at=datetime('now') WHERE id=${row.id}`);
        return { requestId: row.id, request, preflight, authorityTier: 'confirmed' };
      },
    },
    ...mutationTailSteps(),
  ],
  output({ state }) {
    return {
      status: 'verified_by_readback',
      requestId: state.accept_request.requestId,
      operation: state.accept_request.request.operation,
      effectId: state.register_effect.effectId,
      evidenceId: state.verify_readback.evidenceId,
      providerRef: state.verify_readback.providerRef,
    };
  },
};

function validateAutonomousInput(input) {
  const request = normalizeChangeInput(input);
  if (!['campaign_pause', 'campaign_budget'].includes(request.operation)) {
    throw new Error('autonomous paid actions are restricted to pause or budget decrease');
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(input.evidenceId || ''))) throw new Error('valid evidenceId is required');
}

function exactAuthorizedAction(snapshot, request) {
  const wanted = request.operation === 'campaign_pause' ? 'pause' : 'budget_decrease';
  return (snapshot.authorized_actions || []).find(action => (
    action.action === wanted
    && action.briefId === request.briefId
    && (wanted !== 'budget_decrease'
      || Number(action.targetDailyBudgetUsd) === Number(request.dailyBudgetUsd))
  ));
}

const metaCampaignAutonomous = {
  name: 'meta.campaign.autonomous',
  version: 1,
  capability: 'marketing.write',
  mutates: true,
  autonomous: true,
  serializeMutations: true,
  serializationKey: 'marketing.mutation',
  crashRecovery: 'manual',
  validate: validateAutonomousInput,
  steps: [
    {
      key: 'authorize_action', effectClass: 'external_read', maxAttempts: 1,
      async run({ db, run, input, services, store, stepKey }) {
        const request = normalizeChangeInput(input);
        const [evidence] = await db.query(sql`SELECT * FROM workflow_evidence WHERE id=${String(input.evidenceId)}`);
        if (!evidence || evidence.source !== 'marketing.live_snapshot') {
          throw new Error('autonomous action requires a marketing.live_snapshot evidence artifact');
        }
        if (!evidence.expires_at || new Date(evidence.expires_at).getTime() <= Date.now()) {
          throw new Error('marketing snapshot evidence expired; run marketing.snapshot.read again');
        }
        const snapshot = store.parseJson(evidence.payload_json, {});
        if (snapshot.tracking_health?.healthy !== true) {
          throw new Error('tracking integrity is not healthy; autonomous mutation is blocked');
        }
        if (snapshot.autonomy?.ready !== true || Number(snapshot.autonomy.window_days) < 3) {
          throw new Error('autonomous mutation requires at least three completed days of snapshot evidence');
        }
        const action = exactAuthorizedAction(snapshot, request);
        if (!action) throw new Error('requested action is not exactly authorized by the supplied snapshot');
        const [recent] = await db.query(sql`SELECT id FROM marketing_change_requests
          WHERE scope_ref=${String(action.campaignId)} AND authority_tier='autonomous'
            AND status IN ('authorized','executing','accepted_by_provider','completed')
            AND created_at >= datetime('now','-24 hours') LIMIT 1`);
        if (recent) throw new Error(`campaign already received an autonomous mutation in the last 24 hours (${recent.id})`);
        const preflight = await runAdapter(services, 'preflight', request);
        if (String(preflight.campaignId) !== String(action.campaignId)) {
          throw new Error('live campaign no longer matches the snapshot action');
        }
        if (request.operation === 'campaign_budget') {
          const before = Number(preflight.before?.daily_budget_usd);
          if (Math.abs(before - Number(action.currentDailyBudgetUsd)) >= 0.005) {
            throw new Error('live campaign budget changed after the snapshot; refresh evidence');
          }
          if (!(request.dailyBudgetUsd < before)) throw new Error('autonomous campaign budget changes may only decrease spend');
        }
        const persisted = await persistChangeRequest({
          db, run, store, stepKey, request, preflight, authorityTier: 'autonomous',
          sourceEvidenceId: evidence.id,
        });
        return {
          requestId: persisted.proposalId,
          request,
          preflight,
          authorityTier: 'autonomous',
          sourceEvidenceId: evidence.id,
          authorizationReason: action.reason,
        };
      },
    },
    ...mutationTailSteps(),
  ],
  output({ state }) {
    return {
      status: 'verified_by_readback',
      authorityTier: 'autonomous',
      requestId: state.authorize_action.requestId,
      operation: state.authorize_action.request.operation,
      effectId: state.register_effect.effectId,
      evidenceId: state.verify_readback.evidenceId,
      sourceEvidenceId: state.authorize_action.sourceEvidenceId,
      providerRef: state.verify_readback.providerRef,
    };
  },
};

module.exports = {
  ALL_OPERATIONS,
  CONFIRMED_OPERATIONS,
  exactAuthorizedAction,
  marketingChangeConfirm,
  marketingChangePropose,
  marketingDailyReport,
  marketingSnapshotRead,
  metaAudienceSync,
  metaCampaignAutonomous,
  normalizeChangeInput,
  parseCommandJson,
  validateAutonomousInput,
};
