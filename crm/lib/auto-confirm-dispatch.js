'use strict';

const { authorizationDecision, loadPolicy } = require('./channel-policy');
const { policySnapshot } = require('./workflow-execution-policy');
const { startGraph } = require('./workflow-engine');

const AUTO_CONFIRM_TRIGGER = 'auto_confirm_dispatch';

// Auto-confirm arming is a runtime-policy decision: the confirm workflow must be
// allowlisted in `autonomous_workflows`, the same authority layer every
// system-origin workflow passes (D-001). When the policy cannot be read or the
// workflow is not allowlisted, the proposal behaves exactly as un-armed:
// awaiting the human confirmation command.
async function dispatchAutoConfirm({
  db, run, services = {}, store, stepKey,
  confirmDefinition, proposalId, acceptanceHash, idempotencyKey,
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
