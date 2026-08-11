import crypto from 'node:crypto';
import fs from 'node:fs';

const WORKFLOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'input'],
  properties: {
    workflow: {
      type: 'string',
      enum: [
        'whatsapp.reply',
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
        'whatsapp.status.read',
        'receipts.status.read',
        'receipts.scoped.read',
        'social.content.read',
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

function pluginConfig(value = {}) {
  const parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    agentIds: new Set(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter(Boolean) : ['resort']),
    crmBaseUrl: String(parsed.crmBaseUrl || 'http://127.0.0.1:3456').replace(/\/+$/, ''),
    slackAccountId: String(parsed.slackAccountId || ''),
    whatsappChannelIds: new Set(Array.isArray(parsed.whatsappChannelIds) ? parsed.whatsappChannelIds.filter(Boolean) : []),
    ownerrezChannelIds: new Set(Array.isArray(parsed.ownerrezChannelIds) ? parsed.ownerrezChannelIds.filter(Boolean) : []),
    receiptChannelIds: new Set(Array.isArray(parsed.receiptChannelIds) ? parsed.receiptChannelIds.filter(Boolean) : []),
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

export function formatWorkflowReply(payload) {
  const run = payload?.run;
  if (!run) return 'The workflow returned no durable run record.';
  if (run.status !== 'completed') {
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
  if (run.workflow_name === 'ownerrez.mutation.confirm') {
    const output = run.output || {};
    return [
      `OwnerRez change verified by readback (${output.operationId || 'operation'}).`,
      `Proposal: ${output.proposalId || 'unknown'}`,
      `Workflow: ${run.id}${output.effectId ? ` · Effect: ${output.effectId}` : ''}${output.evidenceId ? ` · Evidence: ${output.evidenceId}` : ''}`,
    ].join('\n');
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
  return payload;
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

export function parseOwnerRezConfirmCommand(text) {
  const body = String(text || '').trim();
  if (!/^!ownerrez(?:\s|$)/i.test(body)) return null;
  const match = body.match(/^!ownerrez\s+confirm\s+([0-9a-f-]{36})\s+([0-9a-f]{8,12})\s*$/i);
  if (!match) return { error: 'invalid_confirmation' };
  return { proposalId: match[1].toLowerCase(), acceptanceHash: match[2].toLowerCase() };
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
          messageId: event.messageId || ctx?.messageId,
        },
        idempotencyKey: `slack:${channelId}:${event.messageId || crypto.randomUUID()}:whatsapp.reply`,
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
    try {
      const payload = await execute(config, {
        workflow: 'ownerrez.mutation.confirm',
        input: command,
        context: {
          channelId,
          actorUserId: event.senderId || ctx?.senderId,
          messageId: event.messageId || ctx?.messageId,
        },
        idempotencyKey: `slack:${channelId}:${event.messageId || crypto.randomUUID()}:ownerrez.mutation.confirm`,
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
    if (!workflowIsLive(config, 'receipt.ingest')) {
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
        workflow: 'receipt.ingest',
        input: {
          slackMessageId: messageId,
          threadTs: event.threadId ? String(event.threadId) : null,
          messageText: String(event.content || ''),
          submittedAt: eventTimestampIso(event.timestamp),
          fileRefs: extractFileRefs(event.metadata || {}),
        },
        context: { channelId, actorUserId, messageId },
        idempotencyKey: `slack:${channelId}:${messageId}:receipt.ingest`,
      });
    } catch (error) {
      logger?.error?.(`resort-workflows receipt ingest failed: ${error.code || error.message}`);
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
    api.on('inbound_claim', createInboundClaimHandler({ config, logger: api.logger }), { priority: 200, timeoutMs: 70_000 });
    api.on('inbound_claim', createOwnerRezClaimHandler({ config, logger: api.logger }), { priority: 210, timeoutMs: 70_000 });
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
