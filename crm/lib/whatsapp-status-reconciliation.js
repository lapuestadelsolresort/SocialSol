'use strict';

const { sql } = require('@databases/sqlite');
const {
  monotonicTwilioStatus,
  readWhatsAppMessageStatus,
} = require('./twilio-whatsapp');

async function mapWithConcurrency(items, concurrency, task) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    () => worker(),
  ));
  return output;
}

async function auditWhatsAppRows(db) {
  const [legacyInbound, outbound] = await Promise.all([
    db.query(sql`SELECT id, received_at FROM meta_messages
      WHERE platform='whatsapp' AND direction IS NULL AND sender_id!='outbound'
      ORDER BY id`),
    db.query(sql`SELECT m.id, m.received_at, m.message_id,
        COALESCE(NULLIF(m.message_id,''), json_extract(m.raw_payload, '$.twilio_sid')) AS message_sid,
        m.direction, m.delivery_status, m.provider_status_updated_at,
        m.delivered_at, m.read_at, m.failed_at, m.workflow_effect_id,
        COALESCE(
          (SELECT exact.sender_name FROM meta_messages exact
            WHERE exact.platform='whatsapp'
              AND exact.id=CAST(json_extract(m.raw_payload, '$.reply_to_dm_id') AS INTEGER)
            LIMIT 1),
          (SELECT threaded.sender_name FROM meta_messages threaded
            WHERE threaded.platform='whatsapp'
              AND m.slack_thread_ts IS NOT NULL
              AND threaded.slack_thread_ts=m.slack_thread_ts
              AND threaded.sender_id!='outbound'
            ORDER BY threaded.received_at DESC LIMIT 1),
          'unknown guest'
        ) AS recipient,
        COALESCE(m.sender_name, 'Staff') AS sent_by_name
      FROM meta_messages m
      WHERE m.platform='whatsapp' AND (m.direction='outbound' OR m.sender_id='outbound')
      ORDER BY m.received_at, m.id`),
  ]);
  return { legacyInbound, outbound };
}

function duplicateSids(rows) {
  const owners = new Map();
  const duplicates = [];
  for (const row of rows) {
    const sid = String(row.message_sid || '');
    if (!sid) continue;
    if (owners.has(sid)) duplicates.push({ sid, ids: [owners.get(sid), row.id] });
    else owners.set(sid, row.id);
  }
  return duplicates;
}

function statusCounts(records) {
  const counts = {
    read: 0,
    delivered: 0,
    failed: 0,
    sent: 0,
    queued: 0,
    accepted_by_provider: 0,
    requested: 0,
    unresolved: 0,
  };
  for (const record of records) {
    if (record.lookup !== 'ok') counts.unresolved += 1;
    else if (Object.hasOwn(counts, record.status)) counts[record.status] += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

async function applyReconciliation(db, legacyInbound, records) {
  await db.tx(async tx => {
    await tx.query(sql`UPDATE meta_messages SET
        direction=COALESCE(direction, 'inbound'),
        delivery_status=COALESCE(delivery_status, 'delivered'),
        provider_delivery_status=COALESCE(provider_delivery_status, 'received'),
        provider_status_updated_at=COALESCE(provider_status_updated_at, received_at),
        delivered_at=COALESCE(delivered_at, received_at),
        delivery_status_source=COALESCE(delivery_status_source, 'legacy_inbound_webhook')
      WHERE platform='whatsapp'
        AND (direction='inbound' OR (direction IS NULL AND sender_id!='outbound'))`);

    for (const record of records) {
      if (record.lookup !== 'ok') continue;
      const statusUpdatedAt = record.statusUpdatedAt || record.receivedAt;
      const deliveredAt = ['delivered', 'read'].includes(record.status)
        ? (record.deliveredAt || statusUpdatedAt) : record.deliveredAt;
      const readAt = record.status === 'read'
        ? (record.readAt || statusUpdatedAt) : record.readAt;
      const failedAt = record.status === 'failed'
        ? (record.failedAt || statusUpdatedAt) : record.failedAt;
      const errorCode = record.status === 'failed' ? record.errorCode : null;
      const errorMessage = record.status === 'failed' ? record.errorMessage : null;
      await tx.query(sql`UPDATE meta_messages SET
          message_id=COALESCE(message_id, ${record.messageSid}),
          direction='outbound',
          delivery_status=${record.status},
          provider_delivery_status=${record.providerStatus},
          provider_error_code=${errorCode},
          provider_error_message=${errorMessage},
          delivery_status_source='twilio_message_api_readback',
          provider_status_updated_at=${statusUpdatedAt},
          delivered_at=${deliveredAt},
          read_at=${readAt},
          failed_at=${failedAt}
        WHERE id=${record.id}`);
      if (record.workflowEffectId) {
        await tx.query(sql`UPDATE workflow_effects SET
            status=${record.status}, provider_status=${record.providerStatus},
            error_code=${errorCode}, error_message=${errorMessage},
            sent_at=CASE WHEN ${record.sentAt} IS NOT NULL THEN COALESCE(sent_at, ${record.sentAt}) ELSE sent_at END,
            delivered_at=CASE WHEN ${deliveredAt} IS NOT NULL THEN COALESCE(delivered_at, ${deliveredAt}) ELSE delivered_at END,
            read_at=CASE WHEN ${readAt} IS NOT NULL THEN COALESCE(read_at, ${readAt}) ELSE read_at END,
            failed_at=CASE WHEN ${failedAt} IS NOT NULL THEN COALESCE(failed_at, ${failedAt}) ELSE failed_at END,
            updated_at=${statusUpdatedAt}
          WHERE id=${record.workflowEffectId}`);
      }
    }
  });
  return { inboundNormalized: legacyInbound.length, outboundNormalized: records.length };
}

async function reconcileWhatsAppStatuses(db, options = {}) {
  const apply = options.apply === true;
  const concurrency = Number(options.concurrency || 5);
  const readStatus = options.readStatus
    || (messageSid => readWhatsAppMessageStatus({ messageSid }));
  const { legacyInbound, outbound } = await auditWhatsAppRows(db);
  const duplicates = duplicateSids(outbound);
  if (duplicates.length) {
    throw new Error(`refusing WhatsApp reconciliation with duplicate provider SIDs: ${duplicates.map(item => item.sid).join(', ')}`);
  }

  const records = await mapWithConcurrency(outbound, concurrency, async row => {
    const base = {
      id: row.id,
      messageSid: row.message_sid || null,
      recipient: row.recipient,
      sentByName: row.sent_by_name,
      receivedAt: row.received_at,
      priorDirection: row.direction,
      priorStatus: row.delivery_status,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
      failedAt: row.failed_at,
      workflowEffectId: row.workflow_effect_id,
    };
    if (!row.message_sid) return { ...base, lookup: 'error', error: 'missing Twilio message SID' };
    try {
      const provider = await readStatus(row.message_sid);
      return {
        ...base,
        lookup: 'ok',
        status: monotonicTwilioStatus(row.delivery_status, provider.status),
        providerStatus: provider.providerStatus,
        sentAt: provider.sentAt,
        statusUpdatedAt: provider.statusUpdatedAt,
        errorCode: provider.errorCode,
        errorMessage: provider.errorMessage,
      };
    } catch (error) {
      return {
        ...base,
        lookup: 'error',
        error: String(error.message || error).slice(0, 500),
        errorCode: error.code || null,
      };
    }
  });
  const lookupErrors = records.filter(record => record.lookup !== 'ok');
  if (apply && lookupErrors.length) {
    throw new Error(`refusing partial WhatsApp reconciliation: ${lookupErrors.length} provider status lookup(s) failed`);
  }
  const applied = apply
    ? await applyReconciliation(db, legacyInbound, records)
    : { inboundNormalized: 0, outboundNormalized: 0 };
  return {
    ok: lookupErrors.length === 0,
    mode: apply ? 'apply' : 'dry-run',
    legacyInboundFound: legacyInbound.length,
    outboundFound: outbound.length,
    providerLookups: records.length,
    lookupErrors: lookupErrors.length,
    statusCounts: statusCounts(records),
    followUpRequiredMessages: records.filter(record => record.status === 'failed').length,
    applied,
    records,
  };
}

module.exports = {
  auditWhatsAppRows,
  duplicateSids,
  mapWithConcurrency,
  reconcileWhatsAppStatuses,
  statusCounts,
};
