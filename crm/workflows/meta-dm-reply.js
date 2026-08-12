'use strict';

const { sql } = require('@databases/sqlite');
const { sendMetaDm } = require('../lib/meta-dm');

function validate(input) {
  const dmId = Number.parseInt(input.dmId, 10);
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!Number.isSafeInteger(dmId) || dmId <= 0) throw new Error('valid Meta dmId is required');
  if (!message || message.length > 2000) throw new Error('Meta reply must contain 1–2000 characters');
}

const definition = {
  name: 'meta.dm.reply',
  version: 2,
  capability: 'social.write',
  mutates: true,
  serializeMutations: true,
  notificationChannelName: 'social-sol',
  crashRecovery: 'manual',
  allowedTriggers: ['slack_meta_dm_command'],
  validate,
  steps: [
    {
      key: 'resolve_conversation', effectClass: 'read', maxAttempts: 1,
      async run({ db, input }) {
        const [row] = await db.query(sql`SELECT id, platform, sender_id, sender_name
          FROM meta_messages WHERE id=${Number(input.dmId)}
            AND platform IN ('instagram','page') AND sender_id!='outbound' LIMIT 1`);
        if (!row) throw new Error('Meta DM conversation was not found');
        return row;
      },
    },
    {
      key: 'register_effect', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, input, state, store, stepKey }) {
        const conversation = state.resolve_conversation;
        const effect = await store.createEffect(db, {
          runId: run.id,
          stepKey,
          effectType: 'message_delivery',
          provider: 'meta',
          operation: `${conversation.platform}.message.send`,
          idempotencyKey: `${run.id}:meta:dm.reply`,
          request: {
            dmId: conversation.id,
            recipientId: conversation.sender_id,
            bodyHash: store.sha256(input.message.trim()),
          },
          target: {
            dmId: conversation.id,
            recipientName: conversation.sender_name,
            actorUserId: run.actor_user_id,
          },
          verificationMode: 'provider_acceptance',
        });
        return { effectId: effect.id };
      },
    },
    {
      key: 'send_via_meta', effectClass: 'external_non_idempotent', maxAttempts: 1,
      async run({ db, input, state, services, store }) {
        const conversation = state.resolve_conversation;
        const effectId = state.register_effect.effectId;
        const [existing] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${effectId}`);
        if (existing?.provider_ref && existing.status !== 'requested') {
          return { effectId, messageId: existing.provider_ref, status: existing.status, replayed: true };
        }
        let result;
        try {
          const sender = services.sendMetaDm || sendMetaDm;
          result = await sender({
            platform: conversation.platform,
            recipientId: conversation.sender_id,
            message: input.message,
          });
        } catch (error) {
          if (error.code !== 'ambiguous_external_result') {
            await store.transitionEffect(db, {
              effectId,
              status: 'failed',
              providerStatus: 'request_rejected',
              errorCode: error.code || 'meta_send_failed',
              errorMessage: error.message,
            });
          }
          throw error;
        }
        try {
          await store.transitionEffect(db, {
            effectId,
            providerRef: result.message_id,
            status: 'accepted_by_provider',
            providerStatus: 'accepted',
            response: { messageId: result.message_id },
          });
        } catch (cause) {
          const error = new Error(`Meta accepted ${result.message_id}, but provider acceptance could not be committed locally: ${cause.message}`);
          error.code = 'ambiguous_external_result';
          error.retryable = false;
          error.cause = cause;
          throw error;
        }
        return { effectId, messageId: result.message_id, status: 'accepted_by_provider', replayed: false };
      },
    },
    {
      key: 'persist_outbound_projection', effectClass: 'local_write', maxAttempts: 4,
      async run({ db, run, input, state, store, stepKey }) {
        const conversation = state.resolve_conversation;
        const send = state.send_via_meta;
        const now = new Date().toISOString();
        try {
          await db.tx(async tx => {
            await tx.query(sql`INSERT OR IGNORE INTO meta_messages
              (platform, sender_id, sender_name, message_id, message_text, received_at,
               raw_payload, direction, delivery_status, provider_status_updated_at,
               workflow_run_id, workflow_effect_id)
              VALUES (${conversation.platform}, 'outbound', ${input.actorName || 'Staff'},
                ${send.messageId}, ${input.message.trim()}, ${now},
                ${JSON.stringify({ reply_to_dm_id: conversation.id, meta_message_id: send.messageId })},
                'outbound', 'accepted_by_provider', ${now}, ${run.id}, ${send.effectId})`);
            await tx.query(sql`UPDATE meta_messages SET
                workflow_run_id=COALESCE(workflow_run_id, ${run.id}),
                workflow_effect_id=COALESCE(workflow_effect_id, ${send.effectId}),
                delivery_status=COALESCE(delivery_status, 'accepted_by_provider'),
                provider_status_updated_at=COALESCE(provider_status_updated_at, ${now})
              WHERE platform=${conversation.platform} AND message_id=${send.messageId}`);
            await store.recordEvent(tx, {
              runId: run.id,
              stepKey,
              type: 'outbound_projection_persisted',
              payload: { effectId: send.effectId, provider: 'meta', providerRef: send.messageId },
            });
          });
        } catch (error) {
          error.code = 'post_acceptance_persistence_failed';
          error.retryable = true;
          error.requiresManualReview = true;
          error.manualReviewReasonCode = 'post_acceptance_persistence_failed';
          throw error;
        }
        return { messageId: send.messageId, persisted: true };
      },
    },
  ],
  output({ state }) {
    return {
      recipient: state.resolve_conversation.sender_name || state.resolve_conversation.sender_id,
      platform: state.resolve_conversation.platform,
      effectId: state.register_effect.effectId,
      messageId: state.send_via_meta.messageId,
      status: state.send_via_meta.status,
    };
  },
};

module.exports = { definition, validate };
