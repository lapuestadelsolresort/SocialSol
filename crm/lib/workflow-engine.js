'use strict';

const crypto = require('node:crypto');
const store = require('./workflow-store');
const { loadPolicy } = require('./channel-policy');
const { reviewChannelId, stepExecutionDecision, triggerDecision } = require('./workflow-execution-policy');

function retryDelayMs(attempts) {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1)));
}

function startLeaseHeartbeat(db, runId, stepKey, leaseToken, leaseMs) {
  const intervalMs = Math.max(1_000, Math.min(60_000, Math.floor(leaseMs / 3)));
  let timer = null;
  let stopped = false;
  let inFlight = Promise.resolve();
  let lostError = null;
  const beat = () => {
    inFlight = inFlight.then(async () => {
      if (stopped || lostError) return;
      try {
        await store.renewStepLease(db, runId, stepKey, leaseToken, leaseMs);
      } catch (error) {
        lostError = error;
      }
    });
  };
  timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await inFlight;
      if (lostError) throw lostError;
    },
  };
}

function executionPolicy(services) {
  if (services.enforcePolicy !== true) return null;
  return typeof services.policyProvider === 'function'
    ? services.policyProvider()
    : loadPolicy({ fresh: true });
}

async function executeGraph(db, definition, runId, services = {}) {
  let run = await store.getRun(db, runId);
  if (!run) throw new Error(`workflow run not found: ${runId}`);
  if (run.status === 'completed' || run.status === 'failed') return run;
  if (Number(run.workflow_version) !== definition.version) {
    const error = new Error(
      `workflow ${definition.name} run ${run.id} was created for version ${run.workflow_version}; current version is ${definition.version}`,
    );
    error.code = 'workflow_version_mismatch';
    error.retryable = false;
    await store.failRun(db, run.id, error);
    return store.getRun(db, run.id);
  }

  let state = run.state || {};
  for (const stepDefinition of definition.steps) {
    run = await store.getRun(db, runId);
    const step = run.steps.find(item => item.step_key === stepDefinition.key);
    if (!step) throw new Error(`workflow step missing: ${stepDefinition.key}`);
    if (step.status === 'completed' || step.status === 'skipped') continue;
    if (step.status === 'waiting') return run;
    // Another worker owns the external-effect boundary. It will either finish
    // or the stale-run recovery policy will decide whether replay is safe.
    if (step.status === 'running') return run;
    if (step.status === 'retry' && new Date(step.available_at).getTime() > Date.now()) return run;

    const policy = executionPolicy(services);
    const trigger = policy ? triggerDecision(definition, run.trigger_type) : { allowed: true };
    const policyDecision = !trigger.allowed
      ? { allowed: false, skip: false, reason: trigger.reason, effectClass: stepDefinition.effectClass || null }
      : policy ? stepExecutionDecision({
        policy,
        definition,
        step: stepDefinition,
        creationSnapshot: run.policySnapshot,
      }) : { allowed: true, reason: 'policy_not_enforced' };
    if (!policyDecision.allowed && policyDecision.skip) {
      const output = {
        skipped: true,
        reason: policyDecision.reason,
        effectClass: policyDecision.effectClass,
      };
      state = { ...state, [stepDefinition.key]: output };
      await store.skipStep(db, runId, stepDefinition.key, output, state);
      continue;
    }

    const stepInput = { workflowInput: run.input, state };
    const leaseMs = stepDefinition.leaseMs || 5 * 60_000;
    const lease = await store.beginStep(
      db,
      runId,
      stepDefinition.key,
      stepInput,
      services.workerId || `inline:${process.pid}:${crypto.randomUUID()}`,
      leaseMs,
    );
    if (!lease) return store.getRun(db, runId);
    const heartbeat = startLeaseHeartbeat(db, runId, stepDefinition.key, lease.leaseToken, leaseMs);
    try {
      if (!policyDecision.allowed) {
        const error = new Error(`workflow execution blocked: ${policyDecision.reason}`);
        error.code = policyDecision.reason;
        error.retryable = false;
        throw error;
      }
      const result = await stepDefinition.run({
        db,
        run,
        input: run.input,
        state,
        services,
        store,
        stepKey: stepDefinition.key,
      });
      if (result?.waiting) {
        throw Object.assign(new Error('waiting steps are not implemented yet'), { code: 'unsupported_wait_state' });
      }
      const output = result?.output ?? result ?? {};
      state = { ...state, [stepDefinition.key]: output };
      await heartbeat.stop();
      await store.completeStep(db, runId, stepDefinition.key, output, state, { leaseToken: lease.leaseToken });
    } catch (error) {
      try {
        await heartbeat.stop();
      } catch (leaseError) {
        error = leaseError;
      }
      const latest = await store.getRun(db, runId);
      const current = latest.steps.find(item => item.step_key === stepDefinition.key);
      const retryable = error?.retryable === true && current.attempts < current.max_attempts;
      const leaseAmbiguous = error?.code === 'workflow_lease_lost'
        && ['external_non_idempotent', 'guest_message'].includes(policyDecision.effectClass);
      const reviewRequired = error?.code === 'ambiguous_external_result'
        || leaseAmbiguous
        || (error?.requiresManualReview === true && !retryable);
      if (reviewRequired) {
        const reasonCode = error?.manualReviewReasonCode
          || (error?.code === 'ambiguous_external_result' || leaseAmbiguous
            ? 'ambiguous_external_result' : 'manual_review_required');
        const channelId = reviewChannelId(policy || {}, definition, run);
        const review = await store.createManualReview(db, {
          runId,
          stepKey: stepDefinition.key,
          reviewChannelId: channelId,
          reasonCode,
          reasonMessage: error.message,
        });
        if (channelId) {
          const threadTs = state.resolve_conversation?.threadTs || null;
          await store.enqueueOutbox(db, {
            runId,
            topic: 'slack.notification',
            idempotencyKey: `${runId}:manual-review:${stepDefinition.key}:slack`,
            payload: {
              channelId,
              threadTs,
              message: `⚠️ Workflow ${runId} has an external-effect result requiring human review (${reasonCode}). Do not resend or repeat the mutation until review ${review.id} is resolved. After checking the provider console, use \`!review resolve ${review.id} sent <provider-id>\`, \`!review resolve ${review.id} not-sent\`, or \`!review resolve ${review.id} abandon\`.`,
            },
          });
        } else {
          // A channel-less run (a scheduled graph) whose policy resolves no
          // write_notifications channel opens a review nobody is told about —
          // the silence that made F-052 hard to see. The review still exists
          // and workflow-health still alerts on open reviews; this records the
          // missing notice durably so the gap is attributable instead of
          // invisible.
          await store.recordEvent(db, {
            runId,
            stepKey: stepDefinition.key,
            type: 'manual_review_unnotified',
            payload: { reviewId: review.id, reasonCode, reason: 'no_review_channel_resolved' },
          });
          console.warn(`[workflow-engine] run ${runId} opened manual review ${review.id} with no notification channel — set write_notifications.channel_ids`);
        }
      }
      if (error?.code === 'workflow_lease_lost') return store.getRun(db, runId);
      const retryAt = retryable
        ? new Date(Date.now() + retryDelayMs(current.attempts)).toISOString()
        : null;
      await store.failStep(db, runId, stepDefinition.key, error, {
        retry: retryable,
        retryAt,
        leaseToken: lease.leaseToken,
      });
      return store.getRun(db, runId);
    }
  }

  const output = typeof definition.output === 'function'
    ? definition.output({ input: run.input, state })
    : state;
  await store.completeRun(db, runId, output);
  return store.getRun(db, runId);
}

async function startGraph(db, definition, request, services = {}) {
  if (typeof definition.validate === 'function') definition.validate(request.input || {});
  const created = await store.createRun(db, { definition, ...request });
  if (!created.created) return created.run;
  return executeGraph(db, definition, created.run.id, services);
}

module.exports = { executeGraph, executionPolicy, retryDelayMs, startGraph, startLeaseHeartbeat };
