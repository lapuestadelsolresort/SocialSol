'use strict';

const { sql } = require('@databases/sqlite');
const { monotonicTwilioStatus, normalizeTwilioEffectState } = require('../lib/twilio-whatsapp');

function validate(input) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const dmId = Number.parseInt(input.dmId, 10);
  const threadTs = typeof input.threadTs === 'string' ? input.threadTs.trim() : '';
  if (!message) throw new Error('WhatsApp reply message is required');
  if (!threadTs && (!Number.isSafeInteger(dmId) || dmId <= 0)) {
    throw new Error('a Slack thread timestamp or inbound WhatsApp message id is required');
  }
}

const definition = {
  name: 'whatsapp.reply',
  version: 3,
  capability: 'whatsapp.send',
  mutates: true,
  serializeMutations: true,
  allowedTriggers: ['slack_whatsapp_command'],
  // Twilio does not provide a create-message idempotency key. If the process
  // dies after Twilio accepts the request but before the SID is recorded,
  // automatic replay could send the guest a duplicate message.
  crashRecovery: 'manual',
  validate,
  steps: [
    {
      key: 'resolve_conversation',
      effectClass: 'read',
      maxAttempts: 1,
      async run({ db, input }) {
        const threadTs = typeof input.threadTs === 'string' ? input.threadTs.trim().slice(0, 64) : '';
        const dmId = Number.parseInt(input.dmId, 10);
        const rows = threadTs
          ? await db.query(sql`SELECT id, sender_id, sender_name, slack_thread_ts
              FROM meta_messages
              WHERE platform='whatsapp' AND slack_thread_ts=${threadTs} AND sender_id!='outbound'
              ORDER BY id DESC LIMIT 1`)
          : await db.query(sql`SELECT id, sender_id, sender_name, slack_thread_ts
              FROM meta_messages
              WHERE id=${dmId} AND platform='whatsapp' AND sender_id!='outbound'
              LIMIT 1`);
        if (!rows.length) {
          const error = new Error('No inbound WhatsApp conversation matches this Slack thread or message id');
          error.code = 'whatsapp_conversation_not_found';
          throw error;
        }
        const row = rows[0];
        return {
          dmId: row.id,
          phone: row.sender_id,
          senderName: row.sender_name || row.sender_id,
          threadTs: row.slack_thread_ts || threadTs || null,
        };
      },
    },
    {
      key: 'register_effect',
      effectClass: 'local_write',
      maxAttempts: 1,
      async run({ db, run, input, state, store, stepKey }) {
        const conversation = state.resolve_conversation;
        const effect = await store.createEffect(db, {
          runId: run.id,
          stepKey,
          effectType: 'message_delivery',
          provider: 'twilio',
          operation: 'whatsapp.send',
          idempotencyKey: `${run.id}:twilio:whatsapp.send`,
          request: { to: conversation.phone, body: input.message.trim() },
          target: {
            dmId: conversation.dmId,
            senderName: conversation.senderName,
            slackThreadTs: conversation.threadTs,
            actorUserId: run.actor_user_id,
            actorName: input.actorName || null,
          },
          verificationMode: 'callback_optional',
        });
        return { effectId: effect.id, status: effect.status };
      },
    },
    {
      key: 'send_via_twilio',
      effectClass: 'guest_message',
      maxAttempts: 1,
      async run({ db, run, input, state, services, store, stepKey }) {
        if (typeof services.sendWhatsApp !== 'function') throw new Error('Twilio WhatsApp service is unavailable');
        const conversation = state.resolve_conversation;
        const effectId = state.register_effect.effectId;
        const [existing] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${effectId}`);
        if (existing?.provider_ref && existing.status !== 'requested') {
          return { effectId, messageSid: existing.provider_ref, status: existing.status, replayed: true };
        }

        let result;
        try {
          result = await services.sendWhatsApp({
            toPhone: conversation.phone,
            message: input.message,
          });
        } catch (error) {
          if (error.code !== 'ambiguous_external_result') {
            await store.transitionEffect(db, {
              effectId,
              status: 'failed',
              providerStatus: 'request_failed',
              errorCode: error.code || 'twilio_send_failed',
              errorMessage: error.message,
            });
          }
          throw error;
        }

        const status = normalizeTwilioEffectState(result.status);
        try {
          await store.transitionEffect(db, {
            effectId,
            providerRef: result.sid,
            status,
            providerStatus: result.status || 'accepted',
            response: {
              sid: result.sid,
              status: result.status || null,
              errorCode: result.error_code || null,
              dateCreated: result.date_created || null,
            },
          });
        } catch (cause) {
          const error = new Error(`Twilio accepted ${result.sid}, but provider acceptance could not be committed locally: ${cause.message}`);
          error.code = 'ambiguous_external_result';
          error.retryable = false;
          error.cause = cause;
          throw error;
        }
        return { effectId, messageSid: result.sid, status, providerStatus: result.status || null, replayed: false };
      },
    },
    {
      key: 'persist_outbound_projection', effectClass: 'local_write', maxAttempts: 4,
      async run({ db, run, input, state, store, stepKey }) {
        const conversation = state.resolve_conversation;
        const send = state.send_via_twilio;
        const now = new Date().toISOString();
        const [currentEffect] = await db.query(sql`SELECT status, provider_status,
            error_code, error_message, delivered_at, read_at, failed_at, updated_at
          FROM workflow_effects WHERE id=${send.effectId} LIMIT 1`);
        const projectionStatus = monotonicTwilioStatus(send.status, currentEffect?.status || send.status);
        const projectionProviderStatus = currentEffect?.provider_status || send.providerStatus;
        const projectionSource = projectionStatus !== send.status
          ? 'twilio_status_callback' : 'twilio_send_response';
        try {
          await db.tx(async tx => {
            await tx.query(sql`INSERT OR IGNORE INTO meta_messages (
                platform, sender_id, sender_name, message_id, message_text, received_at,
                slack_thread_ts, raw_payload, direction, delivery_status,
                provider_delivery_status, provider_error_code, provider_error_message,
                delivery_status_source, delivered_at, read_at, failed_at,
                provider_status_updated_at, workflow_run_id, workflow_effect_id
              ) VALUES (
                'whatsapp', 'outbound', ${input.actorName || 'Staff'}, ${send.messageSid},
                ${input.message.trim()}, ${now}, ${conversation.threadTs},
                ${JSON.stringify({ reply_to_dm_id: conversation.dmId, twilio_sid: send.messageSid })},
                'outbound', ${projectionStatus}, ${projectionProviderStatus},
                ${currentEffect?.error_code || null}, ${currentEffect?.error_message || null},
                ${projectionSource}, ${currentEffect?.delivered_at || null},
                ${currentEffect?.read_at || null}, ${currentEffect?.failed_at || null},
                ${currentEffect?.updated_at || now}, ${run.id}, ${send.effectId}
              )`);
            await tx.query(sql`UPDATE meta_messages SET
                workflow_run_id=COALESCE(workflow_run_id, ${run.id}),
                workflow_effect_id=COALESCE(workflow_effect_id, ${send.effectId}),
                delivery_status=${projectionStatus},
                provider_delivery_status=COALESCE(provider_delivery_status, ${projectionProviderStatus}),
                provider_error_code=COALESCE(provider_error_code, ${currentEffect?.error_code || null}),
                provider_error_message=COALESCE(provider_error_message, ${currentEffect?.error_message || null}),
                delivery_status_source=COALESCE(delivery_status_source, ${projectionSource}),
                delivered_at=COALESCE(delivered_at, ${currentEffect?.delivered_at || null}),
                read_at=COALESCE(read_at, ${currentEffect?.read_at || null}),
                failed_at=COALESCE(failed_at, ${currentEffect?.failed_at || null}),
                provider_status_updated_at=COALESCE(provider_status_updated_at, ${currentEffect?.updated_at || now})
              WHERE platform='whatsapp' AND message_id=${send.messageSid}`);
            await store.recordEvent(tx, {
              runId: run.id,
              stepKey,
              type: 'outbound_projection_persisted',
              payload: { effectId: send.effectId, provider: 'twilio', providerRef: send.messageSid },
            });
          });
        } catch (error) {
          error.code = 'post_acceptance_persistence_failed';
          error.retryable = true;
          error.requiresManualReview = true;
          error.manualReviewReasonCode = 'post_acceptance_persistence_failed';
          throw error;
        }
        return { messageId: send.messageSid, persisted: true };
      },
    },
  ],
  output({ state }) {
    const conversation = state.resolve_conversation;
    const send = state.send_via_twilio;
    return {
      effectId: send.effectId,
      messageSid: send.messageSid,
      recipient: conversation.senderName,
      dmId: conversation.dmId,
      slackThreadTs: conversation.threadTs,
      status: send.status,
      providerStatus: send.providerStatus,
      deliveryConfirmed: ['delivered', 'read'].includes(send.status),
      readConfirmed: send.status === 'read',
    };
  },
};

module.exports = { definition, validate };
