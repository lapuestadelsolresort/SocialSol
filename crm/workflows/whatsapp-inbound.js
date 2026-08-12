'use strict';

const { sql } = require('@databases/sqlite');
const { isMetaAttributed, sendVerifiedLead } = require('../lib/meta-capi');

function validate(input) {
  const messageId = Number.parseInt(input.messageId, 10);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new Error('valid inbound WhatsApp messageId is required');
  }
}

function parsePayload(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

async function findSession(db, messageText) {
  const refMatch = String(messageText || '').match(/\bLPDS-([A-Z0-9]{12,24})\b/i);
  const whatsappRef = refMatch ? refMatch[1].toUpperCase() : null;
  let [session] = whatsappRef ? await db.query(sql`
    SELECT id, page_slug, utm_source, utm_medium, utm_campaign, utm_content
    FROM page_sessions WHERE whatsapp_ref=${whatsappRef} LIMIT 1
  `) : [];
  let attributionMethod = session ? 'ref' : 'unattributed';

  if (!session && whatsappRef && whatsappRef.length >= 16) {
    const hex = whatsappRef.toLowerCase();
    const uuidPrefix = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}%`;
    [session] = await db.query(sql`
      SELECT id, page_slug, utm_source, utm_medium, utm_campaign, utm_content
      FROM page_sessions WHERE id LIKE ${uuidPrefix} ORDER BY created_at DESC LIMIT 1
    `);
    if (session) attributionMethod = 'session-id-prefix';
  }
  return { session: session || null, whatsappRef, attributionMethod };
}

const definition = {
  name: 'whatsapp.inbound.process',
  version: 2,
  capability: 'crm.write',
  mutates: true,
  autonomous: true,
  allowInShadow: true,
  validate,
  steps: [
    {
      key: 'load_message', effectClass: 'read', maxAttempts: 1,
      async run({ db, input }) {
        const [row] = await db.query(sql`SELECT id, sender_id, sender_name, message_id,
          message_text, raw_payload, received_at, processing_status, crm_lead_id,
          lead_created, attribution_method
          FROM meta_messages
          WHERE id=${Number(input.messageId)} AND platform='whatsapp' AND direction='inbound'`);
        if (!row) throw new Error('inbound WhatsApp message not found');
        return { ...row, rawPayload: parsePayload(row.raw_payload) };
      },
    },
    {
      key: 'sync_crm', effectClass: 'local_write', maxAttempts: 5,
      async run({ db, run, state, store, stepKey }) {
        const message = state.load_message;
        const effect = await store.createEffect(db, {
          runId: run.id,
          stepKey,
          effectType: 'local_record_write',
          provider: 'crm',
          operation: 'whatsapp_inbound.sync_lead',
          idempotencyKey: `${run.id}:crm:whatsapp_inbound.sync_lead`,
          request: {
            metaMessageId: message.id,
            providerMessageId: message.message_id,
            messageHash: store.sha256(message.message_text || ''),
          },
          target: { metaMessageId: message.id },
        });

        if (message.sender_id === '+10005551234') {
          await db.query(sql`UPDATE meta_messages SET processing_status='running',
            workflow_run_id=${run.id}, processing_error=NULL WHERE id=${message.id}`);
          const evidence = await store.createEvidence(db, {
            runId: run.id, stepKey, source: 'crm.meta_messages', sourceRef: String(message.id),
            payload: { metaMessageId: message.id, skipped: true, reason: 'test_sender' },
          });
          await store.transitionEffect(db, {
            effectId: effect.id, providerRef: String(message.id), status: 'verified_by_readback',
            providerStatus: 'test_sender_skipped', response: { evidenceId: evidence.id },
          });
          return { effectId: effect.id, evidenceId: evidence.id, skipped: true, verifiedLead: null };
        }

        const { session, whatsappRef, attributionMethod } = await findSession(db, message.message_text);
        const source = session && String(session.utm_source || '').toLowerCase() === 'meta'
          ? 'meta_ad' : 'whatsapp';
        const utmSource = session?.utm_source || 'whatsapp';
        const utmMedium = session?.utm_medium || 'direct';
        const utmCampaign = session?.utm_campaign || null;
        const campaignName = utmCampaign || session?.page_slug || null;
        const senderName = message.sender_name || message.rawPayload?.ProfileName || message.sender_id;

        let persisted;
        try {
          persisted = await db.tx(async tx => {
            const [current] = await tx.query(sql`SELECT crm_lead_id, lead_created
              FROM meta_messages WHERE id=${message.id}`);
            let leadId = current?.crm_lead_id || null;
            let leadCreated = Number(current?.lead_created || 0) === 1;
            if (!leadId) {
              const [{ n: beforeCount }] = await tx.query(sql`SELECT COUNT(*) n FROM leads
                WHERE phone=${message.sender_id}`);
              await tx.query(sql`INSERT INTO leads (
                  name, phone, source, campaign_name, status, inquiry_message, notes,
                  utm_source, utm_medium, utm_campaign
                ) SELECT
                  ${senderName}, ${message.sender_id}, ${source}, ${campaignName}, 'new',
                  ${String(message.message_text || '').slice(0, 500)},
                  ${`Auto-created from WhatsApp message on ${message.received_at}`},
                  ${utmSource}, ${utmMedium}, ${utmCampaign}
                WHERE NOT EXISTS (SELECT 1 FROM leads WHERE phone=${message.sender_id})`);
              const [lead] = await tx.query(sql`SELECT id FROM leads WHERE phone=${message.sender_id}
                ORDER BY id DESC LIMIT 1`);
              leadId = lead?.id || null;
              leadCreated = Number(beforeCount) === 0 && Boolean(leadId);
            }
            await tx.query(sql`UPDATE meta_messages SET crm_lead_id=${leadId},
              lead_created=${leadCreated ? 1 : 0}, attribution_method=${attributionMethod},
              processing_status='running', workflow_run_id=${run.id}, processing_error=NULL
              WHERE id=${message.id}`);
            if (session && leadId) {
              await tx.query(sql`UPDATE page_sessions SET lead_id=${leadId}, converted=1,
                last_seen=datetime('now') WHERE id=${session.id}`);
              if (leadCreated) {
                await tx.query(sql`INSERT INTO attribution_events (
                    session_id, lead_id, event_type, channel, campaign,
                    utm_source, utm_medium, utm_campaign, meta
                  ) SELECT
                    ${session.id}, ${leadId}, 'whatsapp_lead', 'whatsapp',
                    ${campaignName}, ${session.utm_source || null}, ${session.utm_medium || null},
                    ${session.utm_campaign || null},
                    ${JSON.stringify({ whatsapp_ref: whatsappRef, attribution_method: attributionMethod, message_id: message.message_id })}
                  WHERE NOT EXISTS (
                    SELECT 1 FROM attribution_events
                    WHERE event_type='whatsapp_lead'
                      AND json_extract(meta, '$.message_id')=${message.message_id}
                  )`);
              }
            }
            return { leadId, leadCreated };
          });
        } catch (error) {
          error.retryable = true;
          throw error;
        }

        const verifiedLead = persisted.leadCreated && isMetaAttributed({ utmSource, utmMedium, utmCampaign })
          ? {
              eventId: `twilio-${message.message_id || message.id}`,
              eventTime: message.received_at,
              phone: message.sender_id,
              campaign: campaignName,
              utmSource,
              utmMedium,
              utmCampaign,
              pageSlug: session?.page_slug || null,
            }
          : null;
        const readback = {
          metaMessageId: message.id,
          leadId: persisted.leadId,
          leadCreated: persisted.leadCreated,
          attributionMethod,
          conversionEligible: Boolean(verifiedLead),
        };
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'crm.leads+meta_messages',
          sourceRef: String(message.id), payload: readback,
        });
        await store.transitionEffect(db, {
          effectId: effect.id, providerRef: String(message.id), status: 'verified_by_readback',
          providerStatus: 'crm_lead_readback_verified', response: { evidenceId: evidence.id },
        });
        return { ...readback, verifiedLead, effectId: effect.id, evidenceId: evidence.id };
      },
    },
    {
      key: 'send_conversion', effectClass: 'external_idempotent', maxAttempts: 8,
      async run({ db, run, state, store, stepKey }) {
        const lead = state.sync_crm.verifiedLead;
        if (!lead) return { skipped: true, reason: 'not_new_meta_attributed_lead' };
        const effect = await store.createEffect(db, {
          runId: run.id, stepKey, effectType: 'conversion_event', provider: 'meta-capi',
          operation: 'Lead', idempotencyKey: `${run.id}:meta-capi:${lead.eventId}`,
          request: { ...lead, phone: store.sha256(lead.phone) },
          target: { eventId: lead.eventId },
        });
        try {
          const result = await sendVerifiedLead({ db, sql, ...lead });
          const evidence = await store.createEvidence(db, {
            runId: run.id, stepKey, source: 'crm.conversion_deliveries',
            sourceRef: lead.eventId,
            payload: { eventId: lead.eventId, ok: result.ok === true, deduplicated: result.deduplicated === true },
          });
          await store.transitionEffect(db, {
            effectId: effect.id, providerRef: lead.eventId, status: 'verified_by_readback',
            providerStatus: result.deduplicated ? 'provider_event_deduplicated' : 'provider_event_recorded',
            response: { evidenceId: evidence.id },
          });
          return { effectId: effect.id, evidenceId: evidence.id, delivered: true };
        } catch (error) {
          error.retryable = true;
          throw error;
        }
      },
    },
    {
      key: 'mark_processed', effectClass: 'local_write', maxAttempts: 3,
      async run({ db, run, state, store, stepKey }) {
        const messageId = state.load_message.id;
        await db.query(sql`UPDATE meta_messages SET processing_status='completed',
          processed_at=datetime('now'), processing_error=NULL, workflow_run_id=${run.id}
          WHERE id=${messageId}`);
        const [row] = await db.query(sql`SELECT id, processing_status, crm_lead_id,
          lead_created, attribution_method, workflow_run_id FROM meta_messages WHERE id=${messageId}`);
        if (!row || row.processing_status !== 'completed' || row.workflow_run_id !== run.id) {
          const error = new Error('WhatsApp inbound processing readback failed');
          error.retryable = true;
          throw error;
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'crm.meta_messages', sourceRef: String(messageId), payload: row,
        });
        return { messageId, evidenceId: evidence.id, leadId: row.crm_lead_id, status: 'verified_by_readback' };
      },
    },
  ],
  output({ state }) {
    return {
      messageId: state.mark_processed.messageId,
      leadId: state.mark_processed.leadId,
      effectId: state.sync_crm.effectId,
      evidenceId: state.mark_processed.evidenceId,
      conversion: state.send_conversion,
      status: 'verified_by_readback',
    };
  },
};

module.exports = { definition, findSession, parsePayload, validate };
