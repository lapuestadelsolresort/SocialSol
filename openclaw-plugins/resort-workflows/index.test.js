import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinalizeHandler,
  createEmailClaimHandler,
  createEmailReplyDispatchHandler,
  createInboundClaimHandler,
  createMetaDmClaimHandler,
  createMarketingConfirmClaimHandler,
  createManualReviewClaimHandler,
  createOwnerRezClaimHandler,
  createReceiptConfirmClaimHandler,
  createReservationReadClaimHandler,
  createReservationReplyDispatchHandler,
  createReservationToolGuard,
  createReceiptHandler,
  createWorkflowTool,
  formatOwnerRezOccupancyReply,
  formatWorkflowReply,
  parseWhatsAppCommand,
  parseEmailCommand,
  parseMetaDmCommand,
  parseMarketingConfirmCommand,
  parseManualReviewCommand,
  parseOwnerRezConfirmCommand,
  parseReceiptConfirmCommand,
  parseReservationReadRequest,
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

test('parses email replies, confirmations, and classifications only in the original thread', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.equal(parseEmailCommand('hello', { hasThread: true }), null);
  assert.deepEqual(parseEmailCommand('!email reply Thanks—here are the rates.', { hasThread: true }), {
    action: 'propose', message: 'Thanks—here are the rates.',
  });
  assert.deepEqual(parseEmailCommand(`!email confirm ${id} abcdef123456`, { hasThread: true }), {
    action: 'confirm', proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.deepEqual(parseEmailCommand('!email classify 17 hot', { hasThread: true }), {
    action: 'classify', eventId: 17, quality: 'hot',
  });
  assert.deepEqual(parseEmailCommand('!email reply 10339 | bypass', { hasThread: false }), {
    error: 'original_thread_required',
  });
});

test('email reply commands bind the trusted Slack user, message, channel, and thread', async () => {
  const config = pluginConfig({
    emailChannelIds: ['CPAULINA'], shadowMode: true,
    liveWorkflowNames: ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'],
  });
  const calls = [];
  const result = await createEmailClaimHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: { id: 'email-proposal-run', workflow_name: request.workflow, status: 'completed',
        output: { status: 'awaiting_explicit_confirmation', bodyText: request.input.message,
          confirmationCommand: '!email confirm id hash' } } };
    },
  })({
    channel: 'slack', conversationId: 'CPAULINA', messageId: '200.1',
    senderId: 'U-SARAH', threadId: '1786549495.693669',
    bodyForAgent: '!email reply Thanks—here are the rates.',
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'email.reply.propose');
  assert.equal(calls[0].input.threadTs, '1786549495.693669');
  assert.equal(calls[0].context.actorUserId, 'U-SARAH');
  assert.equal(calls[0].context.entrypoint, 'slack_email_reply_command');
  assert.equal(calls[0].idempotencyKey, 'slack:CPAULINA:200.1:email.reply.propose');
  assert.match(result.reply.text, /No email has been sent/);

  const topLevel = await createEmailClaimHandler({ config, execute: async () => assert.fail('must not execute') })({
    channel: 'slack', conversationId: 'CPAULINA', messageId: '200.2', senderId: 'U-SARAH',
    bodyForAgent: '!email reply 10339 | bypass',
  }, {});
  assert.equal(topLevel.handled, true);
  assert.match(topLevel.reply.text, /original message thread/);
});

test('email reply dispatch claims ordinary Slack commands before the model runs', async () => {
  const config = pluginConfig({
    emailChannelIds: ['CPAULINA'], slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'],
  });
  const calls = [];
  const sent = [];
  let finalized = null;
  let idleReason = null;
  const counts = { tool: 0, block: 0, final: 0 };
  const handler = createEmailReplyDispatchHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: {
        id: 'email-proposal-run', workflow_name: 'email.reply.propose', status: 'completed',
        output: {
          outreachSendId: 10343, recipient: 'Jason', requestHash: 'request-hash',
          bodyText: request.input.message, expiresAt: '2026-08-13T17:03:36.296Z',
          confirmationCommand: '!email confirm proposal-id acceptance-hash',
        },
      } };
    },
  });
  const result = await handler({
    ctx: {
      Provider: 'slack', Surface: 'slack', AccountId: 'ig-drafts',
      OriginatingChannel: 'slack', OriginatingTo: 'channel:CPAULINA',
      MessageSidFull: '1786639502.209419', MessageThreadId: '1786639076.817359',
      SenderId: 'U-JASON', BodyForCommands: '!email reply yes how about 5?',
      CommandAuthorized: true,
    },
    sendPolicy: 'allow',
  }, {
    dispatcher: {
      sendFinalReply(payload) { sent.push(payload); counts.final += 1; return true; },
      getQueuedCounts() { return { ...counts }; },
    },
    recordProcessed(outcome, details) { finalized = { outcome, details }; },
    markIdle(reason) { idleReason = reason; },
  });

  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'email.reply.propose');
  assert.equal(calls[0].input.threadTs, '1786639076.817359');
  assert.equal(calls[0].context.actorUserId, 'U-JASON');
  assert.equal(calls[0].context.messageId, '1786639502.209419');
  assert.match(sent[0].text, /No email has been sent/);
  assert.match(sent[0].text, /!email confirm proposal-id acceptance-hash/);
  assert.equal(finalized.outcome, 'completed');
  assert.equal(finalized.details.reason, 'email_workflow_reply_dispatch');
  assert.equal(idleReason, 'message_completed');
});

test('email reply dispatch gives the correct help for malformed email commands', async () => {
  const config = pluginConfig({
    emailChannelIds: ['CPAULINA'], slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'],
  });
  const sent = [];
  const handler = createEmailReplyDispatchHandler({
    config,
    execute: async () => assert.fail('malformed commands must not execute'),
  });
  const result = await handler({
    ctx: {
      Provider: 'slack', AccountId: 'ig-drafts', OriginatingChannel: 'slack',
      OriginatingTo: 'channel:CPAULINA', MessageSidFull: '1786639440.570049',
      MessageThreadId: '1786639076.817359', SenderId: 'U-JASON',
      BodyForCommands: '!email yes how about 5pm?',
    },
    sendPolicy: 'allow',
  }, {
    dispatcher: {
      sendFinalReply(payload) { sent.push(payload); return true; },
      getQueuedCounts() { return { final: sent.length }; },
    },
    recordProcessed() {}, markIdle() {},
  });
  assert.equal(result.handled, true);
  assert.match(sent[0].text, /!email reply <message>/);
  assert.doesNotMatch(sent[0].text, /!approve|!edit|!reject/);
});

test('parses only exact paid-media confirmation commands', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.deepEqual(parseMarketingConfirmCommand(`!meta confirm ${id} abcdef123456`), {
    proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.equal(parseMarketingConfirmCommand('please increase the budget'), null);
  assert.deepEqual(parseMarketingConfirmCommand(`!meta approve ${id}`), {
    error: 'invalid_marketing_confirmation',
  });
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

test('parses only exact owner-expense confirmation commands', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.deepEqual(
    parseReceiptConfirmCommand(`!receipt confirm ${id} 2026-08-06 MXN 4700 maintenance | AC Ignacio Rubio | Compressor work`),
    {
      transactionKind: 'owner_paid_expense',
      receiptId: id,
      transactionDate: '2026-08-06',
      currency: 'MXN',
      amount: 4700,
      categoryKey: 'maintenance',
      vendor: 'AC Ignacio Rubio',
      description: 'Compressor work',
    },
  );
  assert.deepEqual(
    parseReceiptConfirmCommand(`!receipt confirm repayment ${id} 2026-08-06 MXN 4700 | AC Ignacio Rubio | Paid for owner compressor work`),
    {
      transactionKind: 'owner_repayment', receiptId: id, transactionDate: '2026-08-06',
      currency: 'MXN', amount: 4700, categoryKey: null, vendor: 'AC Ignacio Rubio',
      description: 'Paid for owner compressor work',
    },
  );
  assert.deepEqual(parseReceiptConfirmCommand('Please post George expense'), null);
  assert.deepEqual(parseReceiptConfirmCommand(`!receipt confirm ${id} tomorrow`), { error: 'invalid_receipt_confirmation' });
});

test('parses clear next/upcoming reservation reads but excludes other OwnerRez intents', () => {
  const options = { asOf: '2026-08-12' };
  assert.deepEqual(parseReservationReadRequest('When is the next booking?', options), {
    mode: 'next', start: '2026-08-12', end: '2027-08-17',
  });
  assert.deepEqual(parseReservationReadRequest('What are our upcoming reservations?', options), {
    mode: 'upcoming', start: '2026-08-12', end: '2027-08-17',
  });
  assert.deepEqual(parseReservationReadRequest('¿Cuándo es la próxima reservación?', options), {
    mode: 'next', start: '2026-08-12', end: '2027-08-17',
  });
  assert.deepEqual(parseReservationReadRequest('Lista las próximas reservas', options), {
    mode: 'upcoming', start: '2026-08-12', end: '2027-08-17',
  });
  assert.equal(parseReservationReadRequest('What is the cash flow from the next booking?', options), null);
  assert.equal(parseReservationReadRequest('Move the next reservation to Friday', options), null);
  assert.equal(parseReservationReadRequest('Is the resort available on Sep 3?', options), null);
  assert.equal(parseReservationReadRequest('Who owns the resort?', options), null);
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

test('owner-expense receipt hook selects the guarded workflow', async () => {
  const config = pluginConfig({
    receiptChannelIds: ['C123OWNER'], ownerExpenseChannelIds: ['C123OWNER'],
    slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['receipt.owner_expense.ingest'],
  });
  const calls = [];
  await createReceiptHandler({
    config,
    execute: async (_config, request) => { calls.push(request); return COMPLETED; },
  })({
    content: 'George paid 1,250 MXN for materials', messageId: '171.26', senderId: 'U-GEORGE',
    metadata: { channelId: 'C123OWNER' },
  }, {
    channelId: 'slack', accountId: 'ig-drafts', conversationId: 'C123OWNER',
    messageId: '171.26', senderId: 'U-GEORGE',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'receipt.owner_expense.ingest');
  assert.equal(calls[0].idempotencyKey, 'slack:C123OWNER:171.26:receipt.owner_expense.ingest');
  assert.equal(calls[0].context.entrypoint, 'slack_receipt_hook');
});

test('owner-expense confirmation binds trusted Slack identity and stays command-only', async () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  const config = pluginConfig({
    ownerExpenseChannelIds: ['C123OWNER'], shadowMode: true,
    liveWorkflowNames: ['receipt.owner_expense.confirm'],
  });
  const calls = [];
  const result = await createReceiptConfirmClaimHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: { id: 'run-confirm', status: 'completed', output: { status: 'queued' } } };
    },
  })({
    channel: 'slack', conversationId: 'C123OWNER', messageId: '2001.1', senderId: 'U-JASON',
    bodyForAgent: `!receipt confirm ${id} 2026-08-06 MXN 4700 maintenance | AC Ignacio Rubio | Compressor work`,
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls[0].workflow, 'receipt.owner_expense.confirm');
  assert.equal(calls[0].context.actorUserId, 'U-JASON');
  assert.equal(calls[0].context.entrypoint, 'slack_receipt_confirm_command');
  assert.match(result.reply.text, /queued for durable processing and QBO readback/);
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
  assert.match(text, /Next OwnerRez calendar entry/);
  assert.match(text, /Sep 3 → Sep 7, 2026/);
  assert.match(text, /Sherry bachelor and bachelorette party/);
  assert.match(text, /guest vs owner use is not encoded/);
  assert.doesNotMatch(text, /Dec 3/);
});

test('OwnerRez upcoming reply keeps manual events and typed bookings distinct and ordered', () => {
  const text = formatOwnerRezOccupancyReply({
    run: {
      id: 'run-ownerrez-list', workflow_name: 'ownerrez.occupancy.read', status: 'completed',
      output: {
        window: { start: '2026-08-12', end: '2027-08-17' },
        primaryCalendarEntries: [
          {
            id: 300, arrival: '2026-12-03', departure: '2026-12-07',
            calendar_entry_kind: 'typed_booking', display_name: 'Eric Candelario',
            property: { name: 'Villa Crab (V4)' }, adults: 10, children: 1,
          },
          {
            id: 100, arrival: '2026-09-03', departure: '2026-09-07',
            calendar_entry_kind: 'manual_calendar_entry',
            display_name: 'Sherry bachelor and bachelorette party',
            property: { name: 'Puesta del Sol Resort' },
          },
          {
            id: 200, arrival: '2026-11-05', departure: '2026-11-08',
            calendar_entry_kind: 'typed_booking', display_name: 'Eric Egan',
            property: { name: 'Puesta del Sol Resort' }, adults: 1, children: 0,
          },
        ],
        _evidence: { id: 'evidence-ownerrez-list' },
      },
    },
  }, { mode: 'upcoming' });
  assert.ok(text.indexOf('Sherry bachelor') < text.indexOf('Eric Egan'));
  assert.ok(text.indexOf('Eric Egan') < text.indexOf('Eric Candelario'));
  assert.match(text, /Eric Candelario, Villa Crab \(V4\) \(typed booking; 10 adults \+ 1 child\)/);
  assert.match(text, /Eric Egan.*typed booking; 1 adult/);
  assert.match(text, /Sherry bachelor.*manual calendar entry/);
  assert.doesNotMatch(text, /move|fixing|listed as Dec/i);
});

test('reservation read claim executes the durable live workflow before replying', async () => {
  const config = pluginConfig({ reservationsChannelIds: ['C-RES'], slackAccountId: 'ig-drafts' });
  const calls = [];
  const payload = {
    run: {
      id: 'run-live', workflow_name: 'ownerrez.occupancy.read', status: 'completed',
      output: {
        window: { start: '2026-08-12', end: '2027-08-17' },
        primaryCalendarEntries: [{
          id: 100, arrival: '2026-09-03', departure: '2026-09-07',
          calendar_entry_kind: 'manual_calendar_entry', display_name: 'Sherry bachelor and bachelorette party',
          property: { name: 'Puesta del Sol Resort' },
        }, {
          id: 300, arrival: '2026-12-03', departure: '2026-12-07',
          calendar_entry_kind: 'typed_booking', display_name: 'Eric Candelario',
          property: { name: 'Villa Crab (V4)' }, adults: 10, children: 1,
        }],
      },
    },
  };
  const handler = createReservationReadClaimHandler({
    config,
    today: () => '2026-08-12',
    execute: async (_config, request) => { calls.push(request); return payload; },
  });
  const result = await handler({
    channel: 'slack', accountId: 'ig-drafts', conversationId: 'C-RES',
    messageId: '3000.1', senderId: 'U-JASON', bodyForAgent: 'What are the next reservations?',
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'ownerrez.occupancy.read');
  assert.deepEqual(calls[0].input, { start: '2026-08-12', end: '2027-08-17' });
  assert.deepEqual(calls[0].context, {
    channelId: 'C-RES', actorUserId: 'U-JASON', messageId: '3000.1', entrypoint: 'slack_reservations_read',
  });
  assert.equal(calls[0].idempotencyKey, 'slack:C-RES:3000.1:ownerrez.occupancy.read:upcoming');
  assert.ok(result.reply.text.indexOf('Sherry bachelor') < result.reply.text.indexOf('Eric Candelario'));
});

test('reservation reply dispatch claims an ordinary Slack turn before the model runs', async () => {
  const config = pluginConfig({ reservationsChannelIds: ['C-RES'], slackAccountId: 'ig-drafts' });
  const calls = [];
  const sent = [];
  let finalized = null;
  let idleReason = null;
  const counts = { tool: 0, block: 0, final: 0 };
  const handler = createReservationReplyDispatchHandler({
    config,
    today: () => '2026-08-12',
    execute: async (_config, request) => {
      calls.push(request);
      return {
        run: {
          id: 'run-real-contract', workflow_name: 'ownerrez.occupancy.read', status: 'completed',
          output: {
            window: { start: '2026-08-12', end: '2027-08-17' },
            primaryCalendarEntries: [{
              id: 100, arrival: '2026-09-03', departure: '2026-09-07',
              calendar_entry_kind: 'manual_calendar_entry',
              display_name: 'Sherry bachelor and bachelorette party',
              property: { name: 'Puesta del Sol Resort' },
            }],
          },
        },
      };
    },
  });
  const result = await handler({
    ctx: {
      Provider: 'slack', Surface: 'slack', AccountId: 'ig-drafts',
      OriginatingChannel: 'slack', OriginatingTo: 'channel:C-RES',
      MessageSidFull: '1786566667.695009', SenderId: 'U-JASON',
      BodyForCommands: '<@BOT> (OpenClaw IG Bot) what are the next reservations?',
      CommandAuthorized: true,
    },
    inboundAudio: false,
    shouldRouteToOriginating: false,
    shouldSendToolSummaries: true,
    sendPolicy: 'allow',
  }, {
    dispatcher: {
      sendFinalReply(payload) { sent.push(payload); counts.final += 1; return true; },
      getQueuedCounts() { return { ...counts }; },
    },
    recordProcessed(outcome, details) { finalized = { outcome, details }; },
    markIdle(reason) { idleReason = reason; },
  });

  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'ownerrez.occupancy.read');
  assert.equal(calls[0].context.messageId, '1786566667.695009');
  assert.equal(calls[0].context.actorUserId, 'U-JASON');
  assert.equal(calls[0].context.channelId, 'C-RES');
  assert.match(sent[0].text, /Sherry bachelor and bachelorette party/);
  assert.equal(finalized.outcome, 'completed');
  assert.equal(finalized.details.reason, 'reservation_workflow_reply_dispatch');
  assert.equal(idleReason, 'message_completed');
});

test('reservations tool guard blocks shell bypass even when OpenClaw misses the channel allowlist', async () => {
  const guard = createReservationToolGuard({
    config: pluginConfig({ reservationsChannelIds: ['C-RES'] }),
  });
  assert.deepEqual(await guard({ toolName: 'exec', params: {} }, {
    channelId: 'c-res',
  }), {
    block: true,
    blockReason: '#reservations is restricted to the durable resort_workflow control plane.',
  });
  assert.equal(await guard({ toolName: 'resort_workflow', params: {} }, {
    channelId: 'c-res',
  }), undefined);
  assert.equal(await guard({ toolName: 'exec', params: {} }, {
    channelId: 'C-OTHER',
  }), undefined);
});

test('reservation read claim fails closed when live OwnerRez is unavailable', async () => {
  const config = pluginConfig({ reservationsChannelIds: ['C-RES'] });
  const error = new Error('offline');
  error.code = 'ownerrez_unavailable';
  const result = await createReservationReadClaimHandler({
    config, today: () => '2026-08-12', execute: async () => { throw error; },
  })({
    channel: 'slack', conversationId: 'C-RES', messageId: '3000.2', senderId: 'U-JASON',
    bodyForAgent: 'When is the next booking?',
  }, {});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /temporarily unavailable/);
  assert.match(result.reply.text, /No booking answer was generated from CRM data or memory/);
  assert.doesNotMatch(result.reply.text, /Sep|Dec|Sherry|Eric/);
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
  await assert.rejects(() => tool.execute('tool-call-3', {
    workflow: 'receipt.owner_expense.confirm',
    input: {},
  }), error => error.code === 'workflow_command_required');
  await assert.rejects(() => tool.execute('tool-call-4', {
    workflow: 'marketing.change.confirm', input: {},
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

test('paid-media confirmation binds trusted Slack identity and remains command-only', async () => {
  const proposalId = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  const config = pluginConfig({
    socialChannelIds: ['C-SOCIAL'], shadowMode: true,
    liveWorkflowNames: ['marketing.change.confirm'],
  });
  const calls = [];
  const payload = {
    run: {
      id: 'run-marketing', workflow_name: 'marketing.change.confirm', status: 'completed',
      output: {
        status: 'verified_by_readback', requestId: proposalId,
        operation: 'campaign_activate', providerRef: 'campaign-1',
        effectId: 'effect-marketing', evidenceId: 'evidence-marketing',
      },
    },
  };
  const handler = createMarketingConfirmClaimHandler({
    config, execute: async (_config, request) => { calls.push(request); return payload; },
  });
  assert.equal(await handler({
    channel: 'slack', conversationId: 'C-SOCIAL', bodyForAgent: 'activate it',
  }, {}), undefined);
  const result = await handler({
    channel: 'slack', conversationId: 'C-SOCIAL', messageId: '2100.1', senderId: 'U-JASON',
    bodyForAgent: `!meta confirm ${proposalId} abcdef123456`,
  }, {});
  assert.equal(result.handled, true);
  assert.equal(calls[0].workflow, 'marketing.change.confirm');
  assert.equal(calls[0].context.entrypoint, 'slack_meta_campaign_confirm_command');
  assert.equal(calls[0].context.actorUserId, 'U-JASON');
  assert.match(result.reply.text, /verified by readback/);
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
