import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinalizeHandler,
  createInboundClaimHandler,
  createOwnerRezClaimHandler,
  createReceiptHandler,
  createWorkflowTool,
  formatWorkflowReply,
  parseWhatsAppCommand,
  parseOwnerRezConfirmCommand,
  pluginConfig,
} from './index.js';

const COMPLETED = {
  run: {
    id: 'run-1',
    workflow_name: 'whatsapp.reply',
    status: 'completed',
    output: { recipient: 'Guest', status: 'queued', effectId: 'effect-1' },
  },
};

test('parses only explicit WhatsApp mutations', () => {
  assert.deepEqual(parseWhatsAppCommand('hello', { hasThread: true }), null);
  assert.deepEqual(parseWhatsAppCommand('!wa Welcome to the resort', { hasThread: true }), { message: 'Welcome to the resort' });
  assert.deepEqual(parseWhatsAppCommand('!wa 42 Welcome', { hasThread: false }), { dmId: 42, message: 'Welcome' });
  assert.deepEqual(parseWhatsAppCommand('!wa Welcome', { hasThread: false }), { error: 'dm_id_required' });
});

test('parses only exact OwnerRez confirmation commands', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.deepEqual(parseOwnerRezConfirmCommand(`!ownerrez confirm ${id} abcdef123456`), {
    proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.deepEqual(parseOwnerRezConfirmCommand('please update the reservation'), null);
  assert.deepEqual(parseOwnerRezConfirmCommand('!ownerrez delete everything'), { error: 'invalid_confirmation' });
});

test('receipt hook binds channel, sender, and Slack file ids from the trusted event', async () => {
  const config = pluginConfig({
    receiptChannelIds: ['C123RECEIPT'], slackAccountId: 'ig-drafts', shadowMode: false,
  });
  const calls = [];
  await createReceiptHandler({
    config,
    execute: async (_config, request) => { calls.push(request); return COMPLETED; },
  })({
    content: 'Materials 1,250 MXN',
    messageId: '171.25',
    senderId: 'U-WORKER',
    metadata: { channelId: 'C123RECEIPT', files: [{ id: 'F-1', name: 'receipt.jpg', mimetype: 'image/jpeg', size: 100 }] },
  }, {
    channelId: 'slack', accountId: 'ig-drafts', conversationId: 'C123RECEIPT',
    messageId: '171.25', senderId: 'U-WORKER',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.channelId, 'C123RECEIPT');
  assert.equal(calls[0].context.actorUserId, 'U-WORKER');
  assert.deepEqual(calls[0].input.fileRefs, [{ id: 'F-1', name: 'receipt.jpg', mimetype: 'image/jpeg', size: 100 }]);
  assert.equal(calls[0].idempotencyKey, 'slack:C123RECEIPT:171.25:receipt.ingest');
});

test('reports provider acceptance without claiming delivery', () => {
  const text = formatWorkflowReply(COMPLETED);
  assert.match(text, /queued/);
  assert.match(text, /delivery and read are not confirmed/);
  assert.doesNotMatch(text, /was delivered/);
});

test('live inbound claim binds the trusted Slack identity and message id', async () => {
  const config = pluginConfig({
    agentIds: ['resort'],
    whatsappChannelIds: ['C-WA'],
    slackAccountId: 'ig-drafts',
    shadowMode: false,
  });
  const calls = [];
  const handler = createInboundClaimHandler({
    config,
    execute: async (_config, request) => { calls.push(request); return COMPLETED; },
  });
  const result = await handler({
    channel: 'slack',
    accountId: 'ig-drafts',
    conversationId: 'C-WA',
    threadId: '123.456',
    messageId: '999.1',
    senderId: 'U-SARAH',
    senderName: 'Sarah',
    bodyForAgent: '!wa Welcome!',
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.channelId, 'C-WA');
  assert.equal(calls[0].context.actorUserId, 'U-SARAH');
  assert.equal(calls[0].input.threadTs, '123.456');
  assert.equal(calls[0].idempotencyKey, 'slack:C-WA:999.1:whatsapp.reply');
  assert.match(result.reply.text, /not confirmed/);
});

test('global shadow can cut over only the WhatsApp reply workflow', async () => {
  const config = pluginConfig({
    whatsappChannelIds: ['C-WA'], shadowMode: true, liveWorkflowNames: ['whatsapp.reply'],
  });
  const calls = [];
  const result = await createInboundClaimHandler({
    config, execute: async (_config, request) => { calls.push(request); return COMPLETED; },
  })({
    channel: 'slack', conversationId: 'C-WA', threadId: '123.456',
    messageId: '999.2', senderId: 'U-JASON', bodyForAgent: '!wa Confirmed reply',
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
});

test('OwnerRez confirmation binds trusted Slack identity and ignores model-like prose', async () => {
  const proposalId = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  const config = pluginConfig({
    ownerrezChannelIds: ['C-RES'], shadowMode: true, liveWorkflowNames: ['ownerrez.mutation.confirm'],
  });
  const calls = [];
  const payload = {
    run: {
      id: 'run-ownerrez', workflow_name: 'ownerrez.mutation.confirm', status: 'completed',
      output: { status: 'verified_by_readback', proposalId, operationId: 'Guests_Patch', effectId: 'effect', evidenceId: 'evidence' },
    },
  };
  const handler = createOwnerRezClaimHandler({
    config, execute: async (_config, request) => { calls.push(request); return payload; },
  });
  assert.equal(await handler({ channel: 'slack', conversationId: 'C-RES', bodyForAgent: 'Please confirm this' }, {}), undefined);
  const result = await handler({
    channel: 'slack', conversationId: 'C-RES', messageId: '1000.1', senderId: 'U-JASON',
    bodyForAgent: `!ownerrez confirm ${proposalId} abcdef123456`,
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls[0].context.actorUserId, 'U-JASON');
  assert.equal(calls[0].workflow, 'ownerrez.mutation.confirm');
  assert.match(result.reply.text, /verified by readback/);
});

test('live WhatsApp thread refuses ambiguous plain replies', async () => {
  const config = pluginConfig({ whatsappChannelIds: ['C-WA'], shadowMode: false });
  const result = await createInboundClaimHandler({ config })({
    channel: 'slack', conversationId: 'C-WA', threadId: '123.456', bodyForAgent: 'Is this available?',
  }, {});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /Not sent/);
});

test('tool factory supplies channel, sender, and thread instead of trusting model input', async () => {
  const config = pluginConfig({ crmBaseUrl: 'http://example.test' });
  process.env.RESORT_WORKFLOW_CONTROL_TOKEN = 'test-control-token-that-is-at-least-32-characters';
  let request;
  let authorization;
  const tool = createWorkflowTool({
    config,
    ctx: {
      sessionId: 'session-1',
      sessionKey: 'agent:resort:slack:channel:C-WA:thread:123.456',
      requesterSenderId: 'U-JASON',
      deliveryContext: { to: 'channel:C-WA', threadId: '123.456' },
    },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      authorization = options.headers.Authorization;
      return { ok: true, status: 200, json: async () => COMPLETED };
    },
  });
  const result = await tool.execute('tool-call-1', {
    workflow: 'whatsapp.reply',
    input: { message: 'Hello', threadTs: 'model-spoof' },
  });
  assert.equal(request.context.channel_id, 'C-WA');
  assert.equal(request.context.actor_user_id, 'U-JASON');
  assert.equal(request.input.threadTs, '123.456');
  assert.equal(authorization, `Bearer ${process.env.RESORT_WORKFLOW_CONTROL_TOKEN}`);
  assert.match(result.content[0].text, /not confirmed/);
  delete process.env.RESORT_WORKFLOW_CONTROL_TOKEN;
});

test('finalizer rejects unsupported WhatsApp delivery claims', async () => {
  const config = pluginConfig({ whatsappChannelIds: ['C-WA'], controlledChannelIds: ['C-WA', 'C-SOCIAL'] });
  const handler = createFinalizeHandler({ config });
  const result = await handler({ lastAssistantMessage: 'Your WhatsApp was delivered and viewed.' }, { channelId: 'C-WA' });
  assert.equal(result.action, 'revise');
  assert.equal(await handler({ lastAssistantMessage: 'Twilio-confirmed delivery; read not confirmed.' }, { channelId: 'C-WA' }), undefined);
  const unsupported = await handler({ lastAssistantMessage: 'The Instagram post was published.' }, { channelId: 'C-SOCIAL' });
  assert.equal(unsupported.action, 'revise');
  assert.equal(await handler({ lastAssistantMessage: 'Postiz-confirmed schedule. Workflow: 12345678-abcd.' }, { channelId: 'C-SOCIAL' }), undefined);
});
