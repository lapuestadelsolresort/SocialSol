'use strict';

const crypto = require('node:crypto');

const SAFE_IN_SHADOW = new Set([
  'read',
  'external_read',
  'local_write',
  'internal_notification',
]);

const EXTERNAL_MUTATIONS = new Set([
  'external_idempotent',
  'external_mutation',
  'external_non_idempotent',
  'guest_message',
]);

function workflowIsLive(policy, workflowName) {
  return policy?.shadow_mode !== true
    || (Array.isArray(policy?.live_workflows) && policy.live_workflows.includes(workflowName));
}

function effectKey(definition, step) {
  return `${definition.name}:${step.key}`;
}

function effectClass(definition, step) {
  if (step.effectClass) return step.effectClass;
  return definition.mutates === false ? 'read' : 'external_mutation';
}

function alwaysOnEffects(policy) {
  return new Set(Array.isArray(policy?.always_on_effects) ? policy.always_on_effects : []);
}

function reviewChannelId(policy, definition, run = {}) {
  if (run.channel_id) return run.channel_id;
  if (definition.notificationChannelId && policy?.channels?.[definition.notificationChannelId]) {
    return definition.notificationChannelId;
  }
  if (definition.notificationChannelName) {
    const match = Object.entries(policy?.channels || {})
      .find(([, channel]) => channel.name === definition.notificationChannelName);
    if (match) return match[0];
  }
  const configured = Array.isArray(policy?.write_notifications?.channel_ids)
    ? policy.write_notifications.channel_ids.find(channelId => policy?.channels?.[channelId])
    : null;
  return configured || null;
}

function externalStepAllowed(policy, definition, step) {
  return workflowIsLive(policy, definition.name) || alwaysOnEffects(policy).has(effectKey(definition, step));
}

function policySnapshot(policy, definition) {
  const snapshot = {
    shadowMode: policy?.shadow_mode === true,
    workflowLive: workflowIsLive(policy, definition.name),
    allowedEffects: definition.steps
      .filter(step => EXTERNAL_MUTATIONS.has(effectClass(definition, step)) && externalStepAllowed(policy, definition, step))
      .map(step => effectKey(definition, step))
      .sort(),
  };
  const canonical = JSON.stringify(snapshot);
  return {
    ...snapshot,
    hash: crypto.createHash('sha256').update(canonical).digest('hex'),
  };
}

function triggerDecision(definition, triggerType) {
  const allowed = Array.isArray(definition.allowedTriggers) ? definition.allowedTriggers : null;
  if (!allowed || allowed.includes(triggerType)) return { allowed: true, reason: 'trigger_allowed' };
  return { allowed: false, reason: 'workflow_trigger_forbidden' };
}

function submissionDecision({ policy, definition, triggerType }) {
  const trigger = triggerDecision(definition, triggerType);
  if (!trigger.allowed) return trigger;
  if (definition.mutates === false || definition.allowInShadow === true || workflowIsLive(policy, definition.name)) {
    return { allowed: true, reason: workflowIsLive(policy, definition.name) ? 'workflow_live' : 'shadow_safe_workflow' };
  }
  return { allowed: false, reason: 'workflow_shadow_mode' };
}

function stepExecutionDecision({ policy, definition, step, creationSnapshot = null }) {
  const classification = effectClass(definition, step);
  if (!SAFE_IN_SHADOW.has(classification) && !EXTERNAL_MUTATIONS.has(classification)) {
    return { allowed: false, skip: false, reason: 'unknown_effect_class', effectClass: classification };
  }
  if (SAFE_IN_SHADOW.has(classification)) {
    return { allowed: true, reason: 'shadow_safe_effect', effectClass: classification };
  }

  const key = effectKey(definition, step);
  const allowedAtCreation = creationSnapshot !== null
    && (creationSnapshot.workflowLive === true
      || (Array.isArray(creationSnapshot.allowedEffects) && creationSnapshot.allowedEffects.includes(key)));
  const allowedNow = externalStepAllowed(policy, definition, step);
  if (allowedAtCreation && allowedNow) {
    return { allowed: true, reason: 'external_effect_live', effectClass: classification };
  }
  return {
    allowed: false,
    skip: definition.allowInShadow === true,
    reason: allowedAtCreation ? 'external_effect_killed' : 'external_effect_not_authorized_at_creation',
    effectClass: classification,
  };
}

module.exports = {
  EXTERNAL_MUTATIONS,
  SAFE_IN_SHADOW,
  alwaysOnEffects,
  effectClass,
  effectKey,
  externalStepAllowed,
  policySnapshot,
  reviewChannelId,
  stepExecutionDecision,
  submissionDecision,
  triggerDecision,
  workflowIsLive,
};
