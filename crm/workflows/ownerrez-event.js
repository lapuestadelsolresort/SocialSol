'use strict';

const { sql } = require('@databases/sqlite');
const { nodeCommand } = require('../lib/workflow-command');
const { loadPolicy } = require('../lib/channel-policy');

function lastJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function validate(input) {
  const eventId = Number.parseInt(input.eventId, 10);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('valid OwnerRez eventId is required');
}

function channelId(name) {
  return Object.entries(loadPolicy().channels || {}).find(([, value]) => value.name === name)?.[0] || null;
}

function eventNotification(eventType, event) {
  const lower = eventType.toLowerCase();
  if (lower.includes('booking') && (lower.includes('creat') || lower === 'booking')) {
    const guestName = event.guest?.name || event.data?.guest_name || '';
    const arrival = event.arrival || event.data?.arrival || '?';
    const departure = event.departure || event.data?.departure || '?';
    const property = event.property?.name || event.data?.property_name || 'property';
    const summary = `New OwnerRez booking — ${guestName || 'guest'}, ${property}, ${arrival} → ${departure}.`;
    return [
      { channel: 'business-intel', message: `📥 *${summary}*` },
      { channel: 'reservations', message: `🏨 *New Reservation / Nueva Reservación*\n${property}: ${arrival} → ${departure}${guestName ? `\nGuest / Huésped: ${guestName}` : ''}` },
    ];
  }
  if (lower.includes('inquiry') && (lower.includes('creat') || lower === 'inquiry')) {
    const site = event.listing_site || event.data?.listing_site || 'unknown source';
    return [{ channel: 'business-intel', message: `💬 *New OwnerRez inquiry* from ${site}.` }];
  }
  return [];
}

const definition = {
  name: 'ownerrez.webhook.process',
  version: 1,
  capability: 'crm.write',
  mutates: true,
  autonomous: true,
  validate,
  steps: [
    {
      key: 'load_event', maxAttempts: 1,
      async run({ db, input }) {
        const [row] = await db.query(sql`SELECT id, event_type, payload, payload_hash,
          received_at, processed, processing_status FROM ownerrez_events WHERE id=${Number(input.eventId)}`);
        if (!row) throw new Error('OwnerRez event not found');
        let event;
        try { event = JSON.parse(row.payload); } catch { throw new Error('OwnerRez event payload is invalid JSON'); }
        return { ...row, event };
      },
    },
    {
      key: 'register_effect', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        const effect = await store.createEffect(db, {
          runId: run.id, stepKey, effectType: 'source_sync', provider: 'ownerrez',
          operation: 'webhook.sync_to_crm', idempotencyKey: `${run.id}:ownerrez:webhook.sync_to_crm`,
          request: { eventId: state.load_event.id, eventType: state.load_event.event_type, payloadHash: state.load_event.payload_hash },
          target: { eventId: state.load_event.id },
        });
        await db.query(sql`UPDATE ownerrez_events SET processing_status='running', workflow_run_id=${run.id},
          processing_error=NULL WHERE id=${state.load_event.id}`);
        return { effectId: effect.id };
      },
    },
    {
      key: 'sync_crm', maxAttempts: 3,
      async run({ db, run, state, services, store, stepKey }) {
        const event = state.load_event;
        const since = new Date(Math.max(0, new Date(event.received_at).getTime() - 60 * 60_000)).toISOString();
        const result = await services.runCommand(nodeCommand('crm/scripts/ownerrez-sync.js', ['--since', since], {
          env: { WORKFLOW_MANAGED: '1' }, timeoutMs: 20 * 60_000,
        }));
        const summary = lastJson(result.stdout);
        if (!summary || typeof summary.inquiries !== 'number' || typeof summary.bookings !== 'number') {
          const error = new Error('OwnerRez CRM sync did not emit a verifiable summary');
          error.retryable = true;
          throw error;
        }
        let messageIngest = null;
        if (String(event.event_type).includes('message')) {
          const ingest = await services.runCommand(nodeCommand('crm/scripts/ownerrez-message-ingest.js', [], {
            timeoutMs: 20 * 60_000,
          }));
          messageIngest = lastJson(ingest.stdout);
          if (!messageIngest) throw new Error('OwnerRez message ingest did not emit a verifiable summary');
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'ownerrez.api+crm.readback',
          sourceRef: String(event.id), payload: { eventPayloadHash: event.payload_hash, summary, messageIngest },
        });
        await store.transitionEffect(db, {
          effectId: state.register_effect.effectId, providerRef: String(event.id),
          status: 'verified_by_readback', providerStatus: 'crm_sync_verified',
          response: { evidenceId: evidence.id, summary },
        });
        await db.query(sql`UPDATE ownerrez_events SET processed=1, processed_at=datetime('now'),
          processing_status='completed', processing_error=NULL WHERE id=${event.id}`);
        return { summary, messageIngest, evidenceId: evidence.id };
      },
    },
    {
      key: 'notify_channels', maxAttempts: 1,
      async run({ db, run, state, store }) {
        const notifications = eventNotification(state.load_event.event_type, state.load_event.event);
        let queued = 0;
        for (const notification of notifications) {
          const target = channelId(notification.channel);
          if (!target) continue;
          await store.enqueueOutbox(db, {
            runId: run.id, topic: 'slack.notification',
            idempotencyKey: `${run.id}:ownerrez-notification:${target}`,
            payload: { channelId: target, message: `${notification.message}\nVerified workflow: ${run.id}` },
          });
          queued += 1;
        }
        return { queued };
      },
    },
  ],
  output({ state }) {
    return {
      eventId: state.load_event.id,
      effectId: state.register_effect.effectId,
      evidenceId: state.sync_crm.evidenceId,
      status: 'verified_by_readback',
      notificationsQueued: state.notify_channels.queued,
    };
  },
};

module.exports = { definition, eventNotification, lastJson, validate };
