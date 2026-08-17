import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  accountingCsvSignalFromFinalizedContext,
  createAccountingTransactionReplyDispatchHandler,
  createAccountingReconciliationClaimHandler,
  createAccountingReconciliationReplyDispatchHandler,
  createAccountingStatementClaimHandler,
  createAccountingStatementReplyDispatchHandler,
  createControlledChannelToolGuard,
  createFinalizeHandler,
  createEmailClaimHandler,
  createEmailReplyDispatchHandler,
  createInboundClaimHandler,
  createMetaDmClaimHandler,
  createMarketingConfirmClaimHandler,
  claimCommandText,
  createManualReviewClaimHandler,
  createOwnerRezClaimHandler,
  createReceiptConfirmClaimHandler,
  createReservationReadClaimHandler,
  createReservationReplyDispatchHandler,
  createTaskListClaimHandler,
  createTaskListReplyDispatchHandler,
  createReservationToolGuard,
  createReceiptHandler,
  createReceiptPaymentSourceInteractionHandler,
  createWorkflowTool,
  formatOwnerRezOccupancyReply,
  formatAccountingReconciliationReply,
  formatAccountingTransactionReply,
  formatWorkflowReply,
  parseWhatsAppCommand,
  parseEmailCommand,
  parseMetaDmCommand,
  parseMarketingConfirmCommand,
  parseManualReviewCommand,
  parseOwnerRezConfirmCommand,
  parseReceiptConfirmCommand,
  parseReceiptPaymentSourceAction,
  parseReservationReadRequest,
  parseAccountingReconciliationRequest,
  parseAccountingTransactionRequest,
  parseTaskListRequest,
  pluginConfig,
} from './index.js';

const require = createRequire(import.meta.url);
const { buildReceiptPaymentSourcePrompt } = require('../../crm/workflows/local-records.js');

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

test('workflow tool exposes email activity and full CRM contact lookup as model-callable reads', () => {
  const tool = createWorkflowTool({
    config: pluginConfig({}),
    ctx: { deliveryContext: { to: 'channel:CEMAIL' }, requesterSenderId: 'U-JASON' },
  });
  assert.ok(tool.parameters.properties.workflow.enum.includes('email.activity.read'));
  assert.ok(tool.parameters.properties.workflow.enum.includes('crm.contacts.read'));
  assert.match(tool.parameters.properties.workflow.description, /do not defer those requests to another channel/);
});

test('CRM contact lookup works inside a WhatsApp thread without receiving unsupported thread input', async () => {
  const tokenEnv = 'TEST_CRM_CONTACT_CONTROL_TOKEN';
  const prior = process.env[tokenEnv];
  process.env[tokenEnv] = 'c'.repeat(40);
  let request;
  try {
    const tool = createWorkflowTool({
      config: pluginConfig({ controlPlaneTokenEnv: tokenEnv }),
      ctx: {
        sessionId: 'contact-thread-session', requesterSenderId: 'U-JASON',
        deliveryContext: { to: 'channel:CWA', threadId: '123.456' },
      },
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return { ok: true, json: async () => ({ run: {
          id: 'crm-contact-thread-run', workflow_name: 'crm.contacts.read', status: 'completed',
          output: { queries: ['Bethany'], totalMatches: 0, displayedContacts: 0, contacts: [] },
        } }) };
      },
    });
    await tool.execute('contact-thread-call', {
      workflow: 'crm.contacts.read', input: { queries: ['Bethany'] },
    });
    assert.deepEqual(request.input, { queries: ['Bethany'] });
    assert.equal(request.context.channel_id, 'CWA');
  } finally {
    if (prior === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = prior;
  }
});

test('formats live Gmail activity with unread and ledger coverage facts', () => {
  const reply = formatWorkflowReply({ run: {
    id: 'email-read-run', workflow_name: 'email.activity.read', status: 'completed',
    output: {
      window: { start: '2026-08-13', end: '2026-08-13', timeZone: 'America/Los_Angeles' },
      direction: 'inbound', totalMessages: 2, unreadMessages: 2, spamMessages: 0,
      ledgerCapturedMessages: 1, ledgerMissingMessages: 1,
      messages: [{ receivedAt: '2026-08-13T16:32:28.000Z', direction: 'inbound',
        senderName: 'Guest', fromAddress: 'guest@example.com', subject: 'Wedding dates',
        unread: true, spam: false, bodyPreview: 'Are your May dates open?' }],
      _evidence: { id: 'evidence-1' },
    },
  } });
  assert.match(reply, /Sarah Gmail live activity/);
  assert.match(reply, /2 received messages/);
  assert.match(reply, /Wedding dates \[unread\]/);
  assert.match(reply, /1 captured · 1 missing/);
  assert.match(reply, /Evidence: evidence-1/);
});

test('model-facing accounting reads expose row data instead of evidence-only completions', () => {
  const receipts = formatWorkflowReply({ run: {
    id: 'receipt-read', workflow_name: 'receipts.status.read', status: 'completed',
    output: {
      receipts: [{ id: 'r1', status: 'posted', transaction_date: '2026-08-14', currency: 'MXN', amount: 3300, vendor: 'Fidencio Lopez', qbo_entity_type: 'JournalEntry', qbo_entity_id: '2602' }],
      _evidence: { id: 'receipt-evidence' },
    },
  } });
  assert.match(receipts, /Fidencio Lopez/);
  assert.match(receipts, /QBO JournalEntry 2602/);
  assert.doesNotMatch(receipts, /completed with verified run state/);

  const report = formatWorkflowReply({ run: {
    id: 'qbo-report', workflow_name: 'qbo.report.read', status: 'completed',
    output: {
      report: {
        Header: { ReportName: 'BalanceSheet', StartPeriod: '2026-08-01', EndPeriod: '2026-08-14', ReportBasis: 'Accrual', Currency: 'USD' },
        Rows: { Row: [{ ColData: [{ value: 'Due to George Starkey' }, { value: '451.84' }] }] },
      },
      _evidence: { id: 'qbo-evidence' },
    },
  } });
  assert.match(report, /QuickBooks BalanceSheet/);
  assert.match(report, /Due to George Starkey — 451\.84/);
});

test('WhatsApp status reads surface every persisted row in both WhatsApp and business-intel tool content', async () => {
  const tokenEnv = 'TEST_WHATSAPP_STATUS_CONTROL_TOKEN';
  const previousToken = process.env[tokenEnv];
  process.env[tokenEnv] = 'w'.repeat(40);
  const requests = [];
  const payload = { run: {
    id: 'wa-status-run', workflow_name: 'whatsapp.status.read', status: 'completed',
    output: {
      direction: 'outbound', totalMessages: 2, displayedMessages: 2, truncated: false,
      statusCounts: { read: 1, delivered: 0, failed: 1, unconfirmed: 0 },
      followUpRequiredMessages: 1,
      legacyUntrackedMessages: 46,
      messages: [
        { message_id: 'SM-READ', contact_name: 'Guest One', sent_by_name: 'Jason',
          direction: 'outbound', delivery_status: 'read',
          provider_status_updated_at: '2026-08-13T12:06:00.000Z' },
        { message_id: 'SM-FAILED', contact_name: 'Guest Two', sent_by_name: 'Sarah',
          direction: 'outbound', delivery_status: 'failed',
          provider_delivery_status: 'undelivered', provider_error_code: '63016',
          provider_status_updated_at: '2026-08-13T12:07:00.000Z' },
      ],
      _evidence: { id: 'wa-status-evidence' },
    },
  } };
  try {
    for (const channelId of ['CWA', 'CBI']) {
      const tool = createWorkflowTool({
        config: pluginConfig({ controlPlaneTokenEnv: tokenEnv }),
        ctx: {
          sessionId: `session-${channelId}`,
          deliveryContext: { to: `channel:${channelId}` },
          requesterSenderId: 'U-JASON',
        },
        fetchImpl: async (_url, options) => {
          requests.push(JSON.parse(options.body));
          return { ok: true, json: async () => payload };
        },
      });
      const result = await tool.execute(`call-${channelId}`, {
        workflow: 'whatsapp.status.read', input: { direction: 'outbound', limit: 100 },
      });
      const text = result.content[0].text;
      assert.match(text, /2 persisted records/);
      assert.match(text, /1 read · 0 delivered · 1 failed\/undelivered \(follow-up required\)/);
      assert.match(text, /Guest One · read \(Twilio-confirmed\).*SM-READ/);
      assert.match(text, /Guest Two · undelivered \(Twilio-confirmed; follow-up required; Twilio 63016: outside the 24-hour reply window; approved template required\).*SM-FAILED/);
      assert.match(text, /46 older WhatsApp records still lack normalized direction\/status/);
      assert.match(text, /Workflow: wa-status-run · Evidence: wa-status-evidence/);
      assert.doesNotMatch(text, /completed with verified run state/);
    }
    assert.deepEqual(requests.map(request => request.context.channel_id), ['CWA', 'CBI']);
    assert.ok(requests.every(request => request.input.direction === 'outbound' && request.input.limit === 100));
  } finally {
    if (previousToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previousToken;
  }
});

test('WhatsApp failure output explains a disabled or unverified business account', () => {
  const text = formatWorkflowReply({ run: {
    id: 'wa-disabled', workflow_name: 'whatsapp.status.read', status: 'completed',
    output: {
      direction: 'outbound', totalMessages: 1, displayedMessages: 1,
      statusCounts: { read: 0, delivered: 0, failed: 1, unconfirmed: 0 },
      messages: [{
        message_id: 'SM-FAILED', contact_name: 'Guest', direction: 'outbound',
        delivery_status: 'failed', provider_delivery_status: 'failed',
        provider_error_code: '63112', provider_status_updated_at: '2026-08-10T02:18:18.000Z',
      }],
    },
  } });
  assert.match(text, /Twilio 63112: WhatsApp Business Account disabled or verification incomplete at send time/);
  assert.match(text, /follow-up required/);
});

test('CRM contact lookup formats full POCs and WhatsApp context in the requesting channel', () => {
  const text = formatWorkflowReply({ run: {
    id: 'crm-contacts-run', workflow_name: 'crm.contacts.read', status: 'completed',
    output: {
      queries: ['Bethany', 'Missing Person'], totalMatches: 1, displayedContacts: 1,
      unmatchedQueries: ['Missing Person'], truncated: false,
      contacts: [{
        contactRef: 'contact:42', name: 'Bethany Guest', phone: '+14155550101',
        email: 'bethany@example.com', sources: ['contacts:ownerrez', 'whatsapp_inbound'],
        statuses: ['inquiry'], doNotContact: false,
        whatsapp: {
          eligibility: 'known_whatsapp_contact', knownInbound: true,
          lastInboundAt: '2026-08-14T12:00:00.000Z', serviceWindowOpen: true, dmId: 17,
        },
      }],
      _evidence: { id: 'crm-contacts-evidence' },
    },
  } });
  assert.match(text, /CRM contact lookup:.*1 matching contact/);
  assert.match(text, /Bethany Guest.*\+14155550101.*bethany@example\.com.*contact:42/);
  assert.match(text, /contacts:ownerrez, whatsapp inbound/);
  assert.match(text, /24-hour window open · WA ID 17/);
  assert.match(text, /No match for: Missing Person/);
  assert.match(text, /Workflow: crm-contacts-run · Evidence: crm-contacts-evidence/);
});

test('parses only explicit Meta DM mutations', () => {
  assert.deepEqual(parseMetaDmCommand('hello'), null);
  assert.deepEqual(parseMetaDmCommand('!dm 42 Welcome'), { dmId: 42, message: 'Welcome' });
  assert.deepEqual(parseMetaDmCommand('!dm Welcome'), { error: 'invalid_meta_dm_command' });
});

test('parses replies and classifications in-thread while allowing confirmations anywhere in-channel', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.equal(parseEmailCommand('hello', { hasThread: true }), null);
  assert.deepEqual(parseEmailCommand('!email reply Thanks—here are the rates.', { hasThread: true }), {
    action: 'propose', message: 'Thanks—here are the rates.',
  });
  assert.deepEqual(parseEmailCommand(`!email confirm ${id} abcdef123456`, { hasThread: true }), {
    action: 'confirm', proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.deepEqual(parseEmailCommand(`\`!email confirm ${id} abcdef123456\``, { hasThread: true }), {
    action: 'confirm', proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.deepEqual(parseEmailCommand(`!email confirm \`${id} abcdef123456\``, { hasThread: true }), {
    action: 'confirm', proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.deepEqual(parseEmailCommand(`!email confirm ${id} abcdef123456`, { hasThread: false }), {
    action: 'confirm', proposalId: id, acceptanceHash: 'abcdef123456',
  });
  assert.deepEqual(parseEmailCommand('!email classify 17 hot', { hasThread: true }), {
    action: 'classify', eventId: 17, quality: 'hot',
  });
  assert.deepEqual(parseEmailCommand('!email reply 10339 | bypass', { hasThread: false }), {
    error: 'original_thread_required',
  });
});

test('email proposal reply exposes a plain copyable command and no deadline', () => {
  const command = '!email confirm 4df5fc31-c9f8-4b30-8dcc-0a13482beedd abcdef123456';
  const text = formatWorkflowReply({ run: {
    id: 'email-proposal-run', workflow_name: 'email.reply.propose', status: 'completed',
    output: {
      recipient: 'Gretel', outreachSendId: 10339, requestHash: 'request-hash',
      bodyText: 'Here are the rates.', confirmationCommand: command, doesNotExpire: true,
    },
  } });
  assert.match(text, /does not expire/);
  assert.match(text, /anywhere in this channel/);
  assert.match(text, new RegExp(`\\n${command.replaceAll('-', '\\-')}\\n`));
  assert.doesNotMatch(text, /Expires:/);
  assert.doesNotMatch(text, new RegExp(`\`${command.replaceAll('-', '\\-')}\``));
});

test('email reply commands bind trusted Slack context while top-level confirmation stays copyable', async () => {
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

  const confirmed = await createEmailClaimHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: { id: 'email-confirm-run', workflow_name: request.workflow, status: 'completed',
        output: { status: 'verified_by_readback' } } };
    },
  })({
    channel: 'slack', conversationId: 'CPAULINA', messageId: '200.3', senderId: 'U-SARAH',
    bodyForAgent: '!email confirm 4df5fc31-c9f8-4b30-8dcc-0a13482beedd abcdef123456',
  }, {});
  assert.equal(confirmed.handled, true);
  assert.equal(calls.at(-1).workflow, 'email.reply.confirm');
  assert.equal(calls.at(-1).input.threadTs, undefined);
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

test('receipt hook binds channel and sender while exact source files are refetched downstream', async () => {
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
  assert.deepEqual(calls[0].input, { slackMessageId: '171.25' });
  assert.equal(calls[0].idempotencyKey, 'slack:C123RECEIPT:171.25:receipt.ingest');
});

test('receipt hook treats thread replies as discussion, not new reimbursements', async () => {
  const config = pluginConfig({ receiptChannelIds: ['C123RECEIPT'], shadowMode: false });
  const calls = [];
  await createReceiptHandler({
    config,
    execute: async (_config, request) => { calls.push(request); return COMPLETED; },
  })({
    content: 'Confirmed', messageId: '171.26', senderId: 'U-WORKER', threadId: '171.25',
    metadata: { channelId: 'C123RECEIPT' },
  }, {
    channelId: 'slack', conversationId: 'C123RECEIPT', messageId: '171.26', senderId: 'U-WORKER',
  });
  assert.equal(calls.length, 0);
});

test('receipt payment-source actions bind one exact receipt and only accept known choices', () => {
  const id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  assert.deepEqual(parseReceiptPaymentSourceAction(`personal:${id}`), {
    receiptId: id, paymentSource: 'personal_reimbursement',
  });
  assert.deepEqual(parseReceiptPaymentSourceAction(`kapital:${id}`), {
    receiptId: id, paymentSource: 'kapital_business_paid',
  });
  assert.deepEqual(parseReceiptPaymentSourceAction(`reimbursed:${id}`), {
    receiptId: id, paymentSource: 'already_reimbursed',
  });
  assert.equal(parseReceiptPaymentSourceAction(`personal:not-a-receipt`), null);
  assert.equal(parseReceiptPaymentSourceAction(`other:${id}`), null);
});

test('receipt payment-source button invokes the command-only workflow with trusted Slack identity and removes buttons', async () => {
  const receiptId = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  const config = pluginConfig({
    receiptChannelIds: ['C123RECEIPT'], shadowMode: true,
    liveWorkflowNames: ['receipt.payment_source.select'],
  });
  const calls = [];
  const edits = [];
  const result = await createReceiptPaymentSourceInteractionHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: { id: 'source-run', status: 'completed', output: {
        paymentSource: 'kapital_business_paid', status: 'queued',
      } } };
    },
  })({
    conversationId: 'C123RECEIPT', senderId: 'U123SERGIO', interactionId: 'interaction-1',
    interaction: { payload: `kapital:${receiptId}`, messageTs: '1786660382.599739' },
    respond: {
      acknowledge: async () => {},
      editMessage: async update => { edits.push(update); },
      reply: async () => { throw new Error('success must not emit an error reply'); },
    },
  });
  assert.deepEqual(result, { handled: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'receipt.payment_source.select');
  assert.deepEqual(calls[0].input, { receiptId, paymentSource: 'kapital_business_paid' });
  assert.deepEqual(calls[0].context, {
    channelId: 'C123RECEIPT', actorUserId: 'U123SERGIO',
    messageId: '1786660382.599739', entrypoint: 'slack_receipt_source_action',
  });
  assert.equal(calls[0].idempotencyKey, `receipt:${receiptId}:payment-source:kapital_business_paid`);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].blocks, []);
  assert.match(edits[0].text, /Pagado con Kapital/);
});

test('native receipt Block Kit action routes through the receiptsource namespace', async () => {
  const receiptId = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd';
  const prompt = buildReceiptPaymentSourcePrompt(receiptId);
  const kapital = prompt.slackBlocks[1].elements[1];
  const routedData = `${kapital.action_id}:${kapital.value}`;
  const [namespace, ...payloadParts] = routedData.split(':');
  assert.equal(namespace, 'receiptsource');

  const calls = [];
  const result = await createReceiptPaymentSourceInteractionHandler({
    config: pluginConfig({
      receiptChannelIds: ['C123RECEIPT'], shadowMode: true,
      liveWorkflowNames: ['receipt.payment_source.select'],
    }),
    execute: async (_config, request) => {
      calls.push(request);
      return { run: { id: 'source-run', status: 'completed', output: { status: 'queued' } } };
    },
  })({
    conversationId: 'C123RECEIPT', senderId: 'U123SERGIO',
    interaction: { payload: payloadParts.join(':'), messageTs: '1786660382.599739' },
    respond: { acknowledge: async () => {}, editMessage: async () => {} },
  });

  assert.deepEqual(result, { handled: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    receiptId,
    paymentSource: 'kapital_business_paid',
  });
});

test('accounting CSV dispatch detects finalized media without relying on command text', () => {
  assert.equal(accountingCsvSignalFromFinalizedContext({
    BodyForCommands: 'Can you please process this',
    MediaTypes: ['text/csv'],
    MediaPaths: ['/runtime/media/statement.csv'],
  }), true);
  assert.equal(accountingCsvSignalFromFinalizedContext({
    BodyForAgent: '[Slack file: ECta826 (2).csv (fileId: F-CSV)]',
  }), true);
  assert.equal(accountingCsvSignalFromFinalizedContext({
    BodyForCommands: 'What was the latest reconciliation status?',
  }), false);
});

test('parses authoritative accounting reconciliation reads without claiming CSV uploads', () => {
  assert.deepEqual(parseAccountingReconciliationRequest(
    'Please give me a breakdown of the most recent reconciliation',
  ), { detail: true, view: 'summary', order: 'desc' });
  assert.deepEqual(parseAccountingReconciliationRequest(
    'Are there any transactions that have not been recorded in QBO?',
  ), { detail: true, view: 'summary', order: 'desc' });
  assert.deepEqual(parseAccountingReconciliationRequest(
    'please list the reconciled transactions in order starting with most recent',
  ), { detail: true, view: 'transactions', order: 'desc' });
  assert.deepEqual(parseAccountingReconciliationRequest(
    'show the reconciled transactions starting with the oldest',
  ), { detail: true, view: 'transactions', order: 'asc' });
  assert.equal(parseAccountingReconciliationRequest('Please process this CSV'), null);
  assert.equal(parseAccountingReconciliationRequest('How much cash is in Kapital?'), null);
});

test('parses a specific QBO transaction verification into narrow receipt-ledger filters', () => {
  assert.deepEqual(parseAccountingTransactionRequest(`Please verify that this transaction was posted to QBO to his Other Liabilities account:
• Amount: $3,300.00 MXN
• Date: Aug 14, 2026
• Payee: Fidencio Lopez (Bancoppel •6587)
• Reference: 0674062090`), {
    amount: 3300,
    currency: 'MXN',
    date: '2026-08-14',
    detail: true,
    limit: 10,
    order: 'desc',
    query: 'Fidencio Lopez',
  });
  assert.equal(parseAccountingTransactionRequest('What is the latest reconciliation summary?'), null);
  assert.equal(parseAccountingTransactionRequest('Did we pay Fidencio?'), null);
});

test('formats a complete QBO reconciliation with recorded category review separated from missing entries', () => {
  const text = formatAccountingReconciliationReply({ run: {
    id: 'read-run', workflow_name: 'accounting.reconciliation.read', status: 'completed',
    output: {
      latest: {
        workflowRunId: 'qbo-run', evidenceId: 'qbo-evidence',
        summary: {
          complete: true, principalRecorded: 23, principalTotal: 23,
          principalWritten: 4, dedupSkipped: 19,
          feeRecordsRecorded: 40, feeRecordsExpected: 40,
          feeRecordsWritten: 6, feeRecordsExisting: 34,
          held: 0, reviewRequired: 1,
          statement: {
            date_start: '2026-08-03', date_end: '2026-08-14',
            total_outflows_mxn: 69765.89, spei_fees_mxn: 92.8,
          },
          categoryTotals: [
            { category: 'Maintenance', amount_mxn: 32644.16, transactions: 9 },
            { category: 'Uncategorized Expense', amount_mxn: 2105, transactions: 1 },
          ],
          reviewDetails: [{
            date: '2026-08-06', amount: 2105, qbo_id: '2601',
            review_reason: 'receipt payment reference required',
          }],
          heldDetails: [],
        },
      },
      _evidence: { id: 'read-evidence' },
    },
  } });
  assert.match(text, /Every statement principal and SPEI fee line is recorded in QBO/);
  assert.match(text, /Principal transactions recorded: 23\/23/);
  assert.match(text, /SPEI fee lines recorded: 40\/40/);
  assert.match(text, /Total statement outflows: MXN 69,765\.89/);
  assert.match(text, /Not recorded: 0/);
  assert.match(text, /Uncategorized Expense; category review required/);
  assert.match(text, /QBO 2601/);
  assert.match(text, /QBO reconciliation: qbo-run · QBO evidence: qbo-evidence/);
  assert.match(text, /Authoritative read: read-run · Evidence: read-evidence/);
});

test('formats the full reconciled transaction list from durable QBO projections', () => {
  const text = formatAccountingReconciliationReply({ run: {
    id: 'read-list', workflow_name: 'accounting.reconciliation.read', status: 'completed',
    output: {
      latest: {
        workflowRunId: 'qbo-run', view: 'transactions', order: 'desc',
        summary: {
          complete: true, principalRecorded: 2, principalTotal: 2,
          feeRecordsRecorded: 2, feeRecordsExpected: 2, held: 0,
          statement: { date_start: '2026-08-13', date_end: '2026-08-14', spei_fees_mxn: 4.64 },
        },
        transactions: [
          { transaction_date: '2026-08-14', amount: 3300, currency: 'MXN', description: 'FIDENCIO LOPEZ', qbo_category_name: 'Contract Labor', qbo_entity_type: 'JournalEntry', qbo_entity_id: '2602' },
          { transaction_date: '2026-08-13', amount: 1088, currency: 'MXN', description: 'Envio SPEI AZTECA | SUSY Dato no verificado por esta institucion | 127564013982211433 | 1704637622', qbo_category_name: 'Cleaning Services', qbo_entity_type: 'Purchase', qbo_entity_id: '2601' },
          { transaction_date: '2026-08-10', amount: 2499, currency: 'MXN', description: 'HOME DEP8786NUEV VALL2 _260807 HDM 001017AS1 _BAHIA DE BAND _2499.00 _MXN_ TC: 1.00 _75412916220949459885888', qbo_category_name: 'Maintenance', qbo_entity_type: 'Purchase', qbo_entity_id: '2600' },
        ],
      },
      _evidence: { id: 'read-evidence' },
    },
  } });
  assert.match(text, /Reconciled principal transactions \(3\), most recent first/);
  assert.match(text, /2026-08-14 — MXN 3,300\.00 — FIDENCIO LOPEZ — Contract Labor — QBO JournalEntry 2602/);
  assert.match(text, /2026-08-13 — MXN 1,088\.00 — SUSY — Cleaning Services — QBO Purchase 2601/);
  assert.match(text, /2026-08-10 — MXN 2,499\.00 — HOME DEP8786NUEV VALL2 — Maintenance — QBO Purchase 2600/);
  assert.doesNotMatch(text, /127564013982211433|Dato no verificado|75412916220949459885888|260807 HDM/);
  assert.match(text, /Plus 2\/2 separately recorded SPEI fee lines/);
});

test('specific accounting lookup reports one posting and ignored duplicate captures', () => {
  const text = formatAccountingTransactionReply({ run: {
    id: 'receipt-read', workflow_name: 'receipts.status.read', status: 'completed',
    output: {
      receipts: [
        { id: 'canonical', status: 'posted', transaction_date: '2026-08-14', currency: 'MXN', amount: 3300, vendor: 'Fidencio Lopez', category_name: 'Contract Labor', qbo_entity_type: 'JournalEntry', qbo_entity_id: '2602' },
        { id: 'duplicate', status: 'ignored', transaction_date: '2026-08-14', currency: 'MXN', amount: 3300, vendor: 'Fidencio Lopez' },
      ],
      _evidence: { id: 'receipt-evidence' },
    },
  } });
  assert.match(text, /Recorded exactly once in QBO: JournalEntry 2602/);
  assert.match(text, /Duplicate receipt captures ignored: 1/);
  assert.match(text, /Evidence: receipt-evidence/);
});

test('accounting transaction dispatch claims a specific verification before the model runs', async () => {
  const config = pluginConfig({ accountingChannelIds: ['CACCOUNTING'], slackAccountId: 'ig-drafts' });
  const calls = [];
  const sent = [];
  let finalized;
  const handler = createAccountingTransactionReplyDispatchHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: { id: 'receipt-read', workflow_name: 'receipts.status.read', status: 'completed', output: {
        receipts: [{ id: 'receipt-1', status: 'needs_review', transaction_date: '2026-08-14', currency: 'MXN', amount: 3300, vendor: 'Fidencio Lopez', review_reason: 'classification review required' }],
      } } };
    },
  });
  const result = await handler({
    ctx: {
      Provider: 'slack', AccountId: 'ig-drafts', OriginatingChannel: 'slack',
      OriginatingTo: 'channel:CACCOUNTING', MessageSidFull: '1786741927.364459', SenderId: 'U-JASON',
      BodyForCommands: 'verify this was posted to QBO\n• Amount: $3,300 MXN\n• Date: Aug 14, 2026\n• Payee: Fidencio Lopez',
    },
    sendPolicy: 'allow',
  }, {
    dispatcher: {
      sendFinalReply(payload) { sent.push(payload); return true; },
      getQueuedCounts() { return { final: sent.length }; },
    },
    recordProcessed(outcome, details) { finalized = { outcome, details }; },
    markIdle() {},
  });
  assert.equal(result.handled, true);
  assert.equal(calls[0].workflow, 'receipts.status.read');
  assert.equal(calls[0].input.query, 'Fidencio Lopez');
  assert.match(sent[0].text, /not recorded in QBO/);
  assert.deepEqual(finalized, { outcome: 'completed', details: { reason: 'accounting_transaction_reply_dispatch' } });
});

test('accounting reconciliation dispatch claims latest-status questions before the model runs', async () => {
  const config = pluginConfig({
    accountingChannelIds: ['CACCOUNTING'], slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
  });
  const calls = [];
  const sent = [];
  let finalized;
  const handler = createAccountingReconciliationReplyDispatchHandler({
    config,
    execute: async (_config, request) => {
      calls.push(request);
      return { run: {
        id: 'read-run', workflow_name: 'accounting.reconciliation.read', status: 'completed',
        output: { latest: { workflowRunId: 'qbo-run', summary: {
          complete: true, principalRecorded: 23, principalTotal: 23,
          feeRecordsRecorded: 40, feeRecordsExpected: 40, held: 0,
          statement: { date_start: '2026-08-03', date_end: '2026-08-14', total_outflows_mxn: 69765.89 },
        } } },
      } };
    },
  });
  const result = await handler({
    ctx: {
      Provider: 'slack', AccountId: 'ig-drafts', OriginatingChannel: 'slack',
      OriginatingTo: 'channel:CACCOUNTING', MessageSidFull: '1786740877.710399',
      SenderId: 'U-JASON', BodyForCommands: 'please give me breakdown of the most recent reconciliation',
    },
    sendPolicy: 'allow',
  }, {
    dispatcher: {
      sendFinalReply(payload) { sent.push(payload); return true; },
      getQueuedCounts() { return { final: sent.length }; },
    },
    recordProcessed(outcome, details) { finalized = { outcome, details }; },
    markIdle() {},
  });
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, 'accounting.reconciliation.read');
  assert.equal(calls[0].context.entrypoint, 'slack_accounting_reconciliation_read');
  assert.match(sent[0].text, /Principal transactions recorded: 23\/23/);
  assert.deepEqual(finalized, {
    outcome: 'completed', details: { reason: 'accounting_reconciliation_reply_dispatch' },
  });
});

test('accounting CSV reply dispatch stages trusted Slack uploads and stops model execution', async () => {
  const config = pluginConfig({
    accountingChannelIds: ['CACCOUNTING'], slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
  });
  const calls = [];
  const sent = [];
  let finalized = null;
  const handler = createAccountingStatementReplyDispatchHandler({
    config,
    stage: async request => {
      calls.push(request);
      return { files: [{ name: 'statement.csv', staged: true, alreadyCaptured: false, alreadyProcessed: false }] };
    },
  });
  const result = await handler({
    ctx: {
      Provider: 'slack', AccountId: 'ig-drafts', OriginatingChannel: 'slack',
      OriginatingTo: 'channel:CACCOUNTING', MessageSidFull: '1786640000.25',
      SenderId: 'U-JASON', BodyForCommands: 'Can you please process this',
      MediaTypes: ['text/csv'], MediaPaths: ['/runtime/media/statement.csv'],
    },
    sendPolicy: 'allow',
  }, {
    dispatcher: {
      sendFinalReply(payload) { sent.push(payload); return true; },
      getQueuedCounts() { return { final: sent.length }; },
    },
    recordProcessed(outcome, details) { finalized = { outcome, details }; },
    markIdle() {},
  });
  assert.deepEqual(calls, [{
    channelId: 'CACCOUNTING', messageId: '1786640000.25', threadTs: null,
  }]);
  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, true);
  assert.match(sent[0].text, /1 newly queued/);
  assert.match(sent[0].text, /separate completion notice/);
  assert.deepEqual(finalized, {
    outcome: 'completed', details: { reason: 'accounting_statement_reply_dispatch' },
  });
});

test('accounting CSV claim reports an exact previously processed file without restaging it', async () => {
  const config = pluginConfig({
    accountingChannelIds: ['CACCOUNTING'], slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
  });
  const result = await createAccountingStatementClaimHandler({
    config,
    stage: async () => ({ files: [{
      name: 'prior.csv', staged: false, alreadyCaptured: false, alreadyProcessed: true,
    }] }),
  })({
    channel: 'slack', accountId: 'ig-drafts', conversationId: 'CACCOUNTING',
    messageId: '1786640000.251', senderId: 'U-JASON', hasCsvAttachment: true,
  }, {});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /already processed successfully/);
  assert.match(result.reply.text, /not queued or written to QBO again/);
});

test('accounting CSV dispatch fails closed when provider readback cannot verify the attachment', async () => {
  const config = pluginConfig({
    accountingChannelIds: ['CACCOUNTING'], slackAccountId: 'ig-drafts', shadowMode: true,
    liveWorkflowNames: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
  });
  const result = await createAccountingStatementClaimHandler({
    config,
    stage: async () => {
      const error = new Error('Slack accounting message contains no CSV attachment');
      error.code = 'accounting_csv_missing';
      throw error;
    },
    logger: { error() {} },
  })({
    channel: 'slack', accountId: 'ig-drafts', conversationId: 'CACCOUNTING',
    messageId: '1786640000.252', hasCsvAttachment: true,
  }, {});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /provider readback could not verify/);
  assert.match(result.reply.text, /Nothing was staged or written to QBO/);
});

test('accounting CSV claim ignores non-CSV messages and other channels', async () => {
  const config = pluginConfig({
    accountingChannelIds: ['CACCOUNTING'], shadowMode: true,
    liveWorkflowNames: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
  });
  const handler = createAccountingStatementClaimHandler({
    config,
    stage: async () => assert.fail('non-accounting CSV event must not be staged'),
  });
  assert.equal(await handler({
    channel: 'slack', conversationId: 'CACCOUNTING', messageId: '1786640000.26',
    hasCsvAttachment: false,
  }, {}), undefined);
  assert.equal(await handler({
    channel: 'slack', conversationId: 'C-OTHER', messageId: '1786640000.27',
    hasCsvAttachment: true,
  }, {}), undefined);
});

test('accounting CSV claim blocks model improvisation before the complete workflow is live', async () => {
  const config = pluginConfig({
    accountingChannelIds: ['CACCOUNTING'], shadowMode: true,
    liveWorkflowNames: ['accounting.classify', 'qbo.write'],
  });
  const result = await createAccountingStatementClaimHandler({
    config,
    stage: async () => assert.fail('partial accounting cutover must not stage a statement'),
  })({
    channel: 'slack', conversationId: 'CACCOUNTING', messageId: '1786640000.28',
    hasCsvAttachment: true,
  }, {});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /complete accounting workflow is not live/);
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

test('task-list parser handles self, named, completed, and all-staff requests without claiming assignments', () => {
  const users = { sergio: 'U-SERGIO', mayela: 'U-MAYELA' };
  assert.deepEqual(parseTaskListRequest('¿Cuáles son mis tareas pendientes?', {
    senderId: 'U-ASKER', senderName: 'Ana', users,
  }), { status: 'active', userId: 'U-ASKER', selectorLabel: 'Ana' });
  assert.deepEqual(parseTaskListRequest('What tasks does Sergio have?', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('¿Qué ha completado Sergio?', {
    senderId: 'U-ASKER', users,
  }), { status: 'completed', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('Show active tasks for everyone', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', all: true });
  assert.deepEqual(parseTaskListRequest('Show my task history including completed', {
    senderId: 'U-ASKER', users,
  }), { status: 'all', userId: 'U-ASKER', selectorLabel: undefined });
  assert.deepEqual(parseTaskListRequest('¿Qué tengo que hacer?', {
    senderId: 'U-ASKER', senderName: 'Ana', users,
  }), { status: 'active', userId: 'U-ASKER', selectorLabel: 'Ana' });
  assert.deepEqual(parseTaskListRequest('What does Sergio need to do?', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('What is <@U-SERGIO> jobs that need to be done?', {
    senderId: 'U-ASKER', mentionedUserIds: ['U-SERGIO'], users,
  }), { status: 'active', userId: 'U-SERGIO' });
  assert.deepEqual(parseTaskListRequest('What work needs to be completed for Sergio?', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('¿Qué trabajos necesita hacer Sergio?', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('Cuál es mi trabajo de hoy', {
    senderId: 'U-ASKER', senderName: 'Ana', users,
  }), { status: 'active', userId: 'U-ASKER', selectorLabel: 'Ana' });
  assert.deepEqual(parseTaskListRequest('What has Sergio done?', {
    senderId: 'U-ASKER', users,
  }), { status: 'completed', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('Which jobs has Sergio completed?', {
    senderId: 'U-ASKER', users,
  }), { status: 'completed', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('What tasks are left for Sergio?', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest("Which jobs aren't finished for Sergio?", {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.deepEqual(parseTaskListRequest('¿Qué trabajos no están terminados de Sergio?', {
    senderId: 'U-ASKER', users,
  }), { status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' });
  assert.equal(parseTaskListRequest('Tarea para Sergio: pegar etiquetas en el intercomunicador.', {
    senderId: 'U-ASKER', users,
  }), null);
});

test('Paloma task claim is scoped to its configured agent, account, and joined channels', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paloma-task-claim-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ users: { sergio: 'U-SERGIO' } }));
  const config = pluginConfig({
    taskTrackerAgentIds: ['paloma'],
    taskTrackerAccountIds: ['paloma-resort'],
    taskTrackerChannelIds: ['C-MAINT'],
    taskTrackerDatabasePath: path.join(directory, 'tasks.db'),
    taskTrackerConfigPath: configPath,
  });
  const calls = [];
  const claim = createTaskListClaimHandler({
    config,
    report: async (_config, request) => { calls.push(request); return 'REPORTE BILINGÜE EXACTO'; },
  });
  try {
    assert.equal(await claim({
      channel: 'slack', agentId: 'resort', accountId: 'paloma-resort',
      conversationId: 'C-MAINT', senderId: 'U-MAYELA',
      bodyForAgent: 'What is Sergio jobs that need to be done?',
    }), undefined);
    assert.equal(await claim({
      channel: 'slack', agentId: 'paloma', accountId: 'other',
      conversationId: 'C-MAINT', senderId: 'U-MAYELA',
      bodyForAgent: '¿Cuáles son las tareas de Sergio?',
    }), undefined);
    const result = await claim({
      channel: 'slack', agentId: 'paloma', accountId: 'paloma-resort',
      conversationId: 'C-MAINT', senderId: 'U-MAYELA',
      bodyForAgent: 'What is Sergio jobs that need to be done?',
    });
    assert.equal(result.handled, true);
    assert.equal(result.reply.text, 'REPORTE BILINGÜE EXACTO');
    assert.deepEqual(calls, [{ status: 'active', userId: 'U-SERGIO', selectorLabel: 'sergio' }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Paloma task reply dispatch sends the deterministic report before the model runs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paloma-task-dispatch-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ users: { sergio: 'U-SERGIO' } }));
  const config = pluginConfig({
    taskTrackerAgentIds: ['paloma'],
    taskTrackerAccountIds: ['paloma-resort'],
    taskTrackerChannelIds: ['C-MAINT'],
    taskTrackerDatabasePath: path.join(directory, 'tasks.db'),
    taskTrackerConfigPath: configPath,
  });
  const sent = [];
  let finalized = null;
  let idleReason = null;
  const handler = createTaskListReplyDispatchHandler({
    config,
    report: async () => 'ESPAÑOL\n\n───\n\nENGLISH',
  });
  try {
    const result = await handler({
      sessionKey: 'agent:paloma:slack:channel:C-MAINT',
      ctx: {
        Provider: 'slack', Surface: 'slack', AccountId: 'paloma-resort',
        OriginatingChannel: 'slack', OriginatingTo: 'channel:C-MAINT',
        MessageSidFull: '1786566667.700001', SenderId: 'U-MAYELA', SenderName: 'Mayela',
        BodyForCommands: 'What tasks does Sergio have?', CommandAuthorized: true,
      },
      inboundAudio: false, shouldRouteToOriginating: false,
      shouldSendToolSummaries: true, sendPolicy: 'allow',
    }, {
      dispatcher: {
        sendFinalReply(payload) { sent.push(payload); return true; },
        getQueuedCounts() { return { tool: 0, block: 0, final: sent.length }; },
      },
      recordProcessed(outcome, details) { finalized = { outcome, details }; },
      markIdle(reason) { idleReason = reason; },
    });
    assert.equal(result.handled, true);
    assert.equal(result.queuedFinal, true);
    assert.deepEqual(sent, [{ text: 'ESPAÑOL\n\n───\n\nENGLISH' }]);
    assert.deepEqual(finalized, {
      outcome: 'completed', details: { reason: 'paloma_task_reply_dispatch' },
    });
    assert.equal(idleReason, 'message_completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reservations tool guard blocks shell bypass even when OpenClaw misses the channel allowlist', async () => {
  const guard = createReservationToolGuard({
    config: pluginConfig({ reservationsChannelIds: ['C-RES'] }),
  });
  assert.deepEqual(await guard({ toolName: 'exec', params: {} }, {
    channelId: 'c-res',
  }), {
    block: true,
    blockReason: 'This controlled resort channel is restricted to the durable resort_workflow control plane.',
  });
  assert.equal(await guard({ toolName: 'resort_workflow', params: {} }, {
    channelId: 'c-res',
  }), undefined);
  assert.equal(await guard({ toolName: 'exec', params: {} }, {
    channelId: 'C-OTHER',
  }), undefined);
});

test('controlled-channel tool guard blocks direct accounting and receipt tool bypasses', async () => {
  const guard = createControlledChannelToolGuard({
    config: pluginConfig({
      agentIds: ['resort'],
      controlledChannelIds: ['C-ACCOUNTING', 'C-RECEIPT'],
    }),
  });
  assert.deepEqual(await guard({ toolName: 'exec', params: {} }, {
    agentId: 'resort', channelId: 'c-accounting',
  }), {
    block: true,
    blockReason: 'This controlled resort channel is restricted to the durable resort_workflow control plane.',
  });
  assert.deepEqual(await guard({ toolName: 'qbo_push', params: {} }, {
    agentId: 'resort', channelId: 'C-RECEIPT',
  }), {
    block: true,
    blockReason: 'This controlled resort channel is restricted to the durable resort_workflow control plane.',
  });
  assert.equal(await guard({ toolName: 'resort_workflow', params: {} }, {
    agentId: 'resort', channelId: 'C-ACCOUNTING',
  }), undefined);
  assert.equal(await guard({ toolName: 'exec', params: {} }, {
    agentId: 'resort', channelId: 'C-OTHER',
  }), undefined);
  assert.equal(await guard({ toolName: 'exec', params: {} }, {
    agentId: 'paloma', channelId: 'C-ACCOUNTING',
  }), undefined);
});

test('controlled-channel tool guard remains fail-closed when agent identity is unavailable', async () => {
  const guard = createControlledChannelToolGuard({
    config: pluginConfig({ agentIds: ['resort'], controlledChannelIds: ['C-ACCOUNTING'] }),
  });
  assert.deepEqual(await guard({ toolName: 'exec', params: {} }, {
    channelId: 'C-ACCOUNTING',
  }), {
    block: true,
    blockReason: 'This controlled resort channel is restricted to the durable resort_workflow control plane.',
  });
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

test('plain WhatsApp thread questions reach the model while sends remain explicit commands', async () => {
  const config = pluginConfig({ whatsappChannelIds: ['C-WA'], shadowMode: false });
  const result = await createInboundClaimHandler({ config })({
    channel: 'slack', conversationId: 'C-WA', threadId: '123.456', bodyForAgent: 'Is this available?',
  }, {});
  assert.equal(result, undefined);
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
  await assert.rejects(() => tool.execute('tool-call-5', {
    workflow: 'receipt.ingest', input: { slackMessageId: 'model-guessed' },
  }), error => error.code === 'workflow_command_required');
  await assert.rejects(() => tool.execute('tool-call-6', {
    workflow: 'receipt.payment_source.select', input: {},
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

test('Meta DM command is refused while meta.dm.reply is quarantined from live workflows', async () => {
  const config = pluginConfig({
    socialChannelIds: ['C-SOCIAL'], shadowMode: true,
    liveWorkflowNames: ['whatsapp.reply', 'marketing.change.confirm'],
  });
  const calls = [];
  const result = await createMetaDmClaimHandler({
    config, execute: async (_config, request) => { calls.push(request); return {}; },
  })({
    channel: 'slack', conversationId: 'C-SOCIAL', messageId: '2000.2', senderId: 'U-JASON',
    senderName: 'Jason', bodyForAgent: '!dm 42 Welcome',
  }, {});
  assert.equal(result.handled, true);
  assert.equal(result.reply.text, 'Not sent. Meta DM replies are still in shadow mode.');
  assert.equal(calls.length, 0);
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

test('claim handlers intercept gateway conversation ids carrying the channel: prefix', async () => {
  // OpenClaw emits conversationId as `channel:CXXXX`; every claim handler must
  // normalize it before the channel-membership gate or the command silently
  // falls through to the conversational agent (2026-08-17 incident: !wa,
  // !email confirm, !receipt confirm, !meta confirm, and !review resolve all
  // dead while the strip-normalized handlers kept working).
  const resolutions = [];
  const review = await createManualReviewClaimHandler({
    config: pluginConfig({ slackAccountId: 'ig-drafts', controlledChannelIds: ['C-REVIEW'] }),
    resolve: async (_config, request) => {
      resolutions.push(request);
      return { review: { id: request.reviewId, resolution: request.resolution } };
    },
  })({
    channel: 'slack', accountId: 'ig-drafts', conversationId: 'channel:C-REVIEW',
    messageId: '300.1', senderId: 'U-JASON',
    bodyForAgent: '!review resolve 3ce3ad0f-61e6-4113-8466-1b5c19a6494a not-sent',
  }, {});
  assert.equal(review.handled, true);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].resolution, 'confirmed_not_sent');
  assert.equal(resolutions[0].channelId, 'C-REVIEW');
  assert.match(review.reply.text, /resolved as confirmed_not_sent/);

  const emailCalls = [];
  const email = await createEmailClaimHandler({
    config: pluginConfig({
      slackAccountId: 'ig-drafts',
      emailChannelIds: ['CPAULINA'],
      liveWorkflowNames: ['email.reply.propose'],
    }),
    execute: async (_config, request) => {
      emailCalls.push(request);
      return { run: { id: 'run', workflow_name: request.workflow, status: 'completed',
        output: { status: 'awaiting_explicit_confirmation', bodyText: 'x', confirmationCommand: '!email confirm id hash' } } };
    },
  })({
    channel: 'slack', accountId: 'ig-drafts', conversationId: 'channel:CPAULINA',
    messageId: '300.2', senderId: 'U-SARAH', threadId: '1786549495.693669',
    bodyForAgent: '!email reply Prefixed conversation ids must still intercept.',
  }, {});
  assert.equal(email.handled, true);
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].idempotencyKey, 'slack:CPAULINA:300.2:email.reply.propose');
});


test('exact commands intercept when the gateway wraps the body in metadata preamble', async () => {
  const wrapped = [
    'Conversation info (untrusted metadata):',
    '```json',
    '{ "chat_id": "channel:C-REVIEW", "sender_id": "UTESTOWNER1" }',
    '```',
    '',
    'Sender (untrusted metadata):',
    '```json',
    '{ "label": "Jason Starkey (UTESTOWNER1)" }',
    '```',
    '',
    '!review resolve 3ce3ad0f-61e6-4113-8466-1b5c19a6494a not-sent',
  ].join('\n');

  assert.equal(
    claimCommandText({ bodyForAgent: wrapped }),
    '!review resolve 3ce3ad0f-61e6-4113-8466-1b5c19a6494a not-sent',
  );
  assert.equal(claimCommandText({ body: '!wa hello there' }), '!wa hello there');
  assert.equal(claimCommandText({ bodyForAgent: 'next arrival?' }), 'next arrival?');

  const resolutions = [];
  const review = await createManualReviewClaimHandler({
    config: pluginConfig({ slackAccountId: 'ig-drafts', controlledChannelIds: ['C-REVIEW'] }),
    resolve: async (_config, request) => {
      resolutions.push(request);
      return { review: { id: request.reviewId, resolution: request.resolution } };
    },
  })({
    channel: 'slack', accountId: 'ig-drafts', conversationId: 'channel:C-REVIEW',
    messageId: '301.1', senderId: 'U-JASON', bodyForAgent: wrapped,
  }, {});
  assert.equal(review.handled, true);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].resolution, 'confirmed_not_sent');
});
