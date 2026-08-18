'use strict';

const { authorizationDecision, loadPolicy } = require('./channel-policy');
const { AUTO_CONFIRM_TRIGGER, systemOriginAccounted } = require('./policy-registry-agreement');
const { policySnapshot } = require('./workflow-execution-policy');
const { startGraph } = require('./workflow-engine');

// Auto-confirm arming is a runtime-policy decision: the confirm workflow must be
// allowlisted in `autonomous_workflows`, the same authority layer every
// system-origin workflow passes (D-001). When the policy cannot be read or the
// workflow is not allowlisted, the proposal behaves exactly as un-armed:
// awaiting the human confirmation command.
//
// Multi-operation surfaces (D-001 grants autonomy per OPERATION, not per
// workflow) additionally pass `operation`: dispatch then requires the policy's
// `autonomous_operations[<confirm workflow>]` allowlist to name that exact
// operation. No allowlist, or an unlisted operation, stays un-armed.
async function dispatchAutoConfirm({
  db, run, services = {}, store, stepKey,
  confirmDefinition, proposalId, acceptanceHash, idempotencyKey, operation = null,
}) {
  let policy;
  try {
    policy = typeof services.policyProvider === 'function'
      ? services.policyProvider()
      : loadPolicy({ fresh: true });
  } catch (error) {
    return { dispatched: false, reason: 'policy_unavailable', detail: String(error.message).slice(0, 200) };
  }
  const decision = authorizationDecision({
    policy,
    capability: confirmDefinition.capability,
    workflowName: confirmDefinition.name,
    context: { origin: 'system' },
  });
  if (!decision.allowed) return { dispatched: false, reason: decision.reason };
  if (!systemOriginAccounted(confirmDefinition)) {
    return { dispatched: false, reason: 'autonomy_not_registry_accounted' };
  }
  if (operation !== null) {
    const allowedOperations = policy.autonomous_operations?.[confirmDefinition.name];
    if (!Array.isArray(allowedOperations) || !allowedOperations.includes(operation)) {
      return { dispatched: false, reason: 'autonomous_operation_denied', operation };
    }
  }

  let child;
  try {
    child = await startGraph(db, confirmDefinition, {
      idempotencyKey,
      triggerType: AUTO_CONFIRM_TRIGGER,
      triggerRef: run.id,
      channelId: run.channel_id,
      actorUserId: run.actor_user_id,
      input: { proposalId, acceptanceHash },
      policySnapshot: policySnapshot(policy, confirmDefinition),
    }, services);
  } catch (error) {
    // An open manual review pauses the confirm workflow; auto-dispatch must not
    // queue behind it. The proposal stays pending for the manual path.
    if (error.code === 'workflow_manual_review_open') {
      return { dispatched: false, reason: error.code };
    }
    if (error.code === 'workflow_mutation_in_progress') error.retryable = true;
    throw error;
  }
  await store.recordEvent(db, {
    runId: run.id,
    stepKey,
    type: 'auto_confirm_dispatched',
    payload: { proposalId, confirmRunId: child.id, confirmStatus: child.status },
  });
  return {
    dispatched: true,
    confirmRunId: child.id,
    confirmStatus: child.status,
    confirmOutput: child.status === 'completed' ? child.output : null,
    confirmError: child.status === 'failed'
      ? { code: child.error_code, message: child.error_message }
      : null,
  };
}

module.exports = { AUTO_CONFIRM_TRIGGER, dispatchAutoConfirm };
