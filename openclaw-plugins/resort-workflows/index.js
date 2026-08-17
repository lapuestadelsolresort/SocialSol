import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { stageSlackAccountingStatement } = require('../../crm/lib/accounting-slack-inbox.js');
const { buildTaskReport, loadUsers } = require('../../paloma/lib/task-report.js');

const WORKFLOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'input'],
  properties: {
    workflow: {
      type: 'string',
      enum: [
        'receipt.ingest',
        'receipt.annotate',
        'receipt.reconcile',
        'social.content.upsert',
        'social.content.publish',
        'social.publish_routine',
        'social.publish_due',
        'paulina.daily',
        'regina.daily',
        'regina.campaign',
        'crm.sync',
        'ownerrez.crm.sync',
        'squarespace.crm.sync',
        'accounting.classify',
        'qbo.write',
        'accounting.reconciliation.read',
        'business.snapshot.read',
        'email.activity.read',
        'whatsapp.status.read',
        'receipts.status.read',
        'receipts.scoped.read',
        'social.content.read',
        'marketing.snapshot.read',
        'marketing.change.propose',
        'meta.campaign.autonomous',
        'ownerrez.occupancy.read',
        'qbo.bank_balances.read',
        'qbo.report.read',
        'squarespace.summary.read',
        'crm.pipeline.read',
        'crm.contacts.read',
        'paulina.performance.read',
        'guest.reply.draft',
        'ownerrez.mutation.propose',
      ],
      description: 'Versioned workflow to execute. Read results are returned in this tool content; never claim a controlled channel hides them or redirect the user to another channel. Use crm.contacts.read for contact or POC lookups in #whatsapp; do not defer those requests to another channel.',
    },
    input: {
      type: 'object',
      description: 'Workflow input. For receipts.status.read use query, date/start/end, amount, currency, status or scope (all/reconciled/pending), order, and limit to return actual receipt/QBO rows. For accounting.reconciliation.read use view=summary or transactions and order=asc or desc. For crm.contacts.read use query for one contact, queries for multiple names/numbers/emails, and optional limit (1-100); it returns authorized full CRM contact details. For whatsapp.status.read use direction (outbound by default, inbound, or all), optional limit (1-100), and optional messageSid; a trusted current Slack thread is applied automatically. WhatsApp sends are command-only and cannot be invoked through this tool.',
      additionalProperties: true,
    },
  },
};

const COMMAND_ONLY_WORKFLOWS = new Set([
  'whatsapp.reply',
  'meta.dm.reply',
  'ownerrez.mutation.confirm',
  'marketing.change.confirm',
  'receipt.ingest',
  'receipt.payment_source.select',
  'receipt.owner_expense.ingest',
  'receipt.owner_expense.process',
  'receipt.owner_expense.confirm',
  'email.reply.propose',
  'email.reply.confirm',
  'email.message.classify',
]);

function pluginConfig(value = {}) {
  const parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    agentIds: new Set(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter(Boolean) : ['resort']),
    crmBaseUrl: String(parsed.crmBaseUrl || 'http://127.0.0.1:3456').replace(/\/+$/, ''),
    slackAccountId: String(parsed.slackAccountId || ''),
    whatsappChannelIds: new Set(Array.isArray(parsed.whatsappChannelIds) ? parsed.whatsappChannelIds.filter(Boolean) : []),
    socialChannelIds: new Set(Array.isArray(parsed.socialChannelIds) ? parsed.socialChannelIds.filter(Boolean) : []),
    emailChannelIds: new Set(Array.isArray(parsed.emailChannelIds) ? parsed.emailChannelIds.filter(Boolean) : []),
    ownerrezChannelIds: new Set(Array.isArray(parsed.ownerrezChannelIds) ? parsed.ownerrezChannelIds.filter(Boolean) : []),
    reservationsChannelIds: new Set(Array.isArray(parsed.reservationsChannelIds) ? parsed.reservationsChannelIds.filter(Boolean) : []),
    receiptChannelIds: new Set(Array.isArray(parsed.receiptChannelIds) ? parsed.receiptChannelIds.filter(Boolean) : []),
    ownerExpenseChannelIds: new Set(Array.isArray(parsed.ownerExpenseChannelIds) ? parsed.ownerExpenseChannelIds.filter(Boolean) : []),
    accountingChannelIds: new Set(Array.isArray(parsed.accountingChannelIds) ? parsed.accountingChannelIds.filter(Boolean) : []),
    controlledChannelIds: new Set(Array.isArray(parsed.controlledChannelIds) ? parsed.controlledChannelIds.filter(Boolean) : []),
    taskTrackerAgentIds: new Set(Array.isArray(parsed.taskTrackerAgentIds) ? parsed.taskTrackerAgentIds.filter(Boolean) : []),
    taskTrackerAccountIds: new Set(Array.isArray(parsed.taskTrackerAccountIds) ? parsed.taskTrackerAccountIds.filter(Boolean) : []),
    taskTrackerChannelIds: new Set(Array.isArray(parsed.taskTrackerChannelIds) ? parsed.taskTrackerChannelIds.filter(Boolean) : []),
    taskTrackerDatabasePath: String(parsed.taskTrackerDatabasePath || ''),
    taskTrackerConfigPath: String(parsed.taskTrackerConfigPath || ''),
    controlPlaneTokenEnv: String(parsed.controlPlaneTokenEnv || 'RESORT_WORKFLOW_CONTROL_TOKEN'),
    controlPlaneTokenFile: String(parsed.controlPlaneTokenFile || ''),
    shadowMode: parsed.shadowMode !== false,
    liveWorkflowNames: new Set(Array.isArray(parsed.liveWorkflowNames) ? parsed.liveWorkflowNames.filter(Boolean) : []),
  };
}

function workflowIsLive(config, workflowName) {
  return !config.shadowMode || config.liveWorkflowNames.has(workflowName);
}

function trustedMessageId(event, ctx) {
  const value = event?.messageId || ctx?.messageId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function controlPlaneToken(config) {
  const fromEnv = process.env[config.controlPlaneTokenEnv];
  if (typeof fromEnv === 'string' && fromEnv.length >= 32) return fromEnv;
  if (config.controlPlaneTokenFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.controlPlaneTokenFile, 'utf8'));
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token;
    } catch {}
  }
  return null;
}

function resolveSlackConversationId(event = {}, ctx = {}) {
  const candidates = [
    ctx.conversationId,
    event.conversationId,
    event.metadata?.channelId,
    event.metadata?.conversationId,
  ];
  return candidates.map(value => String(value || '').replace(/^channel:/, ''))
    .find(value => /^[A-Z][A-Z0-9]+$/.test(value)) || null;
}

function extractFileRefs(metadata = {}) {
  const raw = Array.isArray(metadata.files) ? metadata.files
    : Array.isArray(metadata.attachments) ? metadata.attachments
      : [];
  return raw.slice(0, 20).map(file => ({
    id: String(file?.id || file?.fileId || '').slice(0, 160),
    name: String(file?.name || file?.filename || file?.title || '').slice(0, 300),
    mimetype: String(file?.mimetype || file?.mimeType || '').slice(0, 160),
    size: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
  })).filter(file => file.id || file.name);
}

function eventTimestampIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return new Date().toISOString();
  const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function channelIdFromToolContext(ctx = {}) {
  const target = String(ctx.deliveryContext?.to || '');
  const direct = target.replace(/^channel:/, '');
  if (/^[A-Z][A-Z0-9]+$/.test(direct)) return direct;
  const match = String(ctx.sessionKey || '').match(/:slack:channel:([^:]+)/);
  return match?.[1] || null;
}

function textResult(text, details = null) {
  return {
    content: [{ type: 'text', text }],
    ...(details === null ? {} : { details }),
  };
}

function statusTruth(status) {
  if (status === 'read') return 'Twilio-confirmed read.';
  if (status === 'delivered') return 'Twilio-confirmed delivery; read is not confirmed.';
  if (status === 'failed') return 'Twilio-confirmed failure; the message was not delivered.';
  if (status === 'sent') return 'Twilio reports sent; delivery and read are not confirmed.';
  if (status === 'queued') return 'Twilio accepted and queued the request; delivery and read are not confirmed.';
  return 'Twilio accepted the request; delivery and read are not confirmed.';
}

function safeInline(value, fallback, maxLength = 80) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>&*_~`]/g, '').trim();
  if (!normalized) return fallback;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function whatsappLedgerTruth(message) {
  const status = String(message?.delivery_status || 'untracked_legacy');
  if (message?.direction === 'inbound') return `inbound received (Twilio webhook persisted; ledger state: ${status})`;
  if (message?.direction === 'legacy_untracked' || status === 'untracked_legacy') {
    return 'legacy/untracked (no persisted Twilio callback state)';
  }
  if (status === 'read') return 'read (Twilio-confirmed)';
  if (status === 'delivered') return 'delivered (Twilio-confirmed; read unconfirmed)';
  if (status === 'failed') {
    const providerStatus = safeInline(message?.provider_delivery_status, 'failed', 40);
    const label = providerStatus === 'undelivered' ? 'undelivered' : 'failed';
    const errorCode = safeInline(message?.provider_error_code, '', 40);
    const knownReason = errorCode === '63016'
      ? 'outside the 24-hour reply window; approved template required'
      : errorCode === '63112'
        ? 'WhatsApp Business Account disabled or verification incomplete at send time'
        : safeInline(message?.provider_error_message, '', 160);
    const error = errorCode ? `; Twilio ${errorCode}${knownReason ? `: ${knownReason}` : ''}` : '';
    return `${label} (Twilio-confirmed; follow-up required${error})`;
  }
  if (status === 'verified_by_readback') return 'verified by provider readback';
  if (status === 'sent') return 'sent (delivery/read unconfirmed)';
  if (status === 'queued') return 'queued (delivery/read unconfirmed)';
  if (status === 'accepted_by_provider') return 'accepted by Twilio (delivery/read unconfirmed)';
  if (status === 'requested') return 'requested locally (Twilio acceptance unconfirmed)';
  return `${safeInline(status, 'unknown', 40)} (delivery/read unconfirmed)`;
}

function formatWhatsAppStatusReply(payload) {
  const run = payload?.run;
  const output = run?.output || {};
  const messages = Array.isArray(output.messages) ? output.messages : [];
  const total = Number(output.totalMessages ?? messages.length);
  const direction = ['outbound', 'inbound', 'all'].includes(output.direction) ? output.direction : 'outbound';
  const scope = direction === 'all' ? 'message' : `${direction} message`;
  const lines = [`*WhatsApp ${scope} status:* ${total} persisted record${total === 1 ? '' : 's'}.`];
  if (output.statusCounts) {
    lines.push(`${Number(output.statusCounts.read || 0)} read · ${Number(output.statusCounts.delivered || 0)} delivered · ${Number(output.statusCounts.failed || 0)} failed/undelivered (follow-up required) · ${Number(output.statusCounts.unconfirmed || 0)} unconfirmed.`);
  }
  if (!messages.length) {
    lines.push('', `No matching ${scope} records were found in the durable WhatsApp ledger.`);
  } else {
    lines.push('');
    for (const message of messages) {
      const contact = safeInline(message.contact_name, 'unknown guest', 60);
      const observedAt = safeInline(
        message.provider_status_updated_at || message.received_at,
        'unknown time',
        40,
      );
      const messageSid = safeInline(message.message_id, 'no provider SID', 100);
      const actor = message.direction === 'outbound' && message.sent_by_name
        ? ` · sent by ${safeInline(message.sent_by_name, 'Staff', 40)}` : '';
      lines.push(`• ${contact} · ${whatsappLedgerTruth(message)} · ${observedAt} · ${messageSid}${actor}`);
    }
  }
  if (output.truncated) {
    lines.push('', `${Number(output.displayedMessages || messages.length)} of ${total} matching records are shown; narrow by messageSid or increase limit up to 100.`);
  }
  const legacyCount = Number(output.legacyUntrackedMessages || 0);
  if (legacyCount > 0) {
    lines.push('', `Coverage note: ${legacyCount} older WhatsApp record${legacyCount === 1 ? '' : 's'} still lack normalized direction/status. Stored Twilio SIDs can be recovered through provider reconciliation; do not call them unknowable.`);
  }
  lines.push('', `Workflow: ${run.id}${output._evidence?.id ? ` · Evidence: ${output._evidence.id}` : ''}`);
  return lines.join('\n');
}

function formatCrmContactsReply(payload) {
  const run = payload?.run;
  const output = run?.output || {};
  const contacts = Array.isArray(output.contacts) ? output.contacts : [];
  const total = Number(output.totalMatches ?? contacts.length);
  const lines = [`*CRM contact lookup:* ${total} matching contact${total === 1 ? '' : 's'}.`];
  if (Array.isArray(output.queries) && output.queries.length) {
    lines.push(`Search: ${output.queries.map(query => safeInline(query, 'unknown', 120)).join(' · ')}`);
  }
  if (!contacts.length) {
    lines.push('', 'No matching contact was found across CRM contacts, leads, Squarespace customers, or historical WhatsApp senders.');
  } else {
    lines.push('');
    for (const contact of contacts) {
      const name = safeInline(contact.name, 'Unnamed contact', 80);
      const phone = safeInline(contact.phone, 'no phone', 40);
      const email = safeInline(contact.email, 'no email', 120);
      const ref = safeInline(contact.contactRef, 'no CRM reference', 80);
      lines.push(`• *${name}* — ${phone} · ${email} · ${ref}`);
      const sources = Array.isArray(contact.sources) && contact.sources.length
        ? contact.sources.map(source => safeInline(String(source).replaceAll('_', ' '), 'unknown', 80)).join(', ')
        : 'unknown';
      const statuses = Array.isArray(contact.statuses) && contact.statuses.length
        ? contact.statuses.map(status => safeInline(status, 'unknown', 40)).join(', ')
        : 'not recorded';
      lines.push(`  Sources: ${sources} · CRM status: ${statuses}`);
      if (contact.doNotContact) {
        lines.push(`  ⚠️ Do not contact${contact.doNotContactReason ? `: ${safeInline(contact.doNotContactReason, 'suppressed', 100)}` : '.'}`);
      }
      const whatsapp = contact.whatsapp || {};
      if (whatsapp.knownInbound) {
        lines.push(`  WhatsApp: prior inbound ${safeInline(whatsapp.lastInboundAt, 'unknown time', 40)} · 24-hour window ${whatsapp.serviceWindowOpen ? 'open' : 'closed'}${whatsapp.dmId ? ` · WA ID ${whatsapp.dmId}` : ''}`);
      } else if (contact.phone) {
        const eligibility = whatsapp.eligibility === 'blocked_do_not_contact'
          ? 'blocked by do-not-contact status'
          : whatsapp.eligibility === 'preferred_whatsapp_consent_not_verified'
            ? 'preferred channel is WhatsApp; consent evidence is not recorded'
            : whatsapp.eligibility === 'no_e164_whatsapp_number'
              ? 'number is not stored in E.164 format'
              : 'no prior WhatsApp inbound or consent evidence recorded';
        lines.push(`  WhatsApp: ${eligibility}`);
      }
    }
  }
  if (Array.isArray(output.unmatchedQueries) && output.unmatchedQueries.length) {
    lines.push('', `No match for: ${output.unmatchedQueries.map(query => safeInline(query, 'unknown', 120)).join(' · ')}`);
  }
  if (output.truncated) {
    lines.push('', `${Number(output.displayedContacts || contacts.length)} of ${total} matches are shown; narrow the search or increase limit up to 100.`);
  }
  lines.push('', `Workflow: ${run.id}${output._evidence?.id ? ` · Evidence: ${output._evidence.id}` : ''}`);
  return lines.join('\n');
}

function ownerRezDateLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || 'unknown date');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

function ownerRezDateRange(entry) {
  const arrival = String(entry?.arrival || '');
  const departure = String(entry?.departure || '');
  const arrivalYear = arrival.slice(0, 4);
  const departureYear = departure.slice(0, 4);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arrival) && arrivalYear === departureYear) {
    const start = ownerRezDateLabel(arrival).replace(`, ${arrivalYear}`, '');
    return `${start} → ${ownerRezDateLabel(departure)}`;
  }
  return `${ownerRezDateLabel(arrival)} → ${ownerRezDateLabel(departure)}`;
}

function ownerRezGuestCount(entry) {
  const adults = entry?.adults === null || entry?.adults === undefined ? 0 : Number(entry.adults);
  const children = entry?.children === null || entry?.children === undefined ? 0 : Number(entry.children);
  const parts = [];
  if (Number.isFinite(adults) && adults > 0) parts.push(`${adults} ${adults === 1 ? 'adult' : 'adults'}`);
  if (Number.isFinite(children) && children > 0) parts.push(`${children} ${children === 1 ? 'child' : 'children'}`);
  return parts.length ? parts.join(' + ') : 'guest count not entered';
}

function ownerRezEntryLine(entry) {
  const label = entry?.display_name || entry?.title || entry?.name || entry?.guest_name
    || `OwnerRez record ${entry?.id || 'unknown'}`;
  const property = entry?.property?.name || `property ${entry?.property_id || 'unknown'}`;
  const manual = entry?.calendar_entry_kind === 'manual_calendar_entry'
    || entry?.type === 'block' || entry?.is_block === true;
  const detail = manual
    ? 'manual calendar entry; guest vs owner use is not encoded'
    : `typed booking; ${ownerRezGuestCount(entry)}`;
  return `• ${ownerRezDateRange(entry)} — ${label}, ${property} (${detail})`;
}

export function formatOwnerRezOccupancyReply(payload, { mode = 'next' } = {}) {
  const run = payload?.run;
  if (!run) return 'The live OwnerRez lookup returned no durable run record, so no booking answer was generated.';
  if (run.status !== 'completed') {
    return `The live OwnerRez calendar workflow ${run.id || 'unknown'} is ${run.status || 'incomplete'}, so no booking answer was generated from memory or CRM data.`;
  }
  const output = run.output || {};
  const allEntries = Array.isArray(output.primaryCalendarEntries)
    ? output.primaryCalendarEntries
    : (output.nextCalendarEntry ? [output.nextCalendarEntry] : []);
  const entries = [...allEntries].sort((left, right) => (
    String(left?.arrival || '').localeCompare(String(right?.arrival || ''))
    || String(left?.departure || '').localeCompare(String(right?.departure || ''))
    || String(left?.id || '').localeCompare(String(right?.id || ''))
  ));
  const selected = mode === 'upcoming' ? entries.slice(0, 40) : entries.slice(0, 1);
  const title = mode === 'upcoming' ? '*Upcoming OwnerRez calendar entries:*' : '*Next OwnerRez calendar entry:*';
  const lines = [title];
  if (selected.length) {
    lines.push('', ...selected.map(ownerRezEntryLine));
    if (mode === 'upcoming' && entries.length > selected.length) {
      lines.push('', `${entries.length - selected.length} additional entries were omitted; request a narrower live date window.`);
    }
  } else {
    lines.push('', `No primary calendar entry starts from ${output.window?.start || 'the requested start'} through ${output.window?.end || 'the requested end'}. Widen the live OwnerRez window before concluding there is no upcoming stay.`);
  }
  if (selected.some(entry => entry?.calendar_entry_kind === 'manual_calendar_entry'
    || entry?.type === 'block' || entry?.is_block === true)) {
    lines.push('', 'OwnerRez manual calendar entries are reported in sequence because their encoding alone does not prove whether they are a guest event or owner use.');
  }
  const evidence = output._evidence?.id ? ` · Evidence: ${output._evidence.id}` : '';
  lines.push('', `Live window: ${output.window?.start || 'unknown'} through ${output.window?.end || 'unknown'} · Workflow: ${run.id}${evidence}`);
  return lines.join('\n');
}

function mxnAmount(value) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function accountingTransactionLabel(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'No description';
  const speiPayee = raw.match(/\bEnvio SPEI\b[^|]*\|\s*([^|]+)/i)?.[1]
    ?.replace(/\bDato no verificado por esta institucion\b[\s\S]*$/i, '').trim();
  if (speiPayee) return safeInline(speiPayee, 'Payee unavailable', 100);
  const merchant = raw.match(/^(.{2,100}?)(?=\s+[_|:-]*\s*\d{6}\b)/)?.[1]?.trim();
  const label = merchant || raw;
  return safeInline(label.replace(/\d{7,}/g, digits => `••••${digits.slice(-4)}`), 'No description', 100);
}

export function formatAccountingReconciliationReply(payload) {
  const run = payload?.run;
  if (!run || run.status !== 'completed') {
    return `The authoritative reconciliation lookup is ${run?.status || 'unavailable'}, so no QBO completeness claim was generated from channel history.`;
  }
  const latest = run.output?.latest;
  if (!latest) {
    return `No completed QBO statement reconciliation exists in the durable ledger. Workflow: ${run.id}${run.output?._evidence?.id ? ` · Evidence: ${run.output._evidence.id}` : ''}`;
  }
  const summary = latest.summary || {};
  const statement = summary.statement || {};
  const principalRecorded = Number(summary.principalRecorded || 0);
  const principalTotal = Number(summary.principalTotal || statement.principal_count || 0);
  const feeRecorded = Number(summary.feeRecordsRecorded || 0);
  const feeExpected = Number(summary.feeRecordsExpected || 0);
  const held = Number(summary.held || 0);
  const complete = summary.complete === true
    && principalRecorded === principalTotal && feeRecorded === feeExpected && held === 0;
  const dateRange = statement.date_start
    ? `${statement.date_start}${statement.date_end && statement.date_end !== statement.date_start ? ` through ${statement.date_end}` : ''}`
    : 'date range unavailable';
  const lines = [
    `*Latest Kapital reconciliation — ${dateRange}*`,
    complete
      ? '✅ Every statement principal and SPEI fee line is recorded in QBO and the run passed provider readback.'
      : '⚠️ The latest verified run still has one or more statement records not recorded in QBO.',
    '',
    `• Principal transactions recorded: ${principalRecorded}/${principalTotal} (${Number(summary.principalWritten || 0)} written in this run; ${Number(summary.dedupSkipped || 0)} already present)`,
    `• SPEI fee lines recorded: ${feeRecorded}/${feeExpected} (${Number(summary.feeRecordsWritten || 0)} written in this run; ${Number(summary.feeRecordsExisting || 0)} already present)`,
    `• Total statement outflows: MXN ${mxnAmount(statement.total_outflows_mxn)}`,
    `• Not recorded: ${held}`,
  ];
  const transactions = Array.isArray(latest.transactions) ? latest.transactions : [];
  if (latest.view === 'transactions') {
    lines.push('', `*Reconciled principal transactions (${transactions.length}), ${latest.order === 'asc' ? 'oldest first' : 'most recent first'}:*`);
    for (const item of transactions) {
      const qbo = item.qbo_entity_id
        ? `QBO ${item.qbo_entity_type || 'record'} ${item.qbo_entity_id}`
        : 'not recorded in QBO';
      const review = Number(item.review_required || 0) === 1 ? ' · category review required' : '';
      lines.push(`• ${item.transaction_date || 'unknown date'} — ${item.currency || 'MXN'} ${mxnAmount(item.amount)} — ${accountingTransactionLabel(item.description)} — ${safeInline(item.qbo_category_name || item.category_name, 'Unclassified', 80)} — ${qbo}${review}`);
    }
    if (feeExpected > 0) {
      lines.push(`• Plus ${feeRecorded}/${feeExpected} separately recorded SPEI fee lines totaling MXN ${mxnAmount(statement.spei_fees_mxn)}`);
    }
  }
  const categories = Array.isArray(summary.categoryTotals) ? summary.categoryTotals : [];
  if (categories.length && latest.view !== 'transactions') {
    lines.push('', '*Statement workflow grouping (receipt reimbursements can contain split QBO expense lines):*');
    for (const category of categories) {
      lines.push(`• ${safeInline(category.category, 'Unclassified', 80)} — MXN ${mxnAmount(category.amount_mxn)} (${Number(category.transactions || 0)} transaction${Number(category.transactions || 0) === 1 ? '' : 's'})`);
    }
    if (Number(statement.spei_fees_mxn || 0) > 0) {
      lines.push(`• Bank fees — MXN ${mxnAmount(statement.spei_fees_mxn)} (${feeExpected} QBO fee lines)`);
    }
  }
  const reviews = Array.isArray(summary.reviewDetails) ? summary.reviewDetails : [];
  if (reviews.length) {
    lines.push('', `*Recorded in Uncategorized Expense; category review required (${reviews.length}):*`);
    for (const item of reviews) {
      lines.push(`• ${item.date || 'unknown date'} — MXN ${mxnAmount(item.amount)} — QBO ${item.qbo_id || 'unknown'} — ${safeInline(item.review_reason, 'category review required', 180)}`);
    }
  }
  const heldDetails = Array.isArray(summary.heldDetails) ? summary.heldDetails : [];
  if (heldDetails.length) {
    lines.push('', '*Not recorded:*');
    for (const item of heldDetails) {
      lines.push(`• ${item.date || 'unknown date'} — ${item.currency || 'MXN'} ${mxnAmount(item.amount)} — ${safeInline(item.review_reason, 'posting review required', 180)}`);
    }
  }
  lines.push('', `QBO reconciliation: ${latest.workflowRunId}${latest.evidenceId ? ` · QBO evidence: ${latest.evidenceId}` : ''}`);
  lines.push(`Authoritative read: ${run.id}${run.output?._evidence?.id ? ` · Evidence: ${run.output._evidence.id}` : ''}`);
  return lines.join('\n');
}

export function formatReceiptsStatusReply(payload) {
  const run = payload?.run;
  if (!run || run.status !== 'completed') {
    return `The receipt-ledger read is ${run?.status || 'unavailable'}; no accounting status was inferred.`;
  }
  const receipts = Array.isArray(run.output?.receipts) ? run.output.receipts : [];
  const filters = run.output?.filters || {};
  const lines = [
    `Receipt ledger returned ${receipts.length} matching record${receipts.length === 1 ? '' : 's'}.`,
  ];
  if (!receipts.length) lines.push('No matching receipt or QBO projection was found for the supplied filters.');
  for (const receipt of receipts.slice(0, 25)) {
    const qbo = receipt.qbo_entity_id
      ? `QBO ${receipt.qbo_entity_type || 'record'} ${receipt.qbo_entity_id}`
      : 'not recorded in QBO';
    const reason = receipt.review_reason ? ` · ${safeInline(receipt.review_reason, '', 180)}` : '';
    lines.push(`• ${receipt.transaction_date || 'unknown date'} — ${receipt.currency || 'currency unknown'} ${mxnAmount(receipt.amount)} — ${safeInline(receipt.vendor, 'vendor unknown', 100)} — ${receipt.status || 'unknown status'} — ${qbo}${reason}`);
  }
  if (receipts.length > 25) lines.push(`${receipts.length - 25} additional matching records were omitted; narrow the filters.`);
  const applied = [
    filters.query ? `query=${safeInline(filters.query, '', 80)}` : null,
    filters.start ? `start=${filters.start}` : null,
    filters.end ? `end=${filters.end}` : null,
    filters.amount ? `amount=${filters.amount}` : null,
    filters.currency ? `currency=${filters.currency}` : null,
    filters.status ? `status=${filters.status}` : null,
    filters.scope && filters.scope !== 'all' ? `scope=${filters.scope}` : null,
  ].filter(Boolean);
  lines.push(`Workflow: ${run.id}${run.output?._evidence?.id ? ` · Evidence: ${run.output._evidence.id}` : ''}${applied.length ? ` · Filters: ${applied.join(', ')}` : ''}`);
  return lines.join('\n');
}

function qboReportRows(rows, depth = 0, output = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const columns = row?.ColData || row?.Header?.ColData || row?.Summary?.ColData || [];
    if (columns.length) {
      const values = columns.map(column => String(column?.value || '').trim()).filter(Boolean);
      if (values.length) output.push(`${'  '.repeat(depth)}• ${values.join(' — ')}`);
    }
    if (row?.Rows?.Row) qboReportRows(row.Rows.Row, depth + 1, output);
    if (row?.Summary?.ColData && row?.Header?.ColData) {
      const summary = row.Summary.ColData.map(column => String(column?.value || '').trim()).filter(Boolean);
      if (summary.length) output.push(`${'  '.repeat(depth)}• ${summary.join(' — ')}`);
    }
  }
  return output;
}

export function formatQboReportReply(payload) {
  const run = payload?.run;
  if (!run || run.status !== 'completed') return `The QuickBooks report read is ${run?.status || 'unavailable'}.`;
  const report = run.output?.report || {};
  const header = report.Header || {};
  const rows = qboReportRows(report.Rows?.Row).slice(0, 100);
  return [
    `QuickBooks ${header.ReportName || 'report'} — ${header.StartPeriod || 'start unavailable'} through ${header.EndPeriod || 'end unavailable'} — ${header.ReportBasis || 'basis unavailable'} — ${header.Currency || 'currency unavailable'}`,
    ...rows,
    `Workflow: ${run.id}${run.output?._evidence?.id ? ` · Evidence: ${run.output._evidence.id}` : ''}`,
  ].join('\n');
}

export function formatQboBankBalancesReply(payload) {
  const run = payload?.run;
  if (!run || run.status !== 'completed') return `The QuickBooks bank-account read is ${run?.status || 'unavailable'}.`;
  const accounts = Array.isArray(run.output?.accounts) ? run.output.accounts : [];
  return [
    `${run.output?.authority || 'QuickBooks bank ledger'}:`,
    ...accounts.map(account => `• ${safeInline(account.name, `Account ${account.id || 'unknown'}`, 120)} — ${account.currency || 'currency unknown'} ${mxnAmount(account.currentBalanceWithSubAccounts ?? account.currentBalance)}${account.active === false ? ' — inactive' : ''}`),
    `Workflow: ${run.id}${run.output?._evidence?.id ? ` · Evidence: ${run.output._evidence.id}` : ''}`,
  ].join('\n');
}

export function formatAccountingTransactionReply(payload) {
  const run = payload?.run;
  if (!run || run.status !== 'completed') {
    return `The authoritative transaction lookup is ${run?.status || 'unavailable'}; no QBO posting claim was generated.`;
  }
  const receipts = Array.isArray(run.output?.receipts) ? run.output.receipts : [];
  const posted = receipts.filter(receipt => receipt.status === 'posted' && receipt.qbo_entity_id);
  const ignored = receipts.filter(receipt => receipt.status === 'ignored');
  const pending = receipts.filter(receipt => receipt.status !== 'posted' && receipt.status !== 'ignored');
  const lines = [];
  if (posted.length === 1) {
    const receipt = posted[0];
    lines.push(`✅ Recorded exactly once in QBO: ${receipt.qbo_entity_type || 'record'} ${receipt.qbo_entity_id}.`);
  } else if (posted.length > 1) {
    lines.push(`⚠️ ${posted.length} matching QBO records were found; this may be a duplicate posting and requires review.`);
  } else if (receipts.length) {
    lines.push('⚠️ This transaction is not recorded in QBO.');
  } else {
    lines.push('⚠️ No matching transaction was found in the durable receipt ledger, so it cannot be claimed as recorded in QBO.');
  }
  for (const receipt of posted) {
    lines.push(`• ${receipt.transaction_date || 'unknown date'} — ${receipt.currency || 'MXN'} ${mxnAmount(receipt.amount)} — ${safeInline(receipt.vendor, 'vendor unknown', 100)} — ${safeInline(receipt.category_name, 'category unavailable', 80)} — QBO ${receipt.qbo_entity_type || 'record'} ${receipt.qbo_entity_id}`);
  }
  for (const receipt of pending) {
    lines.push(`• Not recorded: receipt ${receipt.id} is ${receipt.status || 'pending'}${receipt.review_reason ? ` — ${safeInline(receipt.review_reason, '', 180)}` : ''}`);
  }
  if (ignored.length) lines.push(`• Duplicate receipt captures ignored: ${ignored.length}`);
  lines.push(`Authoritative read: ${run.id}${run.output?._evidence?.id ? ` · Evidence: ${run.output._evidence.id}` : ''}`);
  return lines.join('\n');
}

export function formatWorkflowReply(payload) {
  const run = payload?.run;
  if (!run) return 'The workflow returned no durable run record.';
  if (run.status !== 'completed') {
    const acceptedEffect = Array.isArray(run.effects)
      ? run.effects.find(effect => effect.provider_ref && [
        'accepted_by_provider', 'queued', 'sent', 'delivered', 'read', 'manual_review',
      ].includes(effect.status))
      : null;
    if (acceptedEffect) {
      return `Workflow ${run.id} is ${run.status}, but provider acceptance ${acceptedEffect.provider_ref} is recorded in effect ${acceptedEffect.id}. Do not resend. Follow the manual-review alert or inspect provider state before taking any action.`;
    }
    return `Workflow ${run.id} is ${run.status}. No delivery claim can be made.${run.error_message ? ` Error: ${run.error_message}` : ''}`;
  }
  if (run.workflow_name === 'whatsapp.reply') {
    const output = run.output || {};
    return [
      `WhatsApp request recorded for ${output.recipient || 'the guest'}.`,
      `Provider state: ${output.status || 'accepted_by_provider'}.`,
      statusTruth(output.status),
      `Workflow: ${run.id}${output.effectId ? ` · Effect: ${output.effectId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'whatsapp.status.read') {
    return formatWhatsAppStatusReply(payload);
  }
  if (run.workflow_name === 'crm.contacts.read') {
    return formatCrmContactsReply(payload);
  }
  if (run.workflow_name === 'accounting.reconciliation.read') {
    return formatAccountingReconciliationReply(payload);
  }
  if (['receipts.status.read', 'receipts.scoped.read'].includes(run.workflow_name)) {
    return formatReceiptsStatusReply(payload);
  }
  if (run.workflow_name === 'qbo.report.read') return formatQboReportReply(payload);
  if (run.workflow_name === 'qbo.bank_balances.read') return formatQboBankBalancesReply(payload);
  if (run.workflow_name === 'meta.dm.reply') {
    const output = run.output || {};
    return [
      `Meta DM request recorded for ${output.recipient || 'the guest'} on ${output.platform || 'Meta'}.`,
      `Provider state: ${output.status || 'accepted_by_provider'}. Delivery/read is not confirmed.`,
      `Workflow: ${run.id}${output.effectId ? ` · Effect: ${output.effectId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'email.reply.propose') {
    const output = run.output || {};
    const transport = output.provider === 'ownerrez' ? 'OwnerRez message' : 'email';
    return [
      `No ${transport} has been sent.`,
      `Recipient: ${output.recipient || output.toAddress || 'unknown'}${output.outreachSendId ? ` · Draft #${output.outreachSendId}` : ''}`,
      `Immutable request: ${output.requestHash || 'unknown'}`,
      '',
      `> ${String(output.bodyText || '').split('\n').join('\n> ')}`,
      'This proposal does not expire. After reviewing the exact message above, copy and paste the full next line anywhere in this channel:',
      output.confirmationCommand || 'confirmation command unavailable',
      `Workflow: ${run.id}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'email.reply.confirm') {
    const output = run.output || {};
    const provider = output.provider === 'ownerrez' ? 'OwnerRez' : 'Gmail';
    return [
      `${provider} message to ${output.recipient || 'the contact'} was accepted and verified by provider readback.`,
      `Proposal: ${output.proposalId || 'unknown'} · Email event: ${output.emailThreadId || 'unknown'}`,
      `Workflow: ${run.id}${output.effectId ? ` · Effect: ${output.effectId}` : ''}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'email.message.classify') {
    const output = run.output || {};
    return [
      `Email event ${output.emailThreadId || 'unknown'} classified as ${output.quality || 'unknown'}.`,
      output.suppressionRepaired ? 'A prior false-negative suppression was removed.' : null,
      output.suppressed ? 'The contact was suppressed from future outreach.' : null,
      `Workflow: ${run.id}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].filter(Boolean).join('\n');
  }
  if (run.workflow_name === 'email.activity.read') {
    const output = run.output || {};
    const window = output.window || {};
    const direction = output.direction === 'outbound' ? 'sent' : output.direction === 'all' ? 'received/sent' : 'received';
    const lines = [
      `Sarah Gmail live activity for ${window.start || 'unknown'}${window.end && window.end !== window.start ? ` through ${window.end}` : ''}: ${Number(output.totalMessages || 0)} ${direction} message${Number(output.totalMessages || 0) === 1 ? '' : 's'}.`,
      `${Number(output.unreadMessages || 0)} unread · ${Number(output.spamMessages || 0)} spam.`,
    ];
    for (const message of output.messages || []) {
      const sender = message.senderName
        ? `${message.senderName}${message.fromAddress ? ` <${message.fromAddress}>` : ''}`
        : message.fromAddress || 'unknown sender';
      const party = message.direction === 'outbound' ? `To ${message.toAddress || 'unknown recipient'}` : `From ${sender}`;
      lines.push(`• ${message.receivedAt || 'unknown time'} — ${party} — ${message.subject || '(no subject)'}${message.unread ? ' [unread]' : ''}${message.spam ? ' [spam]' : ''}`);
      if (message.bodyPreview) lines.push(`  ${String(message.bodyPreview).replace(/\s+/g, ' ').slice(0, 500)}`);
    }
    if (output.truncated) lines.push('The result was truncated; narrow the date window or request a larger limit.');
    lines.push(`Ledger coverage for displayed messages: ${Number(output.ledgerCapturedMessages || 0)} captured · ${Number(output.ledgerMissingMessages || 0)} missing.`);
    lines.push(`Workflow: ${run.id}${output._evidence?.id ? ` · Evidence: ${output._evidence.id}` : ''}`);
    return lines.join('\n');
  }
  if (run.workflow_name === 'ownerrez.mutation.propose') {
    const output = run.output || {};
    return [
      'No OwnerRez change has been made.',
      `Proposed operation: ${output.operationId || 'unknown'} · Proposal: ${output.proposalId || 'unknown'}`,
      `Expires: ${output.expiresAt || 'unknown'}`,
      'Review the proposed fields and reason, then paste this exact command as a new Slack message:',
      `\`${output.confirmationCommand || 'confirmation command unavailable'}\``,
      `Workflow: ${run.id}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'marketing.snapshot.read') {
    const output = run.output || {};
    const window = output.window || {};
    const totals = output.totals || {};
    const lines = [
      `Paid Meta snapshot ${window.start || 'unknown'} through ${window.end || 'unknown'}: `
        + `$${Number(totals.spend || 0).toFixed(2)} spend, ${Number(totals.sessions || 0)} CRM sessions, `
        + `${Number(totals.wa_taps || 0)} WhatsApp taps, ${Number(totals.verified_wa_leads || 0)} verified leads.`,
      `Tracking integrity: ${output.tracking_health?.healthy === true ? 'healthy' : 'failed; mutations blocked'}.`,
    ];
    for (const campaign of output.campaigns || []) {
      lines.push(`• ${campaign.campaign_name}: $${Number(campaign.meta?.spend || 0).toFixed(2)} spend · ${Number(campaign.crm?.wa_taps || 0)} WA taps · ${Number(campaign.crm?.verified_wa_leads || 0)} verified leads`);
    }
    lines.push(`Bounded autonomous actions authorized now: ${(output.authorized_actions || []).length}.`);
    lines.push(`Workflow: ${run.id}${output._evidence?.id ? ` · Evidence: ${output._evidence.id}` : ''}`);
    return lines.join('\n');
  }
  if (run.workflow_name === 'marketing.change.propose') {
    const output = run.output || {};
    return [
      'No paid-media or landing-page change has been made.',
      `Proposed operation: ${output.operation || 'unknown'} · Target: ${output.targetRef || 'unknown'}`,
      `Immutable request: ${output.requestHash || 'unknown'}${output.briefHash ? ` · Brief: ${output.briefHash}` : ''}`,
      `Expires: ${output.expiresAt || 'unknown'}`,
      'After reviewing the exact operation, paste this command as a new Slack message:',
      `\`${output.confirmationCommand || 'confirmation command unavailable'}\``,
      `Workflow: ${run.id}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
  }
  if (['marketing.change.confirm', 'meta.campaign.autonomous'].includes(run.workflow_name)) {
    const output = run.output || {};
    const authority = output.authorityTier === 'autonomous' ? 'bounded autonomous' : 'human-confirmed';
    return [
      `${output.operation || 'Marketing change'} completed as a ${authority} action and was verified by readback.`,
      `Request: ${output.requestId || 'unknown'} · Provider reference: ${output.providerRef || 'unknown'}`,
      `Workflow: ${run.id}${output.effectId ? ` · Effect: ${output.effectId}` : ''}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'ownerrez.mutation.confirm') {
    const output = run.output || {};
    return [
      `OwnerRez change verified by readback (${output.operationId || 'operation'}).`,
      `Proposal: ${output.proposalId || 'unknown'}`,
      `Workflow: ${run.id}${output.effectId ? ` · Effect: ${output.effectId}` : ''}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
  }
  if (run.workflow_name === 'ownerrez.occupancy.read') {
    return formatOwnerRezOccupancyReply(payload, { mode: 'next' });
  }
  const output = run.output || {};
  const artifacts = [
    output.effectId ? `Effect: ${output.effectId}` : null,
    output.evidenceId ? `Evidence: ${output.evidenceId}` : null,
    output._evidence?.id ? `Evidence: ${output._evidence.id}` : null,
  ].filter(Boolean);
  return `Workflow: ${run.id} completed with ${output.status || 'verified run state'}.${artifacts.length ? ` ${artifacts.join(' · ')}` : ''}`;
}

async function callControlPlane(config, { workflow, input, context, idempotencyKey }, fetchImpl = fetch) {
  const token = controlPlaneToken(config);
  if (!token || token.length < 32) {
    const error = new Error('workflow control-plane token is missing or too short in the configured environment/file');
    error.code = 'workflow_control_token_missing';
    throw error;
  }
  const response = await fetchImpl(`${config.crmBaseUrl}/api/workflows/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflow,
      input,
      context: {
        origin: 'slack',
        channel_id: context.channelId,
        actor_user_id: context.actorUserId,
        message_id: context.messageId || null,
        entrypoint: context.entrypoint || 'model_tool',
      },
      idempotency_key: idempotencyKey,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `workflow control plane returned ${response.status}`);
    error.code = payload.code || `workflow_http_${response.status}`;
    throw error;
  }
  let latest = payload;
  const deadline = Date.now() + 55_000;
  while (latest?.run && ['queued', 'running', 'retry'].includes(latest.run.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const runResponse = await fetchImpl(`${config.crmBaseUrl}/api/workflows/runs/${encodeURIComponent(latest.run.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const polled = await runResponse.json().catch(() => ({}));
    if (!runResponse.ok) break;
    latest = polled;
  }
  return latest;
}

export function createWorkflowTool({ config, ctx, fetchImpl = fetch }) {
  const channelId = channelIdFromToolContext(ctx);
  return {
    name: 'resort_workflow',
    label: 'Resort Workflow',
    description: 'Execute a channel-authorized, durable resort workflow. Effects are idempotent and provider status is reported without inference.',
    parameters: WORKFLOW_SCHEMA,
    async execute(toolCallId, rawParams) {
      const workflow = String(rawParams?.workflow || '');
      if (COMMAND_ONLY_WORKFLOWS.has(workflow)) {
        const error = new Error(`${workflow} requires its explicit Slack command and cannot be called by the model tool`);
        error.code = 'workflow_command_required';
        throw error;
      }
      const rawInput = rawParams?.input && typeof rawParams.input === 'object' ? rawParams.input : {};
      if (!channelId || !ctx.requesterSenderId) throw new Error('trusted Slack channel/user context is unavailable');
      const input = {
        ...rawInput,
        ...(workflow === 'whatsapp.status.read' && ctx.deliveryContext?.threadId
          ? { threadTs: String(ctx.deliveryContext.threadId) } : {}),
      };
      const digest = crypto.createHash('sha256')
        .update(JSON.stringify({ workflow, input, toolCallId }))
        .digest('hex').slice(0, 32);
      const payload = await callControlPlane(config, {
        workflow,
        input,
        context: {
          channelId,
          actorUserId: ctx.requesterSenderId,
          messageId: null,
          entrypoint: 'model_tool',
        },
        idempotencyKey: `openclaw:${ctx.sessionId || ctx.sessionKey || 'session'}:${digest}`,
      }, fetchImpl);
      return textResult(formatWorkflowReply(payload), payload);
    },
  };
}

export function parseWhatsAppCommand(text, { hasThread = false } = {}) {
  const body = String(text || '').trim();
  if (!/^!wa(?:\s|$)/i.test(body)) return null;
  const remainder = body.replace(/^!wa\s*/i, '').trim();
  if (!remainder) return { error: 'message_required' };
  if (hasThread) return { message: remainder };
  const match = remainder.match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) return { error: 'dm_id_required' };
  return { dmId: Number(match[1]), message: match[2].trim() };
}

export function parseMetaDmCommand(text) {
  const body = String(text || '').trim();
  if (!/^!dm(?:\s|$)/i.test(body)) return null;
  const match = body.match(/^!dm\s+(\d+)\s+([\s\S]+)$/i);
  if (!match || !match[2].trim()) return { error: 'invalid_meta_dm_command' };
  return { dmId: Number(match[1]), message: match[2].trim() };
}

export function parseEmailCommand(text, { hasThread = false } = {}) {
  let body = String(text || '').trim();
  if (body.startsWith('`') && body.endsWith('`')) body = body.slice(1, -1).trim();
  if (!/^!email(?:\s|$)/i.test(body)) return null;
  if (/^!email\s+(?:confirm|classify)(?:\s|$)/i.test(body)) body = body.replaceAll('`', '');
  const confirm = body.match(/^!email\s+confirm\s+([0-9a-f-]{36})\s+([0-9a-f]{12})\s*$/i);
  if (confirm) return {
    action: 'confirm', proposalId: confirm[1].toLowerCase(), acceptanceHash: confirm[2].toLowerCase(),
  };
  if (!hasThread) return { error: 'original_thread_required' };
  const classify = body.match(/^!email\s+classify\s+(\d+)\s+(hot|not_interested|ambiguous)\s*$/i);
  if (classify) return { action: 'classify', eventId: Number(classify[1]), quality: classify[2].toLowerCase() };
  const reply = body.match(/^!email\s+reply\s+([\s\S]+)$/i);
  if (!reply) return { error: 'invalid_email_command' };
  const remainder = reply[1].trim();
  if (!remainder) return { error: 'message_required' };
  return { action: 'propose', message: remainder };
}

export function parseMarketingConfirmCommand(text) {
  const body = String(text || '').trim();
  if (!/^!meta(?:\s|$)/i.test(body)) return null;
  const match = body.match(/^!meta\s+confirm\s+([0-9a-f-]{36})\s+([0-9a-f]{12})\s*$/i);
  if (!match) return { error: 'invalid_marketing_confirmation' };
  return { proposalId: match[1].toLowerCase(), acceptanceHash: match[2].toLowerCase() };
}

export function parseManualReviewCommand(text) {
  const body = String(text || '').trim();
  if (!/^!review(?:\s|$)/i.test(body)) return null;
  const sent = body.match(/^!review\s+resolve\s+([0-9a-f-]{36})\s+sent\s+([^\s]{2,160})$/i);
  if (sent) return { reviewId: sent[1].toLowerCase(), resolution: 'confirmed_sent', providerRef: sent[2] };
  const terminal = body.match(/^!review\s+resolve\s+([0-9a-f-]{36})\s+(not-sent|abandon)$/i);
  if (terminal) return {
    reviewId: terminal[1].toLowerCase(),
    resolution: terminal[2].toLowerCase() === 'not-sent' ? 'confirmed_not_sent' : 'abandoned',
    providerRef: null,
  };
  return { error: 'invalid_manual_review_command' };
}

export function parseReceiptConfirmCommand(text) {
  const body = String(text || '').trim();
  if (!/^!receipt(?:\s|$)/i.test(body)) return null;
  const expense = body.match(/^!receipt\s+confirm\s+(?:expense\s+)?([0-9a-f-]{36})\s+(\d{4}-\d{2}-\d{2})\s+(MXN|USD)\s+(\d+(?:\.\d+)?)\s+([a-z0-9_]{1,80})\s*\|\s*([^|]{1,300})(?:\s*\|\s*([\s\S]{1,1000}))?\s*$/i);
  if (expense) {
    return {
      transactionKind: 'owner_paid_expense',
      receiptId: expense[1].toLowerCase(),
      transactionDate: expense[2],
      currency: expense[3].toUpperCase(),
      amount: Number(expense[4]),
      categoryKey: expense[5].toLowerCase(),
      vendor: expense[6].trim(),
      description: String(expense[7] || '').trim(),
    };
  }
  const repayment = body.match(/^!receipt\s+confirm\s+repayment\s+([0-9a-f-]{36})\s+(\d{4}-\d{2}-\d{2})\s+(MXN|USD)\s+(\d+(?:\.\d+)?)\s*\|\s*([^|]{1,300})(?:\s*\|\s*([\s\S]{1,1000}))?\s*$/i);
  if (!repayment) return { error: 'invalid_receipt_confirmation' };
  return {
    transactionKind: 'owner_repayment',
    receiptId: repayment[1].toLowerCase(),
    transactionDate: repayment[2],
    currency: repayment[3].toUpperCase(),
    amount: Number(repayment[4]),
    categoryKey: null,
    vendor: repayment[5].trim(),
    description: String(repayment[6] || '').trim(),
  };
}

async function resolveManualReview(config, request, fetchImpl = fetch) {
  const token = controlPlaneToken(config);
  if (!token || token.length < 32) throw new Error('workflow control-plane token is unavailable');
  const response = await fetchImpl(
    `${config.crmBaseUrl}/api/workflows/manual-reviews/${encodeURIComponent(request.reviewId)}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        resolution: request.resolution,
        provider_ref: request.providerRef,
        context: {
          channel_id: request.channelId,
          actor_user_id: request.actorUserId,
          entrypoint: 'slack_manual_review_command',
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `manual review endpoint returned ${response.status}`);
    error.code = payload.code || `workflow_http_${response.status}`;
    throw error;
  }
  return payload;
}

export function parseOwnerRezConfirmCommand(text) {
  const body = String(text || '').trim();
  if (!/^!ownerrez(?:\s|$)/i.test(body)) return null;
  const match = body.match(/^!ownerrez\s+confirm\s+([0-9a-f-]{36})\s+([0-9a-f]{8,12})\s*$/i);
  if (!match) return { error: 'invalid_confirmation' };
  return { proposalId: match[1].toLowerCase(), acceptanceHash: match[2].toLowerCase() };
}

function losAngelesDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(value, days) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('calendar date must use YYYY-MM-DD');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parseReservationReadRequest(text, { asOf = losAngelesDate() } = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('!')) return null;
  const body = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\b(?:cash[ -]?flow|revenue|income|money|payouts?|balances?|worth|value|precio|ingresos?|pagos?|saldo)\b/.test(body)) return null;
  if (/\b(?:move|change|cancel|create|edit|update|delete|modify|reschedule|hold|block|mover|cambiar|cancelar|crear|editar|actualizar|borrar|bloquear)\b/.test(body)) return null;
  if (/\b(?:availability|available|disponibilidad|disponible)\b/.test(body)) return null;

  const entity = /\b(?:bookings?|reservations?|arrivals?|stays?|reservas?|reservacion(?:es)?|llegadas?|estadias?)\b/;
  if (!entity.test(body)) return null;
  const nextMarker = /\b(?:next|upcoming|soonest|following|proxim[ao]s?)\b/.test(body);
  const listRequest = /\b(?:list|show|lista|listar|muestra|mostrar|dame)\b/.test(body)
    || /\b(?:what|which)(?: are| do we have)? (?:our )?(?:bookings?|reservations?|arrivals?|stays?)\b/.test(body)
    || /\b(?:que|cuales)(?: son)? (?:las |los )?(?:reservas?|reservacion(?:es)?|llegadas?|estadias?)\b/.test(body);
  if (!nextMarker && !listRequest) return null;

  const pluralEntity = /\b(?:bookings|reservations|arrivals|stays|reservas|reservaciones|llegadas|estadias)\b/.test(body);
  const numbered = /\b(?:next|proxim[ao]s?)\s+\d+\b/.test(body);
  return {
    mode: pluralEntity || numbered ? 'upcoming' : 'next',
    start: asOf,
    end: addCalendarDays(asOf, 370),
  };
}

export function createReservationReadClaimHandler({
  config,
  execute = callControlPlane,
  logger = null,
  today = losAngelesDate,
} = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.reservationsChannelIds.has(channelId)) return undefined;
    const request = parseReservationReadRequest(
      event.bodyForAgent || event.body || event.content || '',
      { asOf: today() },
    );
    if (!request) return undefined;
    const messageId = trustedMessageId(event, ctx);
    const actorUserId = String(event.senderId || ctx?.senderId || '');
    if (!messageId || !actorUserId) {
      return {
        handled: true,
        reply: { text: 'The live OwnerRez lookup was not run because trusted Slack message/user identity was unavailable. No booking answer was generated from CRM data or memory.' },
      };
    }
    try {
      logger?.info?.(`resort-workflows claiming OwnerRez reservation read ${messageId} in ${channelId}`);
      const payload = await execute(config, {
        workflow: 'ownerrez.occupancy.read',
        input: { start: request.start, end: request.end },
        context: {
          channelId,
          actorUserId,
          messageId,
          entrypoint: 'slack_reservations_read',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:ownerrez.occupancy.read:${request.mode}`,
      });
      return {
        handled: true,
        reply: { text: formatOwnerRezOccupancyReply(payload, { mode: request.mode }) },
      };
    } catch (error) {
      logger?.error?.(`resort-workflows OwnerRez calendar read failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `The live OwnerRez calendar is temporarily unavailable (${error.code || 'workflow_error'}). No booking answer was generated from CRM data or memory; please retry or check #ops.` },
      };
    }
  };
}

function reservationClaimEventFromFinalizedContext(ctx = {}) {
  return {
    channel: String(ctx.OriginatingChannel || ctx.Surface || ctx.Provider || '').toLowerCase(),
    accountId: ctx.AccountId,
    conversationId: String(ctx.OriginatingTo || ctx.To || ctx.From || '').replace(/^channel:/, ''),
    messageId: ctx.MessageSidFull || ctx.MessageSid || ctx.MessageSidFirst || ctx.MessageSidLast,
    senderId: ctx.SenderId,
    senderName: ctx.SenderName,
    senderUsername: ctx.SenderUsername,
    mentionedUserIds: Array.isArray(ctx.MentionedUserIds) ? ctx.MentionedUserIds : [],
    threadId: ctx.MessageThreadId,
    bodyForAgent: ctx.BodyForCommands || ctx.CommandBody || ctx.RawBody || ctx.Body || ctx.BodyForAgent || '',
  };
}

export function accountingCsvSignalFromFinalizedContext(ctx = {}) {
  const mediaTypes = [ctx.MediaType, ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : [])];
  if (mediaTypes.some(value => /^(?:text|application)\/csv(?:$|;)/i.test(String(value || '')))) {
    return true;
  }
  const mediaPaths = [ctx.MediaPath, ...(Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : [])];
  if (mediaPaths.some(value => String(value || '').toLowerCase().endsWith('.csv'))) return true;
  return [ctx.BodyForAgent, ctx.Body, ctx.RawBody]
    .some(value => /\[(?:media attached|Slack file):[^\]\n]*\.csv(?:[^\]\n]*)?\]/i.test(String(value || '')));
}

function normalizedTaskText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTaskAlias(body, alias) {
  const normalized = normalizedTaskText(alias);
  if (!normalized) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapedPattern(normalized)}(?:$|[^a-z0-9])`, 'i').test(body);
}

export function parseTaskListRequest(bodyValue, {
  senderId = '',
  senderName = '',
  mentionedUserIds = [],
  users = {},
} = {}) {
  const rawBody = String(bodyValue || '');
  const body = normalizedTaskText(rawBody);
  if (!body) return null;

  const hasTaskTerm = /\b(?:tasks?|task list|to-?dos?|assignments?|jobs?|work|work items?|open items?|tareas?|pendientes?|asignaciones?|trabajos?)\b/.test(body);
  const hasCompletionTerm = /\b(?:completed?|done|finished|completad[ao]s?|terminad[ao]s?|hech[ao]s?)\b/.test(body);
  const describesRequiredWork = [
    /\b(?:need(?:s|ed)?|remain(?:s|ing)?|left|still|yet|required)\b.{0,60}\b(?:to (?:be )?)?(?:done|completed|finished)\b/,
    /\b(?:to be done|left to do|what(?:'s| is) left)\b/,
    /\b(?:not|isn'?t|aren'?t)\s+(?:done|completed|finished)\b/,
    /\b(?:necesita(?:n)?|falta(?:n)?|queda(?:n)?|pendiente(?:s)?|por)\b.{0,60}\b(?:hacer|completar|terminar|hech[ao]s?|completad[ao]s?|terminad[ao]s?)\b/,
    /\bno\s+(?:esta(?:n)?\s+)?(?:hech[ao]s?|completad[ao]s?|terminad[ao]s?)\b/,
  ].some(pattern => pattern.test(body));
  const hasImplicitTaskQuestion = /\b(?:what (?:do|does) .{0,60}(?:need to|have to|supposed to) do|what should .{0,60} do|what (?:am i|is .{1,60}) assigned|what(?:'s| is) left(?: to do)?|que (?:tengo|tiene|debo|debe|necesito|necesita) (?:que )?hacer|que (?:me|le) toca|que falta(?: por hacer)?)\b/.test(body);
  const hasQueryIntent = rawBody.includes('?')
    || /\b(?:what|which|show|list|tell|give|how many|my|mine|have|has|assigned|remain(?:s|ing)?|left|que|cual(?:es)?|muestra|lista|dime|cuant[ao]s?|mis|mias|tengo|tiene|hay|falta(?:n)?|queda(?:n)?)\b/.test(body);
  const aliases = Object.entries(users || {}).filter(([, userId]) => String(userId || '').trim());
  const configuredUserIds = new Set(aliases.map(([, userId]) => String(userId)));
  const bodyMentions = [...rawBody.matchAll(/<@([A-Z][A-Z0-9]{2,63})>/gi)].map(match => match[1]);
  const targetMention = [...bodyMentions, ...mentionedUserIds.map(String)]
    .find(userId => configuredUserIds.has(userId));
  const matchedAlias = aliases
    .sort(([left], [right]) => right.length - left.length)
    .find(([alias]) => containsTaskAlias(body, alias));
  if ((!hasTaskTerm && !hasImplicitTaskQuestion
      && !(hasCompletionTerm && (targetMention || matchedAlias || senderId)))
      || !hasQueryIntent) return null;

  let status = 'active';
  if (/\b(?:task history|full history|historial(?: de)? tareas|incluyendo completad[ao]s?|including completed|active and completed|pendientes y completad[ao]s?)\b/.test(body)) {
    status = 'all';
  } else if (hasCompletionTerm && !describesRequiredWork) {
    status = 'completed';
  } else if (/\b(?:cancelled|canceled|cancelad[ao]s?)\b/.test(body)) {
    status = 'cancelled';
  } else if (/\b(?:in progress|en progreso)\b/.test(body)) {
    status = 'in_progress';
  }

  if (targetMention) return { status, userId: targetMention };
  if (matchedAlias) return { status, userId: String(matchedAlias[1]), selectorLabel: matchedAlias[0] };
  if (/\b(?:everyone|everybody|all staff|todo el personal|todas las personas|de todos|para todos)\b/.test(body)) {
    return { status, all: true };
  }
  if (!senderId) return { status, error: 'trusted_sender_unavailable' };
  return { status, userId: String(senderId), selectorLabel: String(senderName || '').trim() || undefined };
}

function agentIdFromSessionKey(sessionKey) {
  return String(sessionKey || '').match(/^agent:([^:]+):/)?.[1] || '';
}

function readTaskReport(config, request) {
  if (!config.taskTrackerDatabasePath || !config.taskTrackerConfigPath) {
    throw new Error('task tracker paths are not configured');
  }
  const users = loadUsers(config.taskTrackerConfigPath);
  const database = new Database(config.taskTrackerDatabasePath, { readonly: true, fileMustExist: true });
  try {
    return buildTaskReport(database, { ...request, users }).text;
  } finally {
    database.close();
  }
}

export function createTaskListClaimHandler({ config, report = readTaskReport, logger = null } = {}) {
  return async (event) => {
    if (event?.channel !== 'slack') return undefined;
    if (!config.taskTrackerAgentIds.has(String(event.agentId || ''))) return undefined;
    if (!config.taskTrackerAccountIds.has(String(event.accountId || ''))) return undefined;
    const channelId = String(event.conversationId || '').replace(/^channel:/, '');
    if (!config.taskTrackerChannelIds.has(channelId)) return undefined;

    let users = {};
    try {
      users = loadUsers(config.taskTrackerConfigPath);
    } catch (error) {
      logger?.error?.(`resort-workflows Paloma user alias read failed: ${error.message}`);
    }
    const request = parseTaskListRequest(event.bodyForAgent, {
      senderId: event.senderId,
      senderName: event.senderName,
      mentionedUserIds: event.mentionedUserIds,
      users,
    });
    if (!request) return undefined;
    if (request.error === 'trusted_sender_unavailable') {
      return {
        handled: true,
        reply: { text: 'No pude identificar de forma segura quién pidió la lista de tareas. Menciona a la persona por nombre e inténtalo de nuevo.\n\n───\n\nI could not securely identify who requested the task list. Name the assignee and try again.' },
      };
    }
    try {
      return { handled: true, reply: { text: await report(config, request) } };
    } catch (error) {
      logger?.error?.(`resort-workflows Paloma task report failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `No pude consultar la base de tareas de Paloma en este momento (${error.code || 'task_report_error'}). No generé una lista desde memoria. Inténtalo de nuevo.\n\n───\n\nI could not query Paloma's task database right now (${error.code || 'task_report_error'}). I did not generate a list from memory. Please try again.` },
      };
    }
  };
}

export function createTaskListReplyDispatchHandler(options = {}) {
  const claim = createTaskListClaimHandler(options);
  const logger = options.logger || null;
  return async (event, ctx) => {
    if (event?.isTailDispatch) return undefined;
    const inboundEvent = {
      ...reservationClaimEventFromFinalizedContext(event?.ctx),
      agentId: agentIdFromSessionKey(event?.sessionKey),
    };
    const result = await claim(inboundEvent);
    if (!result?.handled) return undefined;

    let queuedFinal = false;
    if (!event.suppressUserDelivery && event.sendPolicy !== 'deny' && result.reply) {
      try {
        await ctx.onReplyStart?.();
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
      } catch (error) {
        logger?.error?.(`resort-workflows deterministic Paloma task reply delivery failed: ${error.message}`);
      }
    }
    ctx.recordProcessed?.('completed', { reason: 'paloma_task_reply_dispatch' });
    ctx.markIdle?.('message_completed');
    return {
      handled: true,
      queuedFinal,
      counts: ctx.dispatcher.getQueuedCounts(),
    };
  };
}

export function createReservationReplyDispatchHandler(options = {}) {
  const claim = createReservationReadClaimHandler(options);
  const logger = options.logger || null;
  return async (event, ctx) => {
    if (event?.isTailDispatch) return undefined;
    const inboundEvent = reservationClaimEventFromFinalizedContext(event?.ctx);
    const result = await claim(inboundEvent, {
      channelId: inboundEvent.channel,
      accountId: inboundEvent.accountId,
      conversationId: inboundEvent.conversationId,
      messageId: inboundEvent.messageId,
      senderId: inboundEvent.senderId,
    });
    if (!result?.handled) return undefined;

    let queuedFinal = false;
    if (!event.suppressUserDelivery && event.sendPolicy !== 'deny' && result.reply) {
      try {
        await ctx.onReplyStart?.();
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
      } catch (error) {
        logger?.error?.(`resort-workflows deterministic reservation reply delivery failed: ${error.message}`);
      }
    }
    ctx.recordProcessed?.('completed', { reason: 'reservation_workflow_reply_dispatch' });
    ctx.markIdle?.('message_completed');
    return {
      handled: true,
      queuedFinal,
      counts: ctx.dispatcher.getQueuedCounts(),
    };
  };
}

// `inbound_claim` is not invoked for ordinary Slack channel conversations in
// OpenClaw 2026.5. Claim email commands again at the terminal pre-model
// `reply_dispatch` boundary so neither valid commands nor malformed `!email`
// attempts reach the model and produce improvised instructions or mutations.
export function createEmailReplyDispatchHandler(options = {}) {
  const claim = createEmailClaimHandler(options);
  const logger = options.logger || null;
  return async (event, ctx) => {
    if (event?.isTailDispatch) return undefined;
    const inboundEvent = reservationClaimEventFromFinalizedContext(event?.ctx);
    const result = await claim(inboundEvent, {
      channelId: inboundEvent.channel,
      accountId: inboundEvent.accountId,
      conversationId: inboundEvent.conversationId,
      messageId: inboundEvent.messageId,
      senderId: inboundEvent.senderId,
    });
    if (!result?.handled) return undefined;

    let queuedFinal = false;
    if (!event.suppressUserDelivery && event.sendPolicy !== 'deny' && result.reply) {
      try {
        await ctx.onReplyStart?.();
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
      } catch (error) {
        logger?.error?.(`resort-workflows deterministic email reply delivery failed: ${error.message}`);
      }
    }
    ctx.recordProcessed?.('completed', { reason: 'email_workflow_reply_dispatch' });
    ctx.markIdle?.('message_completed');
    return {
      handled: true,
      queuedFinal,
      counts: ctx.dispatcher.getQueuedCounts(),
    };
  };
}

export function createControlledChannelToolGuard({ config } = {}) {
  const controlled = new Set(
    [...config.controlledChannelIds].map(channelId => String(channelId).toLowerCase()),
  );
  return async (event, ctx) => {
    // The resort workflow policy belongs only to the agents explicitly named
    // in this plugin's configuration. Other agents can share the same Slack
    // channel while owning a separate, narrower data plane (Paloma's task
    // ledger is one example). Applying this guard globally leaves those agents
    // unable to use either their own tools or resort_workflow, because the tool
    // itself is registered only for config.agentIds.
    if (ctx?.agentId && !config.agentIds.has(ctx.agentId)) return undefined;
    const channelId = String(ctx?.channelId || channelIdFromToolContext(ctx) || '')
      .replace(/^channel:/, '').toLowerCase();
    if (!controlled.has(channelId) || event?.toolName === 'resort_workflow') return undefined;
    return {
      block: true,
      blockReason: 'This controlled resort channel is restricted to the durable resort_workflow control plane.',
    };
  };
}

export function createReservationToolGuard({ config } = {}) {
  return createControlledChannelToolGuard({
    config: {
      ...config,
      controlledChannelIds: config.reservationsChannelIds,
    },
  });
}

export function createInboundClaimHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.whatsappChannelIds.has(channelId)) return undefined;
    const text = event.bodyForAgent || event.body || event.content || '';
    const command = parseWhatsAppCommand(text, { hasThread: Boolean(event.threadId) });
    if (!command) return undefined;
    if (!workflowIsLive(config, 'whatsapp.reply')) {
      logger?.info?.(`resort-workflows shadow: would handle WhatsApp command ${event.messageId || '<no-id>'}`);
      return undefined;
    }
    if (command.error) {
      const usage = event.threadId ? '`!wa your message`' : '`!wa <wa-id> your message`';
      return { handled: true, reply: { text: `Not sent. Usage: ${usage}` } };
    }
    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      return { handled: true, reply: { text: 'Not sent. Slack did not provide a stable message ID, so this command cannot be deduplicated safely.' } };
    }
    try {
      const payload = await execute(config, {
        workflow: 'whatsapp.reply',
        input: {
          ...command,
          ...(event.threadId ? { threadTs: String(event.threadId) } : {}),
          actorName: event.senderName || event.senderUsername || 'Staff',
        },
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId,
          entrypoint: 'slack_whatsapp_command',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:whatsapp.reply`,
      });
      return { handled: true, reply: { text: formatWorkflowReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows WhatsApp command failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `Not sent. The durable WhatsApp workflow failed before a verified send state was recorded (${error.code || 'workflow_error'}).` },
      };
    }
  };
}

export function createOwnerRezClaimHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.ownerrezChannelIds.has(channelId)) return undefined;
    const command = parseOwnerRezConfirmCommand(event.bodyForAgent || event.body || event.content || '');
    if (!command) return undefined;
    if (!workflowIsLive(config, 'ownerrez.mutation.confirm')) {
      logger?.info?.(`resort-workflows shadow: would handle OwnerRez confirmation ${event.messageId || '<no-id>'}`);
      return {
        handled: true,
        reply: { text: 'Not changed. OwnerRez confirmations are still in shadow mode.' },
      };
    }
    if (command.error) {
      return {
        handled: true,
        reply: { text: 'Not changed. Use the exact confirmation command emitted by the proposal workflow.' },
      };
    }
    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      return { handled: true, reply: { text: 'Not changed. Slack did not provide a stable message ID, so this confirmation cannot be deduplicated safely.' } };
    }
    try {
      const payload = await execute(config, {
        workflow: 'ownerrez.mutation.confirm',
        input: command,
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId,
          entrypoint: 'slack_ownerrez_command',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:ownerrez.mutation.confirm`,
      });
      return { handled: true, reply: { text: formatWorkflowReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows OwnerRez confirmation failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `Not changed. The OwnerRez confirmation failed before verified readback (${error.code || 'workflow_error'}).` },
      };
    }
  };
}

export function createMetaDmClaimHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.socialChannelIds.has(channelId)) return undefined;
    const command = parseMetaDmCommand(event.bodyForAgent || event.body || event.content || '');
    if (!command) return undefined;
    if (!workflowIsLive(config, 'meta.dm.reply')) {
      return { handled: true, reply: { text: 'Not sent. Meta DM replies are still in shadow mode.' } };
    }
    if (command.error) {
      return { handled: true, reply: { text: 'Not sent. Use `!dm <dm-id> your message`.' } };
    }
    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      return { handled: true, reply: { text: 'Not sent. Slack did not provide a stable message ID, so this command cannot be deduplicated safely.' } };
    }
    try {
      const payload = await execute(config, {
        workflow: 'meta.dm.reply',
        input: { ...command, actorName: event.senderName || event.senderUsername || 'Staff' },
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId,
          entrypoint: 'slack_meta_dm_command',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:meta.dm.reply`,
      });
      return { handled: true, reply: { text: formatWorkflowReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows Meta DM command failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `Not sent. The durable Meta DM workflow did not record provider acceptance (${error.code || 'workflow_error'}).` },
      };
    }
  };
}

export function createEmailClaimHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.emailChannelIds.has(channelId)) return undefined;
    const command = parseEmailCommand(event.bodyForAgent || event.body || event.content || '', {
      hasThread: Boolean(event.threadId),
    });
    if (!command) return undefined;
    if (command.error) {
      return {
        handled: true,
        reply: { text: 'Not sent. Use `!email reply <message>` in the original message thread. An exact emitted `!email confirm ...` command can be pasted anywhere in this channel.' },
      };
    }
    const workflow = command.action === 'confirm' ? 'email.reply.confirm'
      : command.action === 'classify' ? 'email.message.classify'
        : 'email.reply.propose';
    if (!workflowIsLive(config, workflow)) {
      return { handled: true, reply: { text: 'Not sent. Email conversation commands are still in shadow mode.' } };
    }
    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      return { handled: true, reply: { text: 'Not sent. Slack did not provide a stable message ID, so this command cannot be deduplicated safely.' } };
    }
    const input = { ...command };
    delete input.action;
    if (event.threadId) input.threadTs = String(event.threadId);
    const entrypoint = command.action === 'confirm' ? 'slack_email_confirm_command'
      : command.action === 'classify' ? 'slack_email_classify_command'
        : 'slack_email_reply_command';
    try {
      const payload = await execute(config, {
        workflow,
        input,
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId,
          entrypoint,
        },
        idempotencyKey: `slack:${channelId}:${messageId}:${workflow}`,
      });
      return { handled: true, reply: { text: formatWorkflowReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows email command failed: ${error.message}`);
      const prefix = command.action === 'confirm' ? 'Not sent.'
        : command.action === 'classify' ? 'Classification not changed.'
          : 'No email proposal was created.';
      return { handled: true, reply: { text: `${prefix} The durable email workflow failed (${error.code || 'workflow_error'}).` } };
    }
  };
}

export function createMarketingConfirmClaimHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.socialChannelIds.has(channelId)) return undefined;
    const command = parseMarketingConfirmCommand(event.bodyForAgent || event.body || event.content || '');
    if (!command) return undefined;
    if (!workflowIsLive(config, 'marketing.change.confirm')) {
      return { handled: true, reply: { text: 'Not changed. Paid-media confirmations are still in shadow mode.' } };
    }
    if (command.error) {
      return { handled: true, reply: { text: 'Not changed. Use the exact `!meta confirm <proposal-id> <acceptance-hash>` command emitted by the proposal.' } };
    }
    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      return { handled: true, reply: { text: 'Not changed. Slack did not provide a stable message ID, so the confirmation cannot be deduplicated safely.' } };
    }
    try {
      const payload = await execute(config, {
        workflow: 'marketing.change.confirm',
        input: command,
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId,
          entrypoint: 'slack_meta_campaign_confirm_command',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:marketing.change.confirm`,
      });
      return { handled: true, reply: { text: formatWorkflowReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows paid-media confirmation failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `Not changed. The paid-media confirmation failed before verified readback (${error.code || 'workflow_error'}).` },
      };
    }
  };
}

export function createManualReviewClaimHandler({ config, resolve = resolveManualReview, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.controlledChannelIds.has(channelId)) return undefined;
    const command = parseManualReviewCommand(event.bodyForAgent || event.body || event.content || '');
    if (!command) return undefined;
    if (command.error) {
      return {
        handled: true,
        reply: { text: 'Review not changed. Use `!review resolve <review-id> sent <provider-id>`, `not-sent`, or `abandon`.' },
      };
    }
    try {
      const payload = await resolve(config, {
        ...command,
        channelId,
        actorUserId: event.senderId || ctx?.senderId,
      });
      return {
        handled: true,
        reply: { text: `Manual review ${payload.review.id} resolved as ${payload.review.resolution}.` },
      };
    } catch (error) {
      logger?.error?.(`resort-workflows manual review resolution failed: ${error.message}`);
      return { handled: true, reply: { text: `Review not changed (${error.code || 'workflow_error'}).` } };
    }
  };
}

export function createReceiptConfirmClaimHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!config.ownerExpenseChannelIds.has(channelId)) return undefined;
    const command = parseReceiptConfirmCommand(event.bodyForAgent || event.body || event.content || '');
    if (!command) return undefined;
    if (!workflowIsLive(config, 'receipt.owner_expense.confirm')) {
      return { handled: true, reply: { text: 'Nothing posted. Owner-expense confirmations are still in shadow mode.' } };
    }
    if (command.error) {
      return {
        handled: true,
        reply: { text: 'Nothing posted. Use the exact `!receipt confirm ...` command emitted in the receipt thread.' },
      };
    }
    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      return { handled: true, reply: { text: 'Nothing posted. Slack did not provide a stable message ID, so this confirmation cannot be deduplicated safely.' } };
    }
    try {
      const payload = await execute(config, {
        workflow: 'receipt.owner_expense.confirm',
        input: command,
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId,
          entrypoint: 'slack_receipt_confirm_command',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:receipt.owner_expense.confirm`,
      });
      const run = payload?.run;
      if (!run || !['completed', 'queued', 'running'].includes(run.status)) {
        return { handled: true, reply: { text: formatWorkflowReply(payload) } };
      }
      return {
        handled: true,
        reply: { text: `Correction queued for durable processing and QBO readback. Receipt: ${command.receiptId} · Workflow: ${run.id}` },
      };
    } catch (error) {
      logger?.error?.(`resort-workflows owner expense confirmation failed: ${error.message}`);
      return { handled: true, reply: { text: `Nothing posted. The owner-expense confirmation failed (${error.code || 'workflow_error'}).` } };
    }
  };
}

export function createFinalizeHandler({ config } = {}) {
  return async (event, ctx) => {
    const channelId = String(ctx?.channelId || event?.channelId || '');
    const text = String(event?.lastAssistantMessage || '');
    if (config.whatsappChannelIds.has(channelId)) {
      const claimsDelivery = /\b(delivered|read|viewed)\b/i.test(text);
      const hasArtifact = /twilio-confirmed|not confirmed|unconfirmed/i.test(text);
      if (claimsDelivery && !hasArtifact) {
        return {
          action: 'revise',
          reason: 'WhatsApp delivery/read claim lacks a Twilio-confirmed artifact.',
          retry: {
            instruction: 'Do not claim WhatsApp delivery, viewing, or reading unless a persisted Twilio callback confirms that exact state. State what is confirmed and what remains unconfirmed.',
            idempotencyKey: 'whatsapp-claim-verification',
            maxAttempts: 1,
          },
        };
      }
    }
    if (!config.controlledChannelIds.has(channelId)) return undefined;
    const claimsMutation = /\b(?:sent|published|posted|scheduled|created|updated|wrote|written|synced|completed|reconciled)\b/i.test(text);
    const hasEvidence = /\b(?:workflow|effect|evidence)\s*[:#·]?\s*[0-9a-f-]{8,}|verified[- ]by[- ]readback|(?:twilio|postiz|resend|quickbooks|ownerrez)[- ]confirmed|not confirmed|unconfirmed/i.test(text);
    if (!claimsMutation || hasEvidence) return undefined;
    return {
      action: 'revise',
      reason: 'External mutation/completion claim lacks a durable workflow or provider artifact.',
      retry: {
        instruction: 'State only the persisted workflow/provider status. Include the workflow, effect, or evidence id; otherwise say the action is not verified.',
        idempotencyKey: 'resort-mutation-claim-verification',
        maxAttempts: 1,
      },
    };
  };
}

export function createReceiptHandler({ config, execute = callControlPlane, logger = null } = {}) {
  return async (event, ctx) => {
    if (ctx?.channelId !== 'slack') return;
    if (config.slackAccountId && ctx.accountId && ctx.accountId !== config.slackAccountId) return;
    const channelId = resolveSlackConversationId(event, ctx);
    if (!channelId || !config.receiptChannelIds.has(channelId)) return;
    // A receipt-channel thread is discussion about the original reimbursement,
    // not a second reimbursement. Only top-level posts enter the automatic flow.
    if (event.threadId) return;
    const workflow = config.ownerExpenseChannelIds.has(channelId)
      ? 'receipt.owner_expense.ingest'
      : 'receipt.ingest';
    if (!workflowIsLive(config, workflow)) {
      logger?.info?.(`resort-workflows shadow: would ingest receipt ${ctx.messageId || event.messageId || '<no-id>'}`);
      return;
    }
    const messageId = String(ctx.messageId || event.messageId || '');
    const actorUserId = String(ctx.senderId || event.senderId || '');
    if (!messageId || !actorUserId) {
      logger?.error?.('resort-workflows receipt ingest skipped: trusted message/user identity unavailable');
      return;
    }
    try {
      await execute(config, {
        workflow,
        input: {
          slackMessageId: messageId,
        },
        context: { channelId, actorUserId, messageId, entrypoint: 'slack_receipt_hook' },
        idempotencyKey: `slack:${channelId}:${messageId}:${workflow}`,
      });
    } catch (error) {
      logger?.error?.(`resort-workflows receipt ingest failed: ${error.code || error.message}`);
    }
  };
}

export function parseReceiptPaymentSourceAction(value) {
  const match = String(value || '').trim().match(/^(personal|kapital|reimbursed):([0-9a-f-]{36})$/i);
  if (!match) return null;
  const sources = {
    personal: 'personal_reimbursement',
    kapital: 'kapital_business_paid',
    reimbursed: 'already_reimbursed',
  };
  return {
    paymentSource: sources[match[1].toLowerCase()],
    receiptId: match[2].toLowerCase(),
  };
}

function receiptPaymentSourceLabel(paymentSource) {
  if (paymentSource === 'personal_reimbursement') return 'Reembolso personal';
  if (paymentSource === 'kapital_business_paid') return 'Pagado con Kapital';
  if (paymentSource === 'already_reimbursed') return 'Ya reembolsado';
  return 'Fuente desconocida';
}

export function createReceiptPaymentSourceInteractionHandler({
  config, execute = callControlPlane, logger = null,
} = {}) {
  return async ctx => {
    const action = parseReceiptPaymentSourceAction(ctx?.interaction?.payload);
    if (!action) return { handled: false };
    const channelId = String(ctx?.conversationId || '');
    const actorUserId = String(ctx?.senderId || '');
    const messageId = String(ctx?.interaction?.messageTs || ctx?.interactionId || '');
    if (!config.receiptChannelIds.has(channelId) || config.ownerExpenseChannelIds.has(channelId)) {
      await ctx.respond?.reply?.({ text: 'Esta opción no corresponde a un canal de comprobantes.', responseType: 'ephemeral' });
      return { handled: true };
    }
    if (!workflowIsLive(config, 'receipt.payment_source.select')) {
      await ctx.respond?.reply?.({ text: 'La selección de fuente de pago no está activa.', responseType: 'ephemeral' });
      return { handled: true };
    }
    if (!actorUserId || !messageId) {
      await ctx.respond?.reply?.({ text: 'No se pudo verificar tu identidad o el mensaje de Slack.', responseType: 'ephemeral' });
      return { handled: true };
    }
    await ctx.respond?.acknowledge?.();
    try {
      const payload = await execute(config, {
        workflow: 'receipt.payment_source.select',
        input: action,
        context: {
          channelId,
          actorUserId,
          messageId,
          entrypoint: 'slack_receipt_source_action',
        },
        idempotencyKey: `receipt:${action.receiptId}:payment-source:${action.paymentSource}`,
      });
      const run = payload?.run;
      if (!run || run.status === 'failed') {
        throw Object.assign(new Error(run?.error_message || 'la selección no se completó'), {
          code: run?.error_code || 'workflow_failed',
        });
      }
      const label = receiptPaymentSourceLabel(action.paymentSource);
      await ctx.respond?.editMessage?.({
        text: `✅ Fuente de pago: *${label}*. La selección quedó vinculada a este gasto y la clasificación continúa automáticamente.`,
        blocks: [],
      });
      return { handled: true };
    } catch (error) {
      logger?.error?.(`resort-workflows receipt payment-source selection failed: ${error.code || error.message}`);
      const locked = error.code === 'receipt_payment_source_locked';
      await ctx.respond?.reply?.({
        text: locked
          ? 'La fuente de pago ya está bloqueada. Cualquier cambio requiere revisión manual de contabilidad.'
          : `No se guardó la selección (${error.code || 'workflow_error'}).`,
        responseType: 'ephemeral',
      });
      return { handled: true };
    }
  };
}

export function createAccountingStatementClaimHandler({
  config,
  stage = stageSlackAccountingStatement,
  logger = null,
} = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!channelId || !config.accountingChannelIds.has(channelId)) return undefined;
    if (!event.hasCsvAttachment) return undefined;
    const workflowReady = ['accounting.classify', 'receipt.reconcile', 'qbo.write']
      .every(workflow => workflowIsLive(config, workflow));
    if (!workflowReady) {
      logger?.info?.('resort-workflows accounting CSV intake is disabled until the full statement workflow is live');
      return {
        handled: true,
        reply: { text: '⚠️ I detected the CSV, but the complete accounting workflow is not live. Nothing was staged or written to QBO. Check #ops before retrying.' },
      };
    }

    const messageId = trustedMessageId(event, ctx);
    if (!messageId) {
      logger?.error?.('resort-workflows accounting CSV skipped: trusted message identity unavailable');
      return {
        handled: true,
        reply: { text: '⚠️ I detected the CSV, but trusted Slack message identity was unavailable. Nothing was staged or written to QBO.' },
      };
    }
    try {
      const result = await stage({
        channelId,
        messageId,
        threadTs: event.threadId ? String(event.threadId) : null,
      });
      const staged = result.files?.filter(file => file.staged).length || 0;
      const alreadyCaptured = result.files?.filter(file => file.alreadyCaptured).length || 0;
      const alreadyProcessed = result.files?.filter(file => file.alreadyProcessed).length || 0;
      const total = result.files?.length || 0;
      logger?.info?.(`resort-workflows accounting CSV intake: staged ${staged}, already captured ${alreadyCaptured}, already processed ${alreadyProcessed} of ${total} file(s) from ${messageId}`);
      if (alreadyProcessed === total && total > 0) {
        return {
          handled: true,
          reply: { text: '✅ This exact Kapital CSV was already processed successfully. It was not queued or written to QBO again.' },
        };
      }
      if (alreadyCaptured === total && total > 0) {
        return {
          handled: true,
          reply: { text: '✅ This exact Kapital CSV is already captured and is queued or processing. No second QBO run was created.' },
        };
      }
      if (total < 1) throw new Error('Slack accounting intake returned no CSV results');
      const status = [`${staged} newly queued`];
      if (alreadyCaptured) status.push(`${alreadyCaptured} already queued or processing`);
      if (alreadyProcessed) status.push(`${alreadyProcessed} already processed`);
      return {
        handled: true,
        reply: {
          text: `✅ Kapital CSV verified from this exact Slack message: ${status.join(', ')}. The deterministic classify → receipt reconcile → QBO workflow will post a separate completion notice with verified writes, deduplications, and held items. Do not re-upload while it runs.`,
        },
      };
    } catch (error) {
      logger?.error?.(`resort-workflows accounting CSV intake failed: ${error.code || error.message}`);
      return {
        handled: true,
        reply: {
          text: error.code === 'accounting_csv_missing'
            ? '⚠️ Slack showed a CSV attachment marker, but provider readback could not verify a CSV on this exact message. Nothing was staged or written to QBO; please retry the upload.'
            : `⚠️ The Kapital CSV could not be captured (${error.code || 'accounting_intake_error'}). Nothing was written to QBO; check #ops before retrying.`,
        },
      };
    }
  };
}

export function parseAccountingReconciliationRequest(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('!')) return null;
  const body = normalizedTaskText(raw);
  const explicitLatest = /\b(?:latest|most recent|last|current)\b.{0,50}\b(?:reconciliation|statement)\b/.test(body)
    || /\b(?:reconciliation|statement)\b.{0,50}\b(?:latest|most recent|last|current|status|breakdown|summary)\b/.test(body);
  const completeness = /\b(?:transactions?|entries|fees?)\b.{0,50}\b(?:not recorded|missing|unrecorded|in qbo|written to qbo)\b/.test(body)
    || /\b(?:anything|what|which)\b.{0,30}\b(?:missing|not recorded|unrecorded)\b.{0,30}\bqbo\b/.test(body);
  const transactionList = /\b(?:list|show|display|give)\b.{0,80}\b(?:reconciled|recorded|posted)\b.{0,30}\btransactions?\b/.test(body)
    || /\b(?:reconciled|recorded|posted)\s+transactions?\b.{0,80}\b(?:list|order|recent|newest|latest)\b/.test(body);
  if (!explicitLatest && !completeness && !transactionList) return null;
  if (transactionList) {
    const ascending = /\b(?:oldest|earliest|ascending|asc)\b/.test(body)
      && !/\b(?:most recent|newest|latest|descending|desc)\b/.test(body);
    return { detail: true, view: 'transactions', order: ascending ? 'asc' : 'desc' };
  }
  return { detail: true, view: 'summary', order: 'desc' };
}

function accountingDateFromText(value) {
  const match = String(value || '').match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (!match) return null;
  const month = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  }[match[1].slice(0, 3).toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseAccountingTransactionRequest(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('!')) return null;
  const body = normalizedTaskText(raw);
  if (/\b(?:list|breakdown|summary)\b.{0,60}\b(?:reconciliation|reconciled transactions?)\b/.test(body)) return null;
  const intent = (/\b(?:verify|check|confirm)\b/.test(body)
    && /\b(?:qbo|quickbooks|posted|recorded|other liabilit(?:y|ies))\b/.test(body))
    || /\b(?:was|has|is)\b.{0,50}\b(?:posted|recorded)\b.{0,30}\b(?:qbo|quickbooks)\b/.test(body);
  if (!intent) return null;
  const amountAfter = raw.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(MXN|USD)\b/i);
  const amountBefore = raw.match(/\b(MXN|USD)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amount = Number(String(amountAfter?.[1] || amountBefore?.[2] || '').replaceAll(',', ''));
  const currency = String(amountAfter?.[2] || amountBefore?.[1] || '').toUpperCase() || null;
  const date = accountingDateFromText(raw) || raw.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || null;
  const payee = raw.match(/(?:^|\n)\s*[*_•-]*\s*(?:payee|vendor)\s*:\s*([^\n]+)/i)?.[1]
    ?.replace(/[*_]/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim().slice(0, 160) || null;
  const reference = raw.match(/(?:^|\n)\s*[*_•-]*\s*(?:reference|ref(?:erencia)?|folio)\s*:\s*([^\s*_<>{}|]+)/i)?.[1]
    ?.trim().slice(0, 160) || null;
  if (!Number.isFinite(amount) || amount <= 0 || (!date && !payee && !reference)) return null;
  return {
    amount,
    ...(currency ? { currency } : {}),
    ...(date ? { date } : {}),
    detail: true,
    limit: 10,
    order: 'desc',
    ...(payee || reference ? { query: payee || reference } : {}),
  };
}

export function createAccountingTransactionClaimHandler({
  config,
  execute = callControlPlane,
  logger = null,
} = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!channelId || !config.accountingChannelIds.has(channelId) || event.hasCsvAttachment) return undefined;
    const input = parseAccountingTransactionRequest(event.bodyForAgent || event.body || event.content || '');
    if (!input) return undefined;
    const messageId = trustedMessageId(event, ctx);
    const actorUserId = String(event.senderId || ctx?.senderId || '');
    if (!messageId || !actorUserId) {
      return {
        handled: true,
        reply: { text: 'The authoritative transaction lookup was not run because trusted Slack message/user identity was unavailable. No QBO status was inferred.' },
      };
    }
    try {
      logger?.info?.(`resort-workflows claiming accounting transaction read ${messageId} in ${channelId}`);
      const payload = await execute(config, {
        workflow: 'receipts.status.read',
        input,
        context: {
          channelId,
          actorUserId,
          messageId,
          entrypoint: 'slack_accounting_transaction_read',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:accounting.transaction.read`,
      });
      return { handled: true, reply: { text: formatAccountingTransactionReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows accounting transaction read failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `The authoritative transaction ledger is temporarily unavailable (${error.code || 'workflow_error'}). No QBO status was inferred; please retry or check #ops.` },
      };
    }
  };
}

export function createAccountingTransactionReplyDispatchHandler(options = {}) {
  const claim = createAccountingTransactionClaimHandler(options);
  const logger = options.logger || null;
  return async (event, ctx) => {
    if (event?.isTailDispatch) return undefined;
    const inboundEvent = {
      ...reservationClaimEventFromFinalizedContext(event?.ctx),
      hasCsvAttachment: accountingCsvSignalFromFinalizedContext(event?.ctx),
    };
    const result = await claim(inboundEvent, {
      channelId: inboundEvent.channel,
      accountId: inboundEvent.accountId,
      conversationId: inboundEvent.conversationId,
      messageId: inboundEvent.messageId,
      senderId: inboundEvent.senderId,
    });
    if (!result?.handled) return undefined;
    let queuedFinal = false;
    if (!event.suppressUserDelivery && event.sendPolicy !== 'deny' && result.reply) {
      try {
        await ctx.onReplyStart?.();
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
      } catch (error) {
        logger?.error?.(`resort-workflows deterministic accounting transaction reply delivery failed: ${error.message}`);
      }
    }
    ctx.recordProcessed?.('completed', { reason: 'accounting_transaction_reply_dispatch' });
    ctx.markIdle?.('message_completed');
    return { handled: true, queuedFinal, counts: ctx.dispatcher.getQueuedCounts() };
  };
}

export function createAccountingReconciliationClaimHandler({
  config,
  execute = callControlPlane,
  logger = null,
} = {}) {
  return async (event, ctx) => {
    if (event?.channel !== 'slack') return undefined;
    if (config.slackAccountId && event.accountId && event.accountId !== config.slackAccountId) return undefined;
    const channelId = String(event.conversationId || ctx?.conversationId || '').replace(/^channel:/, '');
    if (!channelId || !config.accountingChannelIds.has(channelId) || event.hasCsvAttachment) return undefined;
    const input = parseAccountingReconciliationRequest(
      event.bodyForAgent || event.body || event.content || '',
    );
    if (!input) return undefined;
    const messageId = trustedMessageId(event, ctx);
    const actorUserId = String(event.senderId || ctx?.senderId || '');
    if (!messageId || !actorUserId) {
      return {
        handled: true,
        reply: { text: 'The authoritative QBO reconciliation lookup was not run because trusted Slack message/user identity was unavailable. No answer was generated from channel history.' },
      };
    }
    try {
      logger?.info?.(`resort-workflows claiming accounting reconciliation read ${messageId} in ${channelId}`);
      const payload = await execute(config, {
        workflow: 'accounting.reconciliation.read',
        input,
        context: {
          channelId,
          actorUserId,
          messageId,
          entrypoint: 'slack_accounting_reconciliation_read',
        },
        idempotencyKey: `slack:${channelId}:${messageId}:accounting.reconciliation.read`,
      });
      return { handled: true, reply: { text: formatAccountingReconciliationReply(payload) } };
    } catch (error) {
      logger?.error?.(`resort-workflows accounting reconciliation read failed: ${error.message}`);
      return {
        handled: true,
        reply: { text: `The authoritative QBO reconciliation ledger is temporarily unavailable (${error.code || 'workflow_error'}). No answer was generated from channel history; please retry or check #ops.` },
      };
    }
  };
}

export function createAccountingReconciliationReplyDispatchHandler(options = {}) {
  const claim = createAccountingReconciliationClaimHandler(options);
  const logger = options.logger || null;
  return async (event, ctx) => {
    if (event?.isTailDispatch) return undefined;
    const inboundEvent = {
      ...reservationClaimEventFromFinalizedContext(event?.ctx),
      hasCsvAttachment: accountingCsvSignalFromFinalizedContext(event?.ctx),
    };
    const result = await claim(inboundEvent, {
      channelId: inboundEvent.channel,
      accountId: inboundEvent.accountId,
      conversationId: inboundEvent.conversationId,
      messageId: inboundEvent.messageId,
      senderId: inboundEvent.senderId,
    });
    if (!result?.handled) return undefined;

    let queuedFinal = false;
    if (!event.suppressUserDelivery && event.sendPolicy !== 'deny' && result.reply) {
      try {
        await ctx.onReplyStart?.();
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
      } catch (error) {
        logger?.error?.(`resort-workflows deterministic accounting reconciliation reply delivery failed: ${error.message}`);
      }
    }
    ctx.recordProcessed?.('completed', { reason: 'accounting_reconciliation_reply_dispatch' });
    ctx.markIdle?.('message_completed');
    return {
      handled: true,
      queuedFinal,
      counts: ctx.dispatcher.getQueuedCounts(),
    };
  };
}

export function createAccountingStatementReplyDispatchHandler(options = {}) {
  const claim = createAccountingStatementClaimHandler(options);
  const logger = options.logger || null;
  return async (event, ctx) => {
    if (event?.isTailDispatch) return undefined;
    const inboundEvent = {
      ...reservationClaimEventFromFinalizedContext(event?.ctx),
      hasCsvAttachment: accountingCsvSignalFromFinalizedContext(event?.ctx),
    };
    const result = await claim(inboundEvent, {
      channelId: inboundEvent.channel,
      accountId: inboundEvent.accountId,
      conversationId: inboundEvent.conversationId,
      messageId: inboundEvent.messageId,
      senderId: inboundEvent.senderId,
    });
    if (!result?.handled) return undefined;

    let queuedFinal = false;
    if (!event.suppressUserDelivery && event.sendPolicy !== 'deny' && result.reply) {
      try {
        await ctx.onReplyStart?.();
        queuedFinal = ctx.dispatcher.sendFinalReply(result.reply);
      } catch (error) {
        logger?.error?.(`resort-workflows deterministic accounting intake reply delivery failed: ${error.message}`);
      }
    }
    ctx.recordProcessed?.('completed', { reason: 'accounting_statement_reply_dispatch' });
    ctx.markIdle?.('message_completed');
    return {
      handled: true,
      queuedFinal,
      counts: ctx.dispatcher.getQueuedCounts(),
    };
  };
}

const plugin = {
  id: 'resort-workflows',
  name: 'Resort Workflows',
  description: 'Durable, channel-authorized resort workflows with verified effect states.',
  register(api) {
    const config = pluginConfig(api.pluginConfig);
    api.registerTool((ctx) => {
      if (!config.agentIds.has(ctx.agentId)) return null;
      return createWorkflowTool({ config, ctx });
    }, { name: 'resort_workflow' });
    api.registerInteractiveHandler({
      channel: 'slack',
      namespace: 'receiptsource',
      handler: createReceiptPaymentSourceInteractionHandler({ config, logger: api.logger }),
    });
    // OpenClaw 2026.5 invokes inbound_claim only for plugin-bound conversations.
    // reply_dispatch is the terminal pre-model hook for ordinary Slack channels.
    api.on('reply_dispatch', createAccountingTransactionReplyDispatchHandler({ config, logger: api.logger }), { priority: 170, timeoutMs: 70_000 });
    api.on('reply_dispatch', createAccountingReconciliationReplyDispatchHandler({ config, logger: api.logger }), { priority: 175, timeoutMs: 70_000 });
    api.on('reply_dispatch', createAccountingStatementReplyDispatchHandler({ config, logger: api.logger }), { priority: 180, timeoutMs: 70_000 });
    api.on('reply_dispatch', createTaskListReplyDispatchHandler({ config, logger: api.logger }), { priority: 185, timeoutMs: 10_000 });
    api.on('reply_dispatch', createReservationReplyDispatchHandler({ config, logger: api.logger }), { priority: 190, timeoutMs: 70_000 });
    api.on('reply_dispatch', createEmailReplyDispatchHandler({ config, logger: api.logger }), { priority: 195, timeoutMs: 70_000 });
    api.on('before_tool_call', createControlledChannelToolGuard({ config }), { priority: 50, timeoutMs: 5_000 });
    api.on('inbound_claim', createReservationReadClaimHandler({ config, logger: api.logger }), { priority: 190, timeoutMs: 70_000 });
    api.on('inbound_claim', createInboundClaimHandler({ config, logger: api.logger }), { priority: 200, timeoutMs: 70_000 });
    api.on('inbound_claim', createOwnerRezClaimHandler({ config, logger: api.logger }), { priority: 210, timeoutMs: 70_000 });
    api.on('inbound_claim', createMetaDmClaimHandler({ config, logger: api.logger }), { priority: 205, timeoutMs: 70_000 });
    api.on('inbound_claim', createEmailClaimHandler({ config, logger: api.logger }), { priority: 206, timeoutMs: 70_000 });
    api.on('inbound_claim', createMarketingConfirmClaimHandler({ config, logger: api.logger }), { priority: 207, timeoutMs: 70_000 });
    api.on('inbound_claim', createManualReviewClaimHandler({ config, logger: api.logger }), { priority: 220, timeoutMs: 35_000 });
    api.on('inbound_claim', createReceiptConfirmClaimHandler({ config, logger: api.logger }), { priority: 215, timeoutMs: 70_000 });
    api.on('message_received', createReceiptHandler({ config, logger: api.logger }), { priority: 100, timeoutMs: 70_000 });
    api.on('before_agent_finalize', createFinalizeHandler({ config }), { priority: 100, timeoutMs: 5_000 });
  },
};

export {
  callControlPlane,
  channelIdFromToolContext,
  controlPlaneToken,
  extractFileRefs,
  eventTimestampIso,
  pluginConfig,
  resolveSlackConversationId,
  statusTruth,
  textResult,
  workflowIsLive,
};
export default plugin;
