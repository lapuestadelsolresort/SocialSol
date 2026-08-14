'use strict';

const { sql } = require('@databases/sqlite');
const { nodeCommand } = require('../lib/workflow-command');
const { readBankAccounts, readReport, REPORTS } = require('../lib/quickbooks-api');
const { searchEmailActivity } = require('../lib/gmail-client');
const {
  isBlock,
  reservationDisplayName,
  selectPrimaryCalendarEntries,
} = require('../scripts/lib/ownerrez-occupancy');

async function tableExists(db, name) {
  const [row] = await db.query(sql`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=${name}`);
  return Boolean(row);
}

async function queryIfTable(db, name, query, fallback) {
  if (!(await tableExists(db, name))) return fallback;
  return db.query(query);
}

function evidenceReadDefinition({ name, version = 1, capability, validate = () => {}, collect }) {
  return {
    name,
    version,
    capability,
    mutates: false,
    validate,
    steps: [{
      key: 'read_authority', maxAttempts: 2,
      async run({ db, run, input, services, store, stepKey }) {
        const result = await collect({ db, run, input, services });
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: result.source,
          sourceRef: result.sourceRef || null,
          observedAt: result.observedAt || new Date().toISOString(),
          expiresAt: result.expiresAt || null,
          confidence: result.confidence ?? 1,
          payload: result.payload,
        });
        return { ...result.payload, _evidence: { id: evidence.id, source: result.source, observedAt: evidence.observedAt, payloadHash: evidence.payloadHash } };
      },
    }],
    output({ state }) { return state.read_authority; },
  };
}

const businessSnapshot = evidenceReadDefinition({
  name: 'business.snapshot.read',
  capability: 'business.read',
  async collect({ db }) {
    const generatedAt = new Date().toISOString();
    const [leadRows, outreachRows, whatsappRows, receiptRows, workflowRows, outboxRows, socialRows, squarespaceRuns] = await Promise.all([
      queryIfTable(db, 'leads', sql`SELECT status, COUNT(*) AS count FROM leads GROUP BY status`, []),
      queryIfTable(db, 'outreach_sends', sql`SELECT
        COUNT(*) AS records,
        SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN reply_detected_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
        FROM outreach_sends`, []),
      queryIfTable(db, 'meta_messages', sql`SELECT direction, COALESCE(delivery_status,'unknown') AS delivery_status,
        COUNT(*) AS count FROM meta_messages WHERE platform='whatsapp'
        GROUP BY direction, COALESCE(delivery_status,'unknown')`, []),
      queryIfTable(db, 'accounting_receipts', sql`SELECT status, COUNT(*) AS count
        FROM accounting_receipts GROUP BY status`, []),
      queryIfTable(db, 'workflow_runs', sql`SELECT status, COUNT(*) AS count
        FROM workflow_runs GROUP BY status`, []),
      queryIfTable(db, 'workflow_outbox', sql`SELECT status, COUNT(*) AS count
        FROM workflow_outbox GROUP BY status`, []),
      queryIfTable(db, 'social_content', sql`SELECT status, COUNT(*) AS count
        FROM social_content GROUP BY status`, []),
      queryIfTable(db, 'squarespace_sync_runs', sql`SELECT id, status, started_at, finished_at,
        orders_seen, transactions_seen, contacts_seen, contacts_linked, bookings_linked, error
        FROM squarespace_sync_runs ORDER BY id DESC LIMIT 1`, []),
    ]);

    return {
      source: 'crm.business_read_model',
      observedAt: generatedAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        generatedAt,
        authorityContract: {
          occupancyAvailability: { authority: 'OwnerRez', queried: false, reason: 'requires a date-bounded live OwnerRez occupancy query' },
          directChargesFees: { authority: 'Squarespace', queried: true, freshness: squarespaceRuns[0]?.finished_at || null },
          bankCash: { authority: 'Kapital/QBO', queried: false, reason: 'snapshot never infers live bank cash from CRM data' },
          leadsOutreach: { authority: 'CRM', queried: true, freshness: generatedAt },
          whatsappDelivery: { authority: 'Twilio callbacks and provider readback', queried: true, freshness: generatedAt },
        },
        leadsByStatus: leadRows,
        outreach: outreachRows[0] || { records: 0, sent: 0, delivered: 0, bounced: 0, replied: 0 },
        whatsappByState: whatsappRows,
        receiptsByStatus: receiptRows,
        socialContentByStatus: socialRows,
        workflowsByStatus: workflowRows,
        outboxByStatus: outboxRows,
        squarespaceLastSync: squarespaceRuns[0] || null,
      },
    };
  },
});

function validateLimit(input) {
  if (input.limit !== undefined) {
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
  }
}

function validateWhatsAppStatusInput(input) {
  validateLimit(input);
  const unsupported = Object.keys(input).filter(key => !['direction', 'limit', 'messageSid', 'threadTs'].includes(key));
  if (unsupported.length) {
    throw new Error(`unsupported whatsapp.status.read input: ${unsupported.join(', ')}; use direction, limit, or messageSid`);
  }
  if (input.direction !== undefined && !['outbound', 'inbound', 'all'].includes(String(input.direction))) {
    throw new Error('direction must be outbound, inbound, or all');
  }
  if (input.messageSid !== undefined) {
    const messageSid = String(input.messageSid).trim();
    if (!messageSid || messageSid.length > 100) throw new Error('messageSid must be 1 to 100 characters');
  }
  if (input.threadTs !== undefined) {
    const threadTs = String(input.threadTs).trim();
    if (!threadTs || threadTs.length > 64) throw new Error('threadTs must be 1 to 64 characters');
  }
}

function normalizeContactQueries(input = {}) {
  const raw = [];
  if (input.query !== undefined) raw.push(input.query);
  if (input.queries !== undefined) {
    if (!Array.isArray(input.queries)) throw new Error('queries must be an array of search terms');
    raw.push(...input.queries);
  }
  const queries = [];
  for (const value of raw) {
    if (typeof value !== 'string') throw new Error('contact search terms must be strings');
    for (const part of value.split(/[,;\n]+/)) {
      const normalized = part.trim();
      if (!normalized) continue;
      if (normalized.length > 120) throw new Error('contact search terms must be 120 characters or fewer');
      if (!queries.some(query => query.toLowerCase() === normalized.toLowerCase())) queries.push(normalized);
    }
  }
  if (queries.length > 25) throw new Error('contact lookup accepts at most 25 search terms');
  return queries;
}

function validateCrmContactsInput(input) {
  validateLimit(input);
  const unsupported = Object.keys(input).filter(key => !['query', 'queries', 'limit'].includes(key));
  if (unsupported.length) {
    throw new Error(`unsupported crm.contacts.read input: ${unsupported.join(', ')}; use query, queries, or limit`);
  }
  normalizeContactQueries(input);
}

function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function contactSearchCondition(queries, haystack, phone = sql`phone`) {
  if (!queries.length) return sql`1=1`;
  return sql.join(queries.map(query => {
    const lowered = `%${query.toLowerCase()}%`;
    const digits = digitsOnly(query);
    const phoneMatch = digits.length >= 7
      ? sql` OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${phone},''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ${`%${digits}%`}`
      : sql``;
    return sql`(LOWER(${haystack}) LIKE ${lowered}${phoneMatch})`;
  }), sql` OR `);
}

function contactMatchQueries(record, queries) {
  if (!queries.length) return [];
  const text = normalizedText([
    record.name, record.email, record.phone, record.company, record.source,
    record.relationshipType, record.preferredChannel,
  ].filter(Boolean).join(' '));
  const phoneDigits = digitsOnly(record.phone);
  return queries.filter(query => {
    const normalized = normalizedText(query);
    const queryDigits = digitsOnly(query);
    return text.includes(normalized) || (queryDigits.length >= 7 && phoneDigits.includes(queryDigits));
  });
}

function contactMergeKey(record) {
  const phone = digitsOnly(record.phone);
  if (phone.length >= 7) return `phone:${phone}`;
  const email = normalizedText(record.email);
  if (email) return `email:${email}`;
  return record.contactRef;
}

function sourcePriority(type) {
  return { contact: 4, lead: 3, squarespace_customer: 2, whatsapp: 1 }[type] || 0;
}

function mergeContactRecords(records, queries, observedAt) {
  const merged = new Map();
  for (const record of records) {
    const key = contactMergeKey(record);
    const existing = merged.get(key);
    const priority = sourcePriority(record.recordType);
    if (!existing) {
      merged.set(key, {
        ...record,
        _priority: priority,
        recordRefs: [record.contactRef],
        sources: [record.source].filter(Boolean),
        statuses: [record.status].filter(Boolean),
        matchingQueries: contactMatchQueries(record, queries),
      });
      continue;
    }

    existing.recordRefs = [...new Set([...existing.recordRefs, record.contactRef])];
    existing.sources = [...new Set([...existing.sources, record.source].filter(Boolean))];
    existing.statuses = [...new Set([...existing.statuses, record.status].filter(Boolean))];
    existing.matchingQueries = [...new Set([
      ...existing.matchingQueries,
      ...contactMatchQueries(record, queries),
    ])];
    existing.doNotContact = Boolean(existing.doNotContact || record.doNotContact);
    existing.doNotContactReason ||= record.doNotContactReason || null;

    if (priority > existing._priority) {
      for (const field of [
        'contactRef', 'recordType', 'recordId', 'name', 'phone', 'email', 'company',
        'status', 'relationshipType', 'preferredChannel', 'addressable', 'updatedAt',
      ]) {
        if (record[field] !== null && record[field] !== undefined && record[field] !== '') {
          existing[field] = record[field];
        }
      }
      existing._priority = priority;
    } else {
      for (const field of ['name', 'phone', 'email', 'company', 'relationshipType', 'preferredChannel', 'updatedAt']) {
        if (!existing[field] && record[field]) existing[field] = record[field];
      }
    }

    if (record.lastWhatsAppInboundAt && (
      !existing.lastWhatsAppInboundAt || record.lastWhatsAppInboundAt > existing.lastWhatsAppInboundAt
    )) {
      existing.lastWhatsAppInboundAt = record.lastWhatsAppInboundAt;
      existing.whatsappMessageId = record.whatsappMessageId;
      existing.whatsappDmId = record.whatsappDmId;
      existing.slackThreadTs = record.slackThreadTs;
    }
  }

  const now = new Date(observedAt).valueOf();
  return [...merged.values()].map(record => {
    const inboundAt = record.lastWhatsAppInboundAt ? new Date(record.lastWhatsAppInboundAt).valueOf() : NaN;
    const serviceWindowOpen = Number.isFinite(inboundAt) && inboundAt <= now && now - inboundAt <= 24 * 60 * 60 * 1000;
    const hasWhatsAppPhone = /^\+\d{7,15}$/.test(String(record.phone || ''));
    const whatsappEligibility = record.doNotContact
      ? 'blocked_do_not_contact'
      : !hasWhatsAppPhone
        ? 'no_e164_whatsapp_number'
        : record.lastWhatsAppInboundAt
          ? 'known_whatsapp_contact'
          : normalizedText(record.preferredChannel) === 'whatsapp'
            ? 'preferred_whatsapp_consent_not_verified'
            : 'consent_not_recorded';
    const updated = [record.updatedAt, record.lastWhatsAppInboundAt]
      .filter(Boolean).sort().at(-1) || null;
    const { _priority, ...publicRecord } = record;
    return {
      ...publicRecord,
      updatedAt: updated,
      whatsapp: {
        eligibility: whatsappEligibility,
        knownInbound: Boolean(record.lastWhatsAppInboundAt),
        lastInboundAt: record.lastWhatsAppInboundAt || null,
        serviceWindowOpen,
        dmId: record.whatsappDmId || null,
        slackThreadTs: record.slackThreadTs || null,
        messageId: record.whatsappMessageId || null,
      },
    };
  });
}

const BUSINESS_TIME_ZONE = 'America/Los_Angeles';

function addCalendarDays(value, days) {
  const [year, month, day] = String(value).split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

// Convert a local calendar midnight to UTC without assuming PST/PDT. The
// second pass handles dates on either side of a daylight-saving transition.
function zonedMidnightUtc(value, timeZone = BUSINESS_TIME_ZONE) {
  const [year, month, day] = String(value).split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

function validateEmailActivityInput(input) {
  validateLimit(input);
  for (const key of ['start', 'end']) {
    if (input[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(input[key]))) {
      throw new Error(`${key} must be YYYY-MM-DD`);
    }
  }
  if (input.direction !== undefined && !['inbound', 'outbound', 'all'].includes(String(input.direction))) {
    throw new Error('direction must be inbound, outbound, or all');
  }
  const start = String(input.start || new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE }));
  const end = String(input.end || start);
  if (end < start) throw new Error('end must be on or after start');
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (!Number.isFinite(days) || days > 31) throw new Error('email activity window may not exceed 31 days');
}

function bodyPreview(value, maxLength = 1200) {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

const emailActivityRead = evidenceReadDefinition({
  name: 'email.activity.read',
  capability: 'email.read',
  validate: validateEmailActivityInput,
  async collect({ db, input, services }) {
    const localStart = String(input.start || new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE }));
    const localEnd = String(input.end || localStart);
    const start = zonedMidnightUtc(localStart);
    const end = zonedMidnightUtc(addCalendarDays(localEnd, 1));
    const direction = String(input.direction || 'inbound');
    const limit = Number(input.limit || 25);
    const reader = services.readEmailActivity || searchEmailActivity;
    const live = await reader({ start, end, direction, limit });
    const ledgerRows = await queryIfTable(db, 'email_threads', sql`SELECT
      provider_message_id, direction, received_at, processing_status,
      slack_channel_id, slack_thread_ts, slack_message_ts, workflow_run_id
      FROM email_threads
      WHERE provider='gmail' AND received_at>=${start} AND received_at<${end}`, []);
    const ledgerByMessage = new Map(ledgerRows
      .filter(row => row.provider_message_id)
      .map(row => [String(row.provider_message_id), row]));
    const messages = (live.messages || []).map(message => {
      const ledger = ledgerByMessage.get(String(message.id || '')) || null;
      return {
        providerMessageId: message.id || null,
        providerThreadId: message.threadId || null,
        direction: message.direction || direction,
        receivedAt: message.internalDate || null,
        senderName: message.from?.name || '',
        fromAddress: message.from?.address || '',
        toAddress: message.to || '',
        subject: message.subject || '(no subject)',
        unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
        spam: Array.isArray(message.labelIds) && message.labelIds.includes('SPAM'),
        bodyPreview: bodyPreview(message.text),
        ledger: ledger ? {
          captured: true,
          processingStatus: ledger.processing_status,
          slackProjected: Boolean(ledger.slack_thread_ts || ledger.slack_message_ts),
          workflowRunId: ledger.workflow_run_id || null,
        } : { captured: false, processingStatus: null, slackProjected: false, workflowRunId: null },
      };
    });
    const ledgerCaptured = messages.filter(message => message.ledger.captured).length;
    return {
      source: 'gmail.live_mailbox_api+sqlite.email_threads',
      sourceRef: `${localStart}:${localEnd}:${direction}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: {
        authority: 'Sarah Gmail live mailbox',
        window: { start: localStart, end: localEnd, timeZone: BUSINESS_TIME_ZONE },
        direction,
        totalMessages: Number(live.total ?? messages.length),
        displayedMessages: messages.length,
        inboundMessages: Number(live.inbound ?? messages.filter(message => message.direction === 'inbound').length),
        outboundMessages: Number(live.outbound ?? messages.filter(message => message.direction === 'outbound').length),
        unreadMessages: Number(live.unread ?? messages.filter(message => message.unread).length),
        spamMessages: Number(live.spam ?? messages.filter(message => message.spam).length),
        ledgerCapturedMessages: ledgerCaptured,
        ledgerMissingMessages: messages.length - ledgerCaptured,
        ledgerCoverageScope: 'displayed_messages',
        truncated: Boolean(live.truncated),
        messages,
      },
    };
  },
});

const whatsappStatusRead = evidenceReadDefinition({
  name: 'whatsapp.status.read',
  version: 3,
  capability: 'whatsapp.read',
  validate: validateWhatsAppStatusInput,
  async collect({ db, input }) {
    const limit = Number(input.limit || 25);
    const messageSid = input.messageSid ? String(input.messageSid).trim().slice(0, 100) : null;
    const threadTs = input.threadTs ? String(input.threadTs).trim().slice(0, 64) : null;
    const direction = input.direction ? String(input.direction) : (messageSid ? 'all' : 'outbound');
    const rows = await queryIfTable(db, 'meta_messages', sql`SELECT
      m.message_id,
      CASE WHEN m.direction='outbound' THEN COALESCE(
        (SELECT exact.sender_name FROM meta_messages exact
          WHERE exact.platform='whatsapp'
            AND exact.id=CAST(json_extract(m.raw_payload, '$.reply_to_dm_id') AS INTEGER)
            AND (exact.direction='inbound' OR (exact.direction IS NULL AND exact.sender_id!='outbound'))
          LIMIT 1),
        (SELECT threaded.sender_name FROM meta_messages threaded
          WHERE threaded.platform='whatsapp'
            AND m.slack_thread_ts IS NOT NULL
            AND threaded.slack_thread_ts=m.slack_thread_ts
            AND (threaded.direction='inbound' OR (threaded.direction IS NULL AND threaded.sender_id!='outbound'))
          ORDER BY threaded.received_at DESC LIMIT 1),
        'unknown guest'
      ) ELSE COALESCE(m.sender_name, 'unknown guest') END AS contact_name,
      CASE WHEN m.direction='outbound' THEN COALESCE(m.sender_name, 'Staff') ELSE NULL END AS sent_by_name,
      m.received_at, m.slack_thread_ts,
      COALESCE(m.direction,'legacy_untracked') AS direction,
      COALESCE(m.delivery_status,'untracked_legacy') AS delivery_status,
      m.provider_delivery_status, m.provider_error_code, m.provider_error_message,
      m.delivery_status_source,
      m.provider_status_updated_at, m.delivered_at, m.read_at, m.failed_at,
      m.workflow_run_id, m.workflow_effect_id
      FROM meta_messages m WHERE m.platform='whatsapp'
        AND (${messageSid} IS NULL OR m.message_id=${messageSid})
        AND (${threadTs} IS NULL OR m.slack_thread_ts=${threadTs})
        AND (${direction}='all' OR m.direction=${direction})
      ORDER BY m.received_at DESC LIMIT ${limit}`, []);
    const [summary = {}] = await queryIfTable(db, 'meta_messages', sql`SELECT
      SUM(CASE WHEN direction IS NULL OR delivery_status IS NULL THEN 1 ELSE 0 END) AS legacy_untracked_messages,
      SUM(CASE WHEN (${messageSid} IS NULL OR message_id=${messageSid})
        AND (${threadTs} IS NULL OR slack_thread_ts=${threadTs})
        AND (${direction}='all' OR direction=${direction}) THEN 1 ELSE 0 END) AS matching_messages
      ,SUM(CASE WHEN (${messageSid} IS NULL OR message_id=${messageSid})
        AND (${threadTs} IS NULL OR slack_thread_ts=${threadTs})
        AND (${direction}='all' OR direction=${direction})
        AND delivery_status='read' THEN 1 ELSE 0 END) AS read_messages
      ,SUM(CASE WHEN (${messageSid} IS NULL OR message_id=${messageSid})
        AND (${threadTs} IS NULL OR slack_thread_ts=${threadTs})
        AND (${direction}='all' OR direction=${direction})
        AND delivery_status='delivered' THEN 1 ELSE 0 END) AS delivered_messages
      ,SUM(CASE WHEN (${messageSid} IS NULL OR message_id=${messageSid})
        AND (${threadTs} IS NULL OR slack_thread_ts=${threadTs})
        AND (${direction}='all' OR direction=${direction})
        AND delivery_status='failed' THEN 1 ELSE 0 END) AS failed_messages
      ,SUM(CASE WHEN (${messageSid} IS NULL OR message_id=${messageSid})
        AND (${threadTs} IS NULL OR slack_thread_ts=${threadTs})
        AND (${direction}='all' OR direction=${direction})
        AND COALESCE(delivery_status,'untracked_legacy') NOT IN ('read','delivered','failed')
        THEN 1 ELSE 0 END) AS unconfirmed_messages
      FROM meta_messages WHERE platform='whatsapp'`, [{}]);
    const totalMessages = Number(summary.matching_messages || 0);
    return {
      source: 'twilio.delivery_ledger',
      sourceRef: messageSid || (threadTs ? `slack-thread:${threadTs}` : `direction:${direction}`),
      payload: {
        direction,
        messageSid,
        threadTs,
        totalMessages,
        displayedMessages: rows.length,
        truncated: totalMessages > rows.length,
        statusCounts: {
          read: Number(summary.read_messages || 0),
          delivered: Number(summary.delivered_messages || 0),
          failed: Number(summary.failed_messages || 0),
          unconfirmed: Number(summary.unconfirmed_messages || 0),
        },
        followUpRequiredMessages: Number(summary.failed_messages || 0),
        legacyUntrackedMessages: Number(summary.legacy_untracked_messages || 0),
        legacyCoverageNote: 'Remaining legacy rows lack normalized callback state. Rows with a stored Twilio SID can be recovered with the provider-readback reconciliation.',
        messages: rows,
        statusVocabulary: ['requested','accepted_by_provider','queued','sent','delivered','read','verified_by_readback','failed','untracked_legacy'],
      },
    };
  },
});

async function collectReceipts({ db, input, run }, forceScoped = false) {
  const limit = Number(input.limit || 50);
  const channelFilter = forceScoped ? run.channel_id : null;
  const rows = await queryIfTable(db, 'accounting_receipts', sql`SELECT
    id, slack_channel_id, slack_message_id, submitted_by, submitted_at,
    status, vendor, transaction_date, currency, amount, transaction_kind, description,
    category_key, category_name, extraction_confidence, review_reason,
    amount_usd, fx_rate, qbo_entity_type, qbo_entity_id, posted_at,
    payment_reference, reimbursement_recipient_user_id, payment_source,
    payment_source_selected_by, payment_source_selected_at,
    payment_instruction_queued_at
    FROM accounting_receipts
    WHERE (${channelFilter} IS NULL OR slack_channel_id=${channelFilter})
    ORDER BY submitted_at DESC LIMIT ${limit}`, []);
  for (const receipt of rows) {
    receipt.items = await queryIfTable(db, 'accounting_receipt_items', sql`SELECT
      item_index, file_ref_id, vendor, transaction_date, currency, amount,
      description, category_key, category_name, extraction_confidence
      FROM accounting_receipt_items WHERE receipt_id=${receipt.id} ORDER BY item_index`, []);
  }
  return { source: 'sqlite.accounting_receipts', sourceRef: channelFilter, payload: { receipts: rows, scopedToChannel: channelFilter } };
}

const receiptsRead = evidenceReadDefinition({
  name: 'receipts.status.read',
  capability: 'receipts.read',
  validate: validateLimit,
  collect: context => collectReceipts(context, false),
});

const receiptsScopedRead = evidenceReadDefinition({
  name: 'receipts.scoped.read',
  capability: 'accounting.read_scoped',
  validate: validateLimit,
  collect: context => collectReceipts(context, true),
});

const socialContentRead = evidenceReadDefinition({
  name: 'social.content.read',
  capability: 'social.read',
  validate: validateLimit,
  async collect({ db, input }) {
    const limit = Number(input.limit || 50);
    const rows = await queryIfTable(db, 'social_content', sql`SELECT id, version, status,
      platform, content_type, caption, media_refs_json, scheduled_for, postiz_post_id,
      created_by, updated_by, created_at, updated_at
      FROM social_content ORDER BY updated_at DESC LIMIT ${limit}`, []);
    return { source: 'sqlite.social_content', payload: { content: rows } };
  },
});

function validateDateRange(input) {
  for (const key of ['start', 'end']) {
    if (input[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(input[key]))) {
      throw new Error(`${key} must be YYYY-MM-DD`);
    }
  }
  if (input.start && input.end && input.end < input.start) throw new Error('end must be on or after start');
  if (input.start && input.end) {
    const days = (new Date(`${input.end}T00:00:00Z`) - new Date(`${input.start}T00:00:00Z`)) / 86400000;
    if (days > 370) throw new Error('date window may not exceed 370 days');
  }
}

const ownerrezOccupancyRead = evidenceReadDefinition({
  name: 'ownerrez.occupancy.read',
  capability: 'ownerrez.read',
  validate: validateDateRange,
  async collect({ input, services }) {
    if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
    const start = input.start || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const end = input.end || (() => {
      const parsed = new Date(`${start}T12:00:00Z`);
      parsed.setUTCDate(parsed.getUTCDate() + 28);
      return parsed.toISOString().slice(0, 10);
    })();
    const args = ['--start', start, '--end', end, '--enriched-json'];
    const result = await services.runCommand(nodeCommand('crm/scripts/ownerrez-full-occupancy.js', args));
    let records;
    try { records = JSON.parse(result.stdout); } catch { records = null; }
    if (!Array.isArray(records)) throw new Error('OwnerRez occupancy query returned no machine-readable records');
    const primaryCalendarEntries = selectPrimaryCalendarEntries(records, { asOf: start })
      .map(record => ({
        ...record,
        calendar_entry_kind: isBlock(record) ? 'manual_calendar_entry' : 'typed_booking',
        display_name: reservationDisplayName(record),
      }));
    const nextCalendarEntry = primaryCalendarEntries[0] || null;
    return {
      source: 'ownerrez.live_occupancy_api',
      sourceRef: `${start}:${end}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        authority: 'OwnerRez',
        window: { start, end },
        activeOccupancyRecords: records.length,
        primaryCalendarEntryCount: primaryCalendarEntries.length,
        primaryCalendarEntries,
        nextCalendarEntry,
        calendarSemantics: {
          primaryEntryRule: 'Earliest active record on or after window.start whose type is not linked_availability.',
          manualBlockRule: 'OwnerRez type=block is a manual calendar encoding and does not prove owner use; titled blocks may be guest stays or events.',
          linkedAvailabilityRule: 'linked_availability records are derived occupancy copies and are not separate arrivals.',
        },
        records,
      },
    };
  },
});

const qboBankBalancesRead = evidenceReadDefinition({
  name: 'qbo.bank_balances.read',
  capability: 'qbo.read',
  async collect() {
    const result = await readBankAccounts();
    return {
      source: 'quickbooks.live_accounts_api',
      sourceRef: result.realmId,
      observedAt: result.observedAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        authority: 'QuickBooks ledger (Kapital bank balance only as fresh as QBO bank sync)',
        accounts: result.accounts,
      },
    };
  },
});

const qboReportRead = evidenceReadDefinition({
  name: 'qbo.report.read',
  capability: 'qbo.read',
  validate(input) {
    validateDateRange(input);
    if (!REPORTS.has(String(input.report || ''))) throw new Error('report must be BalanceSheet, ProfitAndLoss, or CashFlow');
    if (input.accountingMethod && !['Cash', 'Accrual'].includes(input.accountingMethod)) {
      throw new Error('accountingMethod must be Cash or Accrual');
    }
  },
  async collect({ input }) {
    const result = await readReport({
      report: input.report,
      startDate: input.start || null,
      endDate: input.end || null,
      accountingMethod: input.accountingMethod || 'Accrual',
    });
    return {
      source: `quickbooks.live_report.${input.report}`,
      sourceRef: result.realmId,
      observedAt: result.observedAt,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      payload: { authority: 'QuickBooks', report: result.report },
    };
  },
});

const squarespaceSummaryRead = evidenceReadDefinition({
  name: 'squarespace.summary.read',
  capability: 'squarespace.read',
  async collect({ db, input }) {
    validateDateRange(input);
    const start = input.start ? `${input.start}T00:00:00.000Z` : null;
    const end = input.end ? `${input.end}T23:59:59.999Z` : null;
    const orders = await queryIfTable(db, 'squarespace_orders', sql`SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(CAST(grand_total_value AS REAL)),0) AS gross_order_value,
      COALESCE(SUM(CASE WHEN payment_state='PAID' THEN 1 ELSE 0 END),0) AS paid_orders,
      COALESCE(SUM(CASE WHEN payment_state='PARTIALLY_PAID' THEN 1 ELSE 0 END),0) AS partially_paid_orders,
      MIN(currency) AS currency
      FROM squarespace_orders
      WHERE (${start} IS NULL OR created_on>=${start}) AND (${end} IS NULL OR created_on<=${end})`, []);
    const payments = await queryIfTable(db, 'squarespace_payments', sql`SELECT
      COALESCE(SUM(CAST(amount_value AS REAL)),0) AS collected,
      COALESCE(SUM(CAST(net_amount_value AS REAL)),0) AS payment_net
      FROM squarespace_payments
      WHERE (${start} IS NULL OR paid_on>=${start}) AND (${end} IS NULL OR paid_on<=${end})`, []);
    const lastRuns = await queryIfTable(db, 'squarespace_sync_runs', sql`SELECT id, status, started_at,
      finished_at, orders_seen, transactions_seen, error FROM squarespace_sync_runs ORDER BY id DESC LIMIT 1`, []);
    return {
      source: 'squarespace.synced_commerce_ledger',
      sourceRef: lastRuns[0]?.id ? String(lastRuns[0].id) : null,
      observedAt: lastRuns[0]?.finished_at || new Date().toISOString(),
      payload: {
        authority: 'Squarespace Commerce', window: { start: input.start || null, end: input.end || null },
        orders: orders[0] || {}, payments: payments[0] || {}, lastSync: lastRuns[0] || null,
      },
    };
  },
});

const crmPipelineRead = evidenceReadDefinition({
  name: 'crm.pipeline.read',
  capability: 'crm.read',
  async collect({ db }) {
    const leads = await queryIfTable(db, 'leads', sql`SELECT status, source, COUNT(*) AS count,
      COALESCE(SUM(estimated_value),0) AS estimated_value
      FROM leads GROUP BY status, source ORDER BY status, source`, []);
    const campaigns = await queryIfTable(db, 'campaigns', sql`SELECT name, channel, status,
      budget_total, spend_actual, start_date, end_date FROM campaigns ORDER BY created_at DESC LIMIT 100`, []);
    const recentAttribution = await queryIfTable(db, 'attribution_events', sql`SELECT event_type, channel,
      COUNT(*) AS count FROM attribution_events WHERE created_at>=datetime('now','-30 days')
      GROUP BY event_type, channel`, []);
    return {
      source: 'crm.pipeline_read_model',
      payload: { leads, campaigns, recentAttribution, generatedAt: new Date().toISOString() },
    };
  },
});

const crmContactsRead = evidenceReadDefinition({
  name: 'crm.contacts.read',
  version: 1,
  capability: 'crm.read',
  validate: validateCrmContactsInput,
  async collect({ db, input }) {
    const observedAt = new Date().toISOString();
    const queries = normalizeContactQueries(input);
    const limit = Number(input.limit || 25);
    const sourceLimit = Math.min(100, Math.max(limit * 4, 25));
    const contactWhere = contactSearchCondition(queries, sql`
      COALESCE(name,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(phone,'')
        || ' ' || COALESCE(company,'') || ' ' || COALESCE(source,'')
    `);
    const leadWhere = contactSearchCondition(queries, sql`
      COALESCE(name,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(phone,'')
        || ' ' || COALESCE(source,'')
    `);
    const squarespaceWhere = contactSearchCondition(queries, sql`
      COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') || ' '
        || COALESCE(email,'') || ' ' || COALESCE(phone,'')
    `);
    const whatsappWhere = contactSearchCondition(queries, sql`
      COALESCE(sender_name,'') || ' ' || COALESCE(sender_id,'')
    `, sql`sender_id`);

    const [contacts, leads, squarespaceCustomers, whatsappSenders] = await Promise.all([
      queryIfTable(db, 'contacts', sql`SELECT
        id, name, email, phone, company, source, status, relationship_type,
        preferred_channel, do_not_contact, do_not_contact_reason, addressable, updated_at
        FROM contacts WHERE ${contactWhere}
        ORDER BY updated_at DESC, id DESC LIMIT ${sourceLimit}`, []),
      queryIfTable(db, 'leads', sql`SELECT
        id, name, email, phone, source, status, updated_at
        FROM leads WHERE ${leadWhere}
        ORDER BY updated_at DESC, id DESC LIMIT ${sourceLimit}`, []),
      queryIfTable(db, 'squarespace_customers', sql`SELECT
        squarespace_customer_id, contact_id, first_name, last_name, email, phone,
        accepts_marketing, created_on, synced_at
        FROM squarespace_customers WHERE ${squarespaceWhere}
        ORDER BY synced_at DESC, squarespace_customer_id DESC LIMIT ${sourceLimit}`, []),
      queryIfTable(db, 'meta_messages', sql`SELECT
        id, sender_id, sender_name, message_id, received_at, slack_thread_ts
        FROM meta_messages
        WHERE platform='whatsapp' AND sender_id!='outbound'
          AND (direction='inbound' OR direction IS NULL)
          AND ${whatsappWhere}
        ORDER BY received_at DESC, id DESC LIMIT ${sourceLimit}`, []),
    ]);

    const records = [
      ...contacts.map(row => ({
        contactRef: `contact:${row.id}`, recordType: 'contact', recordId: row.id,
        name: row.name || null, email: row.email || null, phone: row.phone || null,
        company: row.company || null, source: row.source ? `contacts:${row.source}` : 'contacts',
        status: row.status || null, relationshipType: row.relationship_type || null,
        preferredChannel: row.preferred_channel || null,
        doNotContact: Number(row.do_not_contact || 0) === 1,
        doNotContactReason: row.do_not_contact_reason || null,
        addressable: row.addressable === null || row.addressable === undefined
          ? null : Number(row.addressable) === 1,
        updatedAt: row.updated_at || null,
      })),
      ...leads.map(row => ({
        contactRef: `lead:${row.id}`, recordType: 'lead', recordId: row.id,
        name: row.name || null, email: row.email || null, phone: row.phone || null,
        company: null, source: row.source ? `leads:${row.source}` : 'leads',
        status: row.status || null, relationshipType: null, preferredChannel: null,
        doNotContact: false, doNotContactReason: null, addressable: null,
        updatedAt: row.updated_at || null,
      })),
      ...squarespaceCustomers.map(row => ({
        contactRef: row.contact_id
          ? `contact:${row.contact_id}` : `squarespace:${row.squarespace_customer_id}`,
        recordType: 'squarespace_customer', recordId: row.squarespace_customer_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
        email: row.email || null, phone: row.phone || null, company: null,
        source: 'squarespace_customers', status: null, relationshipType: null,
        preferredChannel: null, doNotContact: false, doNotContactReason: null,
        addressable: Boolean(row.email || row.phone), updatedAt: row.synced_at || row.created_on || null,
      })),
      ...whatsappSenders.map(row => ({
        contactRef: `whatsapp:${row.id}`, recordType: 'whatsapp', recordId: row.id,
        name: row.sender_name || null, email: null, phone: row.sender_id || null,
        company: null, source: 'whatsapp_inbound', status: null, relationshipType: null,
        preferredChannel: 'whatsapp', doNotContact: false, doNotContactReason: null,
        addressable: true, updatedAt: row.received_at || null,
        lastWhatsAppInboundAt: row.received_at || null, whatsappMessageId: row.message_id || null,
        whatsappDmId: row.id, slackThreadTs: row.slack_thread_ts || null,
      })),
    ];
    const allContacts = mergeContactRecords(records, queries, observedAt)
      .filter(contact => !queries.length || contact.matchingQueries.length > 0)
      .sort((left, right) => {
        const leftIndex = queries.length
          ? Math.min(...left.matchingQueries.map(query => queries.indexOf(query))) : 0;
        const rightIndex = queries.length
          ? Math.min(...right.matchingQueries.map(query => queries.indexOf(query))) : 0;
        return leftIndex - rightIndex
          || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
          || String(left.name || '').localeCompare(String(right.name || ''));
      });
    const displayed = allContacts.slice(0, limit);
    const matchedQueries = new Set(allContacts.flatMap(contact => contact.matchingQueries));

    return {
      source: 'crm.contacts+leads+meta_messages+squarespace_customers',
      sourceRef: queries.length ? queries.join('|').slice(0, 500) : 'recent',
      observedAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        authority: 'CRM consolidated contact ledger',
        queries,
        unmatchedQueries: queries.filter(query => !matchedQueries.has(query)),
        totalMatches: allContacts.length,
        displayedContacts: displayed.length,
        truncated: allContacts.length > displayed.length,
        contacts: displayed,
        sourceCoverage: {
          contacts: contacts.length,
          leads: leads.length,
          squarespaceCustomers: squarespaceCustomers.length,
          whatsappSenders: whatsappSenders.length,
        },
        generatedAt: observedAt,
      },
    };
  },
});

const paulinaPerformanceRead = evidenceReadDefinition({
  name: 'paulina.performance.read',
  capability: 'paulina.read',
  async collect({ services }) {
    if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
    const result = await services.runCommand(nodeCommand('prospector/scripts/performance-status.js', ['--json']));
    let report;
    try { report = JSON.parse(result.stdout); } catch { report = null; }
    if (!report?.generated_at) throw new Error('Paulina performance report was not machine-readable');
    return {
      source: 'crm.paulina_performance_report',
      sourceRef: report.scope?.active_campaign_slug || null,
      observedAt: report.generated_at,
      payload: report,
    };
  },
});

module.exports = {
  businessSnapshot,
  emailActivityRead,
  evidenceReadDefinition,
  ownerrezOccupancyRead,
  qboBankBalancesRead,
  qboReportRead,
  crmContactsRead,
  crmPipelineRead,
  paulinaPerformanceRead,
  receiptsRead,
  receiptsScopedRead,
  socialContentRead,
  squarespaceSummaryRead,
  whatsappStatusRead,
  _internal: {
    addCalendarDays,
    bodyPreview,
    normalizeContactQueries,
    validateCrmContactsInput,
    validateEmailActivityInput,
    validateWhatsAppStatusInput,
    zonedMidnightUtc,
  },
};
