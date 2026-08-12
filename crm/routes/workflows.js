'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { sql } = require('@databases/sqlite');
const { authorize, loadPolicy } = require('../lib/channel-policy');
const { createRun, getRun, resolveManualReview } = require('../lib/workflow-store');
const { policySnapshot, submissionDecision } = require('../lib/workflow-execution-policy');
const { loadControlToken } = require('../lib/workflow-auth');
const { getDefinition, listDefinitions } = require('../workflows/registry');

function isLoopback(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');
}

function requireLoopback(req, res, next) {
  if (isLoopback(req)) return next();
  return res.status(403).json({ error: 'workflow control plane is local-only' });
}

function tokenMatches(expected, supplied) {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function requireControlToken(expectedToken) {
  return (req, res, next) => {
    const authorization = String(req.headers.authorization || '');
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (tokenMatches(expectedToken, supplied)) return next();
    return res.status(401).json({ error: 'valid workflow control-plane token required' });
  };
}

function safeEffect(effect) {
  return {
    id: effect.id,
    effect_type: effect.effect_type,
    provider: effect.provider,
    operation: effect.operation,
    provider_ref: effect.provider_ref,
    status: effect.status,
    provider_status: effect.provider_status,
    requested_at: effect.requested_at,
    accepted_at: effect.accepted_at,
    sent_at: effect.sent_at,
    delivered_at: effect.delivered_at,
    read_at: effect.read_at,
    verified_at: effect.verified_at,
    failed_at: effect.failed_at,
    error_code: effect.error_code,
    error_message: effect.error_message,
  };
}

function safeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    workflow_name: run.workflow_name,
    workflow_version: run.workflow_version,
    status: run.status,
    trigger_type: run.trigger_type,
    trigger_ref: run.trigger_ref,
    channel_id: run.channel_id,
    actor_user_id: run.actor_user_id,
    output: run.output,
    current_step: run.current_step,
    error_code: run.error_code,
    error_message: run.error_message,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
    steps: run.steps.map(step => ({
      step_key: step.step_key,
      ordinal: step.ordinal,
      status: step.status,
      attempts: step.attempts,
      max_attempts: step.max_attempts,
      available_at: step.available_at,
      error_code: step.error_code,
      error_message: step.error_message,
      started_at: step.started_at,
      completed_at: step.completed_at,
    })),
    effects: run.effects.map(safeEffect),
    manual_reviews: (run.manualReviews || []).map(review => ({
      id: review.id,
      step_key: review.step_key,
      effect_id: review.effect_id,
      reason_code: review.reason_code,
      reason_message: review.reason_message,
      status: review.status,
      created_at: review.created_at,
      resolved_at: review.resolved_at,
    })),
  };
}

function buildRouter(getDb, services = {}) {
  const router = express.Router();
  const controlToken = services.controlPlaneToken || loadControlToken();
  router.use(requireLoopback);
  router.use(requireControlToken(controlToken));

  router.get('/definitions', (_req, res) => {
    const policy = loadPolicy();
    res.json({
      definitions: listDefinitions(),
      shadow_mode: policy.shadow_mode === true,
      live_workflows: Array.isArray(policy.live_workflows) ? policy.live_workflows : [],
    });
  });

  router.get('/runs/:id', async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const run = await getRun(db, String(req.params.id));
    if (!run) return res.status(404).json({ error: 'workflow run not found' });
    return res.json({ run: safeRun(run) });
  });

  router.post('/manual-reviews/:id/resolve', express.json({ limit: '16kb' }), async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const supplied = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};
    const actorUserId = typeof supplied.actor_user_id === 'string' ? supplied.actor_user_id : '';
    const channelId = typeof supplied.channel_id === 'string' ? supplied.channel_id : '';
    const policy = loadPolicy({ fresh: true });
    const reviewers = Array.isArray(policy.write_notifications?.user_ids)
      ? policy.write_notifications.user_ids : [];
    const [reviewContext] = await db.query(sql`SELECT mr.id, mr.review_channel_id, r.channel_id
      FROM workflow_manual_reviews mr JOIN workflow_runs r ON r.id=mr.run_id
      WHERE mr.id=${String(req.params.id)}`);
    if (!reviewContext) return res.status(404).json({ error: 'manual review was not found' });
    const configuredReviewChannels = Array.isArray(policy.write_notifications?.channel_ids)
      ? policy.write_notifications.channel_ids : [];
    const permittedChannels = new Set([
      ...(reviewContext.channel_id ? [reviewContext.channel_id] : []),
      ...(reviewContext.review_channel_id ? [reviewContext.review_channel_id] : []),
      ...configuredReviewChannels,
    ]);
    if (
      supplied.entrypoint !== 'slack_manual_review_command'
      || !reviewers.includes(actorUserId) || !policy.channels?.[channelId]
      || !permittedChannels.has(channelId)
    ) {
      return res.status(403).json({ error: 'manual review resolution requires an authorized human in a controlled channel' });
    }
    try {
      const review = await resolveManualReview(db, {
        reviewId: String(req.params.id),
        resolution: String(req.body?.resolution || ''),
        providerRef: typeof req.body?.provider_ref === 'string' ? req.body.provider_ref.trim().slice(0, 160) : null,
        resolvedBy: actorUserId,
      });
      return res.json({ review: {
        id: review.id, run_id: review.run_id, effect_id: review.effect_id,
        status: review.status, resolution: review.resolution,
        provider_ref: review.resolution_provider_ref, resolved_at: review.resolved_at,
      } });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return res.status(status).json({ error: error.message, code: error.code || 'manual_review_resolution_failed' });
    }
  });

  router.post('/execute', express.json({ limit: '64kb' }), async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const body = req.body || {};
    const definition = getDefinition(String(body.workflow || ''));
    if (!definition) return res.status(404).json({ error: 'unknown workflow' });
    const idempotencyKey = typeof body.idempotency_key === 'string'
      ? body.idempotency_key.trim().slice(0, 300)
      : '';
    if (!idempotencyKey) return res.status(400).json({ error: 'idempotency_key is required' });

    // Identity comes from the trusted OpenClaw plugin tool factory, not from
    // model-generated workflow parameters. This route is additionally local-only.
    const supplied = body.context && typeof body.context === 'object' ? body.context : {};
    const context = {
      origin: supplied.origin === 'system' ? 'system' : 'slack',
      originVerified: supplied.origin !== 'system',
      channelId: typeof supplied.channel_id === 'string' ? supplied.channel_id : null,
      actorUserId: typeof supplied.actor_user_id === 'string' ? supplied.actor_user_id : null,
    };
    const entrypoint = context.origin === 'system'
      ? 'system'
      : (typeof supplied.entrypoint === 'string' ? supplied.entrypoint : 'model_tool');

    try {
      const policy = loadPolicy();
      const submission = submissionDecision({ policy, definition, triggerType: entrypoint });
      if (!submission.allowed) {
        const status = submission.reason === 'workflow_trigger_forbidden' ? 403 : 409;
        return res.status(status).json({
          error: submission.reason === 'workflow_trigger_forbidden'
            ? 'workflow cannot be invoked from this entrypoint'
            : 'workflow is in shadow mode; no production mutation was queued',
          code: submission.reason,
        });
      }
      const decision = authorize({
        capability: definition.capability,
        workflowName: definition.name,
        context,
      });
      if (typeof definition.validate === 'function') {
        definition.validate(body.input && typeof body.input === 'object' ? body.input : {});
      }
      const created = await createRun(db, {
        definition,
        idempotencyKey,
        triggerType: entrypoint,
        triggerRef: typeof supplied.message_id === 'string' ? supplied.message_id : null,
        channelId: context.channelId,
        actorUserId: context.actorUserId,
        input: body.input && typeof body.input === 'object' ? body.input : {},
        policySnapshot: policySnapshot(policy, definition),
      });
      const run = created.run;
      const status = run.status === 'completed' ? 200 : (run.status === 'failed' ? 500 : 202);
      return res.status(status).json({
        authorization: decision.reason,
        queued: created.created,
        run: safeRun(run),
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return res.status(status).json({ error: error.message, code: error.code || 'workflow_request_failed' });
    }
  });

  return router;
}

module.exports = {
  buildRouter,
  isLoopback,
  requireControlToken,
  requireLoopback,
  safeEffect,
  safeRun,
  tokenMatches,
};
