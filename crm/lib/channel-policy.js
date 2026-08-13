'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'workflow', 'policy.json');

let cached = null;
let cachedPath = null;
let cachedMtime = -1;

function policyPath() {
  return path.resolve(process.env.RESORT_WORKFLOW_POLICY_PATH || DEFAULT_POLICY_PATH);
}

function validatePolicy(policy) {
  if (!policy || policy.version !== 1 || !policy.channels || typeof policy.channels !== 'object') {
    throw new Error('workflow policy must be a version 1 policy with channels');
  }
  for (const [channelId, channel] of Object.entries(policy.channels)) {
    if (!channelId || !Array.isArray(channel.capabilities)) {
      throw new Error(`invalid workflow policy channel: ${channelId || '<empty>'}`);
    }
  }
  for (const capability of ['ownerrez.write', 'marketing.write', 'email.send']) {
    const granted = Object.values(policy.channels)
      .some(channel => channel.capabilities.includes(capability));
    const restriction = policy.restricted_capabilities?.[capability];
    if (granted && (
      !restriction || !Array.isArray(restriction.users)
      || restriction.users.length === 0
      || restriction.users.some(userId => typeof userId !== 'string' || !userId.trim())
    )) {
      throw new Error(`workflow policy must restrict ${capability} to a non-empty user allowlist`);
    }
  }
  for (const field of ['live_workflows', 'autonomous_workflows', 'always_on_effects']) {
    if (policy[field] !== undefined && (
      !Array.isArray(policy[field]) || policy[field].some(value => typeof value !== 'string' || !value.trim())
    )) {
      throw new Error(`workflow policy ${field} must be an array of non-empty strings`);
    }
  }
  return policy;
}

function loadPolicy({ fresh = false } = {}) {
  const file = policyPath();
  const stat = fs.statSync(file);
  if (!fresh && cached && cachedPath === file && cachedMtime === stat.mtimeMs) return cached;
  const parsed = validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
  cached = parsed;
  cachedPath = file;
  cachedMtime = stat.mtimeMs;
  return parsed;
}

function authorizationDecision({ policy, capability, workflowName, context = {} }) {
  if (!capability) return { allowed: false, reason: 'workflow_has_no_capability' };

  if (context.origin === 'system') {
    const allowed = Array.isArray(policy.autonomous_workflows)
      && policy.autonomous_workflows.includes(workflowName);
    return { allowed, reason: allowed ? 'autonomous_workflow_allowlist' : 'autonomous_workflow_denied' };
  }

  if (context.origin !== 'slack' || context.originVerified !== true) {
    return { allowed: false, reason: 'unverified_origin' };
  }
  if (!context.channelId || !context.actorUserId) {
    return { allowed: false, reason: 'missing_slack_identity' };
  }

  const channel = policy.channels[context.channelId];
  if (!channel) return { allowed: false, reason: 'channel_not_allowlisted' };
  const broadRead = channel.capabilities.includes('business.read_all') && capability.endsWith('.read');
  if (!channel.capabilities.includes(capability) && !broadRead) {
    return { allowed: false, reason: 'capability_not_granted', channel: channel.name };
  }

  const restriction = policy.restricted_capabilities?.[capability];
  if (restriction) {
    const users = Array.isArray(restriction.users) ? restriction.users : [];
    if (!users.includes(context.actorUserId)) {
      return { allowed: false, reason: 'actor_not_allowlisted_for_restricted_capability', channel: channel.name };
    }
  }
  return { allowed: true, reason: 'channel_capability', channel: channel.name };
}

function authorize({ capability, workflowName, context, policy = loadPolicy() }) {
  const decision = authorizationDecision({ policy, capability, workflowName, context });
  if (!decision.allowed) {
    const error = new Error(`workflow authorization denied: ${decision.reason}`);
    error.code = 'workflow_forbidden';
    error.status = 403;
    error.decision = decision;
    throw error;
  }
  return decision;
}

module.exports = {
  DEFAULT_POLICY_PATH,
  authorizationDecision,
  authorize,
  loadPolicy,
  policyPath,
  validatePolicy,
};
