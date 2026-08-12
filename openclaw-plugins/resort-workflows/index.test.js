import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinalizeHandler,
  createInboundClaimHandler,
  createMetaDmClaimHandler,
  createManualReviewClaimHandler,
  createOwnerRezClaimHandler,
  createReceiptHandler,
  createWorkflowTool,
  formatWorkflowReply,
  parseWhatsAppCommand,
  parseMetaDmCommand,
  parseManualReviewCommand,
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

test('parses only explicit Meta DM mutations', () => {
  assert.deepEqual(parseMetaDmCommand('hello'), null);
  assert.deepEqual(parseMetaDmCommand('!dm 42 Welcome'), { dmId: 42, message: 'Welcome' });
  assert.deepEqual(parseMetaDmCommand('!dm Welcome'), { error: 'invalid_meta_dm_command' });
});

test('parses exact manual-review resolutions', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.deepEqual(parseManualReviewCommand(`!review resolve ${id} sent SM123`), {
    reviewId: id, resolution: 'confirmed_sent', providerRef: 'SM123',
  });
  assert.deepEqual(parseManualReviewCommand(`!review resolve ${id} not-sent`), {
    reviewId: id, resolution: 'confirmed_not_sent', providerRef: null,
  });
  assert.deepEqual(parseManualReviewCommand('please resolve it'), null);
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

test('OwnerRez occupancy reply reports the earliest primary calendar entry even when manually blocked', () => {
  const text = formatWorkflowReply({
    run: {
      id: 'run-ownerrez-read', workflow_name: 'ownerrez.occupancy.read', status: 'completed',
      output: {
        window: { start: '2026-08-12', end: '2026-12-10' },
        nextCalendarEntry: {
          id: 101, arrival: '2026-09-03', departure: '2026-09-07',
          type: 'block', is_block: true, title: 'Sherry bachelor and bachelorette party',
          property: { name: 'Puesta del Sol Resort' },
        },
        _evidence: { id: 'evidence-ownerrez' },
      },
    },
  });
  assert.match(text, /Next primary calendar entry: 2026-09-03 → 2026-09-07/);
  assert.match(text, /Sherry bachelor and bachelorette party/);
  assert.match(text, /does not establish guest-versus-owner use/);
  assert.doesNotMatch(text, /Next primary calendar entry: 2026-12-03/);
});

test('a post-acceptance local failure tells staff not to resend', () => {
  const text = formatWorkflowReply({
    run: {
      id: 'run-failed-projection', status: 'failed', error_message: 'projection failed',
      effects: [{ id: 'effect-1', status: 'queued', provider_ref: 'SM123' }],
    },
  });
  assert.match(text, /provider acceptance SM123 is recorded/);
  assert.match(text, /Do not resend/);
  assert.doesNotMatch(text, /delivered/);
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

test('model-facing tool cannot invoke command-only WhatsApp sends', async () => {
  const config = pluginConfig({ crmBaseUrl: 'http://example.test' });
  process.env.RESORT_WORKFLOW_CONTROL_TOKEN = 'test-control-token-that-is-at-least-32-characters';
  const tool = createWorkflowTool({
    config,
    ctx: {
      sessionId: 'session-1',
      sessionKey: 'agent:resort:slack:channel:C-WA:thread:123.456',
      requesterSenderId: 'U-JASON',
      deliveryContext: { to: 'channel:C-WA', threadId: '123.456' },
    },
    fetchImpl: async () => { throw new Error('model tool must not reach the control plane'); },
  });
  await assert.rejects(() => tool.execute('tool-call-1', {
    workflow: 'whatsapp.reply',
    input: { message: 'Hello', threadTs: 'model-spoof' },
  }), error => error.code === 'workflow_command_required');
  await assert.rejects(() => tool.execute('tool-call-2', {
    workflow: 'meta.dm.reply',
    input: { dmId: 42, message: 'Hello' },
  }), error => error.code === 'workflow_command_required');
  delete process.env.RESORT_WORKFLOW_CONTROL_TOKEN;
});

test('guest mutations fail closed when Slack supplies no stable message id', async () => {
  const config = pluginConfig({
    whatsappChannelIds: ['C-WA'], shadowMode: false,
  });
  const calls = [];
  const result = await createInboundClaimHandler({
    config, execute: async (_config, request) => { calls.push(request); return COMPLETED; },
  })({
    channel: 'slack', conversationId: 'C-WA', threadId: '123.456',
    senderId: 'U-JASON', bodyForAgent: '!wa Do not send without an event id',
  }, {});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /stable message ID/);
  assert.equal(calls.length, 0);
});

test('Meta DM command binds trusted Slack identity and remains command-only', async () => {
  const config = pluginConfig({
    socialChannelIds: ['C-SOCIAL'], shadowMode: true, liveWorkflowNames: ['meta.dm.reply'],
  });
  const calls = [];
  const payload = {
    run: {
      id: 'run-meta', workflow_name: 'meta.dm.reply', status: 'completed',
      output: { recipient: 'Guest', platform: 'instagram', status: 'accepted_by_provider', effectId: 'effect-meta' },
    },
  };
  const result = await createMetaDmClaimHandler({
    config, execute: async (_config, request) => { calls.push(request); return payload; },
  })({
    channel: 'slack', conversationId: 'C-SOCIAL', messageId: '2000.1', senderId: 'U-JASON',
    senderName: 'Jason', bodyForAgent: '!dm 42 Welcome',
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls[0].context.entrypoint, 'slack_meta_dm_command');
  assert.equal(calls[0].context.actorUserId, 'U-JASON');
  assert.match(result.reply.text, /Delivery\/read is not confirmed/);
});

test('manual-review resolution is available only as an exact controlled-channel command', async () => {
  const reviewId = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  const config = pluginConfig({ controlledChannelIds: ['C-WA'] });
  const calls = [];
  const result = await createManualReviewClaimHandler({
    config,
    resolve: async (_config, request) => {
      calls.push(request);
      return { review: { id: reviewId, resolution: 'confirmed_not_sent' } };
    },
  })({
    channel: 'slack', conversationId: 'C-WA', senderId: 'U-JASON',
    bodyForAgent: `!review resolve ${reviewId} not-sent`,
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls[0].actorUserId, 'U-JASON');
  assert.match(result.reply.text, /confirmed_not_sent/);
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
