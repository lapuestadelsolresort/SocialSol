'use strict';

// Policy↔registry autonomy agreement (F-024).
//
// `workflow/policy.json` can grant system-origin execution
// (`autonomous_workflows`) and per-operation auto-confirmation
// (`autonomous_operations`) to any workflow name — the file is runtime state,
// hand-editable, and invisible to CI. The registry is where a workflow
// declares what it was designed for: `autonomous: true` for workflows meant
// to run on their own, or an `auto_confirm_dispatch` entry in
// `allowedTriggers` for confirm workflows built for policy-armed dispatch
// (the D-019 arming procedure adds those to `autonomous_workflows` with no
// registry edit, which is why the trigger declaration counts as agreement).
//
// A grant with neither declaration is unaccounted: nothing in reviewed code
// says the workflow was built to run without a human. This module refuses
// exactly those grants — at every system-origin authorization site and when
// blessing a policy fingerprint — without constraining `live_workflows`:
// autonomous-but-shadowed is a sanctioned staging shape, and read workflows
// never appear in `live_workflows` at all.
//
// Deliberately dependency-free: callers that need the whole registry pass
// `listDefinitions()` themselves, so requiring this module never drags the
// CRM stack into a process that only holds one definition.

const AUTO_CONFIRM_TRIGGER = 'auto_confirm_dispatch';

function allowedTriggersOf(definition) {
  const triggers = definition?.allowedTriggers ?? definition?.allowed_triggers;
  return Array.isArray(triggers) ? triggers : [];
}

/** True when the registry definition accounts for a system-origin grant. */
function systemOriginAccounted(definition) {
  if (!definition) return false;
  return definition.autonomous === true || allowedTriggersOf(definition).includes(AUTO_CONFIRM_TRIGGER);
}

function assertSystemOriginAccounted(definition) {
  if (systemOriginAccounted(definition)) return;
  const error = new Error(`workflow authorization denied: autonomy_not_registry_accounted — the policy grants system-origin execution to ${definition?.name || '<unknown>'}, but its registry definition neither declares \`autonomous: true\` nor accepts \`${AUTO_CONFIRM_TRIGGER}\``);
  error.code = 'workflow_forbidden';
  error.status = 403;
  error.decision = { allowed: false, reason: 'autonomy_not_registry_accounted' };
  throw error;
}

/**
 * Every way the policy's autonomy grants can disagree with the registry.
 * `definitions` is the full definition list (registry objects or
 * `listDefinitions()` summaries — both trigger spellings are understood).
 *
 * @returns {string[]} human-readable violations; empty means agreement.
 */
function policyRegistryAgreementViolations(policy, definitions) {
  const byName = new Map((definitions || []).map(definition => [definition.name, definition]));
  const violations = [];
  const autonomous = Array.isArray(policy?.autonomous_workflows) ? policy.autonomous_workflows : [];
  const operations = policy?.autonomous_operations && typeof policy.autonomous_operations === 'object'
    && !Array.isArray(policy.autonomous_operations) ? policy.autonomous_operations : {};

  for (const name of autonomous) {
    const definition = byName.get(name);
    if (!definition) {
      violations.push(`autonomous_workflows lists ${name}, which is not in the registry`);
      continue;
    }
    if (!systemOriginAccounted(definition)) {
      violations.push(`autonomous_workflows lists ${name}, but its registry definition neither declares autonomy nor accepts ${AUTO_CONFIRM_TRIGGER}`);
    }
  }

  for (const name of Object.keys(operations)) {
    const definition = byName.get(name);
    if (!definition) violations.push(`autonomous_operations lists ${name}, which is not in the registry`);
    else if (!allowedTriggersOf(definition).includes(AUTO_CONFIRM_TRIGGER)) {
      violations.push(`autonomous_operations lists ${name}, whose registry definition does not accept ${AUTO_CONFIRM_TRIGGER} — the per-operation arming can never dispatch`);
    }
    if (!autonomous.includes(name)) {
      violations.push(`autonomous_operations lists ${name}, which is not in autonomous_workflows — the per-operation arming is unreachable`);
    }
  }

  return violations;
}

function assertPolicyRegistryAgreement(policy, definitions) {
  const violations = policyRegistryAgreementViolations(policy, definitions);
  if (violations.length) {
    throw new Error(`workflow policy disagrees with the registry:\n  - ${violations.join('\n  - ')}`);
  }
}

module.exports = {
  AUTO_CONFIRM_TRIGGER,
  systemOriginAccounted,
  assertSystemOriginAccounted,
  policyRegistryAgreementViolations,
  assertPolicyRegistryAgreement,
};
