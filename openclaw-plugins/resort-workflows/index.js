import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stageSlackAccountingStatement } = require('../../crm/lib/accounting-slack-inbox.js');

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
        'paulina.performance.read',
        'guest.reply.draft',
        'ownerrez.mutation.propose',
      ],
      description: 'Versioned workflow to execute.',
    },
    input: {
      type: 'object',
      description: 'Workflow input. For whatsapp.reply pass message and optionally dmId; the trusted Slack thread is supplied by the plugin.',
      additionalProperties: true,
    },
  },
};

const COMMAND_ONLY_WORKFLOWS = new Set([
  'whatsapp.reply',
  'meta.dm.reply',
  'ownerrez.mutation.confirm',
  'marketing.change.confirm',
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
      `Expires: ${output.expiresAt || 'unknown'}`,
      'After reviewing the exact message above, paste this command as a new Slack message:',
      `\`${output.confirmationCommand || 'confirmation command unavailable'}\``,
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
        ...(ctx.deliveryContext?.threadId ? { threadTs: String(ctx.deliveryContext.threadId) } : {}),
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
  const body = String(text || '').trim();
  if (!/^!email(?:\s|$)/i.test(body)) return null;
  if (!hasThread) return { error: 'original_thread_required' };
  const confirm = body.match(/^!email\s+confirm\s+([0-9a-f-]{36})\s+([0-9a-f]{12})\s*$/i);
  if (confirm) return {
    action: 'confirm', proposalId: confirm[1].toLowerCase(), acceptanceHash: confirm[2].toLowerCase(),
  };
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
    threadId: ctx.MessageThreadId,
    bodyForAgent: ctx.BodyForCommands || ctx.CommandBody || ctx.RawBody || ctx.Body || ctx.BodyForAgent || '',
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
    if (!config.whatsappChannelIds.has(channelId)) return undefined;
    const text = event.bodyForAgent || event.body || event.content || '';
    const command = parseWhatsAppCommand(text, { hasThread: Boolean(event.threadId) });
    if (!command) {
      if (event.threadId && !config.shadowMode) {
        return {
          handled: true,
          reply: { text: 'Not sent. Prefix a guest-facing reply with `!wa ` so an ordinary channel question cannot accidentally message the guest.' },
        };
      }
      return undefined;
    }
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
    if (!config.emailChannelIds.has(channelId)) return undefined;
    const command = parseEmailCommand(event.bodyForAgent || event.body || event.content || '', {
      hasThread: Boolean(event.threadId),
    });
    if (!command) return undefined;
    if (command.error) {
      return {
        handled: true,
        reply: { text: 'Not sent. Use `!email reply <message>` in the original message thread. Confirm there with the exact emitted `!email confirm ...` command.' },
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
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
    const channelId = String(event.conversationId || ctx?.conversationId || '');
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
          threadTs: event.threadId ? String(event.threadId) : null,
          messageText: String(event.content || ''),
          submittedAt: eventTimestampIso(event.timestamp),
          fileRefs: extractFileRefs(event.metadata || {}),
        },
        context: { channelId, actorUserId, messageId, entrypoint: 'slack_receipt_hook' },
        idempotencyKey: `slack:${channelId}:${messageId}:${workflow}`,
      });
    } catch (error) {
      logger?.error?.(`resort-workflows receipt ingest failed: ${error.code || error.message}`);
    }
  };
}

export function createAccountingStatementHandler({
  config,
  stage = stageSlackAccountingStatement,
  logger = null,
} = {}) {
  return async (event, ctx) => {
    if (ctx?.channelId !== 'slack') return;
    if (config.slackAccountId && ctx.accountId && ctx.accountId !== config.slackAccountId) return;
    const channelId = resolveSlackConversationId(event, ctx);
    if (!channelId || !config.accountingChannelIds.has(channelId)) return;
    const workflowReady = ['accounting.classify', 'receipt.reconcile', 'qbo.write']
      .every(workflow => workflowIsLive(config, workflow));
    if (!workflowReady) {
      logger?.info?.('resort-workflows shadow: accounting CSV intake is disabled until the full statement workflow is live');
      return;
    }
    const fileRefs = extractFileRefs(event.metadata || {});
    const hasCsv = fileRefs.some(file => String(file.name || '').toLowerCase().endsWith('.csv')
      || /^(?:text|application)\/csv(?:$|;)/i.test(String(file.mimetype || '')));
    if (!hasCsv) return;

    const messageId = String(ctx.messageId || event.messageId || '');
    if (!messageId) {
      logger?.error?.('resort-workflows accounting CSV skipped: trusted message identity unavailable');
      return;
    }
    try {
      const result = await stage({
        channelId,
        messageId,
        threadTs: event.threadId ? String(event.threadId) : null,
      });
      const staged = result.files?.filter(file => file.staged).length || 0;
      logger?.info?.(`resort-workflows accounting CSV intake: staged ${staged} of ${result.files?.length || 0} file(s) from ${messageId}`);
    } catch (error) {
      logger?.error?.(`resort-workflows accounting CSV intake failed: ${error.code || error.message}`);
    }
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
    // OpenClaw 2026.5 invokes inbound_claim only for plugin-bound conversations.
    // reply_dispatch is the terminal pre-model hook for ordinary Slack channels.
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
    api.on('message_received', createAccountingStatementHandler({ config, logger: api.logger }), { priority: 110, timeoutMs: 70_000 });
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
