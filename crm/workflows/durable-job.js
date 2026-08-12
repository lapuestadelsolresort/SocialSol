'use strict';

const { loadPolicy } = require('../lib/channel-policy');

function lastJsonValue(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines.slice(index).join('\n')); } catch {}
  }
  return null;
}

function notificationTargets(run, definition) {
  const policy = loadPolicy();
  const users = Array.isArray(policy.write_notifications?.user_ids)
    ? policy.write_notifications.user_ids.filter(Boolean)
    : [];
  const configuredChannels = Array.isArray(policy.write_notifications?.channel_ids)
    ? policy.write_notifications.channel_ids.filter(Boolean)
    : [];
  const namedChannelId = definition.notificationChannelName
    ? Object.entries(policy.channels || {}).find(([, channel]) => channel.name === definition.notificationChannelName)?.[0]
    : null;
  const channels = new Set([
    ...(run.channel_id ? [run.channel_id] : []),
    ...(definition.notificationChannelId ? [definition.notificationChannelId] : []),
    ...(namedChannelId ? [namedChannelId] : []),
    ...configuredChannels,
  ]);
  return { users, channels: [...channels] };
}

function makeDurableJob(options) {
  const {
    name,
    version = 2,
    capability,
    effectType = 'external_mutation',
    provider,
    operation = name,
    validate = () => {},
    requestSummary = input => input,
    buildCommand,
    verify,
    summarize = ({ command, verification }) => ({ command, verification }),
    autonomous = false,
    notifyOnWrite = true,
    notificationChannelId = null,
    notificationChannelName = null,
    shouldNotify = () => true,
    buildNotificationMessage = null,
  } = options;
  if (!name || !capability || !provider || typeof buildCommand !== 'function' || typeof verify !== 'function') {
    throw new Error('invalid durable job definition');
  }

  const definition = {
    name,
    version,
    capability,
    mutates: true,
    autonomous,
    crashRecovery: 'manual',
    notificationChannelId,
    notificationChannelName,
    validate,
    steps: [
      {
        key: 'register_effect',
        effectClass: 'local_write',
        maxAttempts: 1,
        async run({ db, run, input, store, stepKey }) {
          const effect = await store.createEffect(db, {
            runId: run.id,
            stepKey,
            effectType,
            provider,
            operation,
            idempotencyKey: `${run.id}:${provider}:${operation}`,
            request: requestSummary(input),
            target: { channelId: run.channel_id, actorUserId: run.actor_user_id },
          });
          return { effectId: effect.id, status: effect.status };
        },
      },
      {
        key: 'execute',
        effectClass: 'external_non_idempotent',
        maxAttempts: 1,
        async run({ db, run, input, state, services, store, stepKey }) {
          if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
          const effectId = state.register_effect.effectId;
          const [effect] = await db.query(require('@databases/sqlite').sql`SELECT * FROM workflow_effects WHERE id=${effectId}`);
          if (effect?.provider_ref && effect.status !== 'requested') {
            return { effectId, providerRef: effect.provider_ref, status: effect.status, replayed: true };
          }
          const command = buildCommand({ input, run, shadowMode: services.shadowMode === true });
          let result;
          try {
            result = await services.runCommand(command);
          } catch (error) {
            error.code = 'ambiguous_external_result';
            error.retryable = false;
            throw error;
          }
          const providerRef = `job:${run.id}`;
          await store.transitionEffect(db, {
            effectId,
            providerRef,
            status: 'accepted_by_provider',
            providerStatus: 'process_exit_0',
            response: {
              exitCode: result.exitCode,
              stdoutHash: store.sha256(result.stdout),
              stderrHash: store.sha256(result.stderr),
            },
          });
          await store.createEvidence(db, {
            runId: run.id,
            stepKey,
            source: `${provider}.command`,
            sourceRef: providerRef,
            payload: {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            },
          });
          return {
            effectId,
            providerRef,
            status: 'accepted_by_provider',
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            parsed: lastJsonValue(result.stdout),
            replayed: false,
          };
        },
      },
      {
        key: 'verify_readback',
        effectClass: 'external_read',
        maxAttempts: 3,
        async run({ db, run, input, state, services, store, stepKey }) {
          const verification = await verify({ db, run, input, state, services, lastJsonValue });
          if (!verification || verification.verified !== true) {
            const error = new Error(verification?.reason || 'external mutation could not be verified by readback');
            error.code = 'readback_not_verified';
            error.retryable = verification?.retryable === true;
            throw error;
          }
          const evidence = await store.createEvidence(db, {
            runId: run.id,
            stepKey,
            source: verification.source || `${provider}.readback`,
            sourceRef: verification.sourceRef || state.execute.providerRef,
            observedAt: verification.observedAt,
            expiresAt: verification.expiresAt || null,
            confidence: verification.confidence ?? 1,
            payload: verification.evidence || verification,
          });
          await store.transitionEffect(db, {
            effectId: state.register_effect.effectId,
            status: 'verified_by_readback',
            providerStatus: verification.providerStatus || 'verified',
            response: {
              verificationEvidenceId: evidence.id,
              verificationPayloadHash: evidence.payloadHash,
            },
          });
          return { ...verification, evidenceId: evidence.id, evidencePayloadHash: evidence.payloadHash };
        },
      },
      ...(notifyOnWrite ? [{
        key: 'notify_humans',
        effectClass: 'internal_notification',
        maxAttempts: 1,
        async run({ db, run, state, store }) {
          const notify = await shouldNotify({ run, state, name, provider });
          if (!notify) return { queued: 0, reason: 'verified no-op notification suppressed' };
          const targets = notificationTargets(run, definition);
          if (!targets.channels.length) return { queued: 0, reason: 'no notification channel configured' };
          const mentions = targets.users.map(userId => `<@${userId}>`).join(' ');
          const detail = typeof buildNotificationMessage === 'function'
            ? await buildNotificationMessage({ run, state, name, provider })
            : `${name} wrote through ${provider} and was verified by readback. Workflow ${run.id}.`;
          if (typeof detail !== 'string' || !detail.trim()) {
            throw new Error(`${name} notification message was empty`);
          }
          const message = `${mentions ? `${mentions} ` : ''}${detail.trim()}`;
          for (const channelId of targets.channels) {
            await store.enqueueOutbox(db, {
              runId: run.id,
              topic: 'slack.notification',
              idempotencyKey: `${run.id}:write-notification:${channelId}`,
              payload: { channelId, message },
            });
          }
          return { queued: targets.channels.length, channels: targets.channels };
        },
      }] : []),
    ],
    output({ state }) {
      return {
        effectId: state.register_effect.effectId,
        status: 'verified_by_readback',
        evidenceId: state.verify_readback.evidenceId,
        ...summarize({ command: state.execute, verification: state.verify_readback, notification: state.notify_humans }),
      };
    },
  };
  return definition;
}

module.exports = { lastJsonValue, makeDurableJob, notificationTargets };
