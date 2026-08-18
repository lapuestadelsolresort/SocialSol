'use strict';

// The operator command table: which Slack surface owns which workflow
// capabilities, and the exact shape of every typed command.
//
// Two consumers read this one table, which is the point — the generated
// command documentation (scripts/generate-command-docs.js) and the Slack
// `!help` surface (openclaw-plugins/resort-workflows) can describe different
// *states* but can never describe different commands. Deliberately free of
// dependencies: the gateway plugin requires it, and pulling the workflow
// registry into that process would load the whole CRM stack for a help reply.

// Every `usage` string is parsed by the real plugin parser in
// scripts/generate-command-docs.test.js, so a parser change these strings no
// longer satisfy fails the stack check rather than silently misinforming an
// operator.
const TRIGGERS = {
  slack_whatsapp_command: {
    label: '`!wa`',
    usage: ['!wa <wa-id> <message>', '!wa <message>'],
    detail: 'human-typed in the WhatsApp console channel; the threaded form omits the wa-id',
  },
  slack_meta_dm_command: {
    label: '`!dm`',
    usage: ['!dm <page-scoped-id> <message>'],
    detail: 'human-typed in the social channel',
  },
  slack_email_reply_command: {
    label: '`!email reply`',
    usage: ['!email reply <text>'],
    detail: 'typed in the recorded conversation thread; creates an immutable proposal and sends nothing',
  },
  slack_email_confirm_command: {
    label: '`!email confirm`',
    usage: ['!email confirm <request-id> <hash>'],
    detail: 'the exact emitted command, from the same user; this is the send',
  },
  slack_email_classify_command: {
    label: '`!email classify`',
    usage: ['!email classify <conversation-id> <hot|not_interested|ambiguous>'],
    detail: 'records a reply classification; sends nothing',
  },
  slack_meta_campaign_confirm_command: {
    label: '`!meta confirm`',
    usage: ['!meta confirm <request-id> <hash>'],
    detail: 'the exact emitted command, from the same proposer, inside the 15-minute window',
  },
  slack_ownerrez_command: {
    label: '`!ownerrez confirm`',
    usage: ['!ownerrez confirm <request-id> <hash>'],
    detail: 'the exact emitted command, from the same proposer, inside the 15-minute window',
  },
  slack_receipt_confirm_command: {
    label: '`!receipt confirm`',
    usage: [
      '!receipt confirm <receipt-id> <YYYY-MM-DD> <MXN|USD> <amount> <account-code> | <description>',
      '!receipt confirm repayment <receipt-id> <YYYY-MM-DD> <MXN|USD> <amount> | <description>',
    ],
    detail: 'owner-ledger confirmation; `expense` may precede the receipt id',
  },
  slack_receipt_hook: {
    label: 'automatic',
    usage: [],
    detail: 'fires on a top-level post in a scoped receipt channel — there is no command to type',
  },
  slack_receipt_source_action: {
    label: 'buttons',
    usage: [],
    detail: 'the payment-source buttons posted under the receipt — never a typed command',
  },
  auto_confirm_dispatch: {
    label: 'policy-armed',
    usage: [],
    detail: 'automatic confirmation, only for operations armed in the runtime policy; dormant otherwise',
  },
  system: { label: 'scheduled', usage: [], detail: 'system trigger only — no operator entry point' },
  workflow: { label: 'child run', usage: [], detail: 'started by another workflow, never directly' },
  admin_reconciliation: { label: 'admin CLI', usage: [], detail: 'administrative reconciliation entry point' },
  '*': { label: 'agent tool', usage: [], detail: 'ask in the channel; runs through the `resort_workflow` tool' },
};

// `name` is the channel name in the runtime policy. `doc` is the operator
// reference whose generated block this surface owns.
const SURFACES = [
  {
    name: 'whatsapp',
    title: 'WhatsApp console',
    doc: 'docs/commands/whatsapp.md',
    capabilities: ['whatsapp.send', 'whatsapp.read'],
  },
  {
    name: 'social-sol',
    title: 'Paid Meta, social publishing, and Meta DMs',
    doc: 'campaigns/COMMANDS.md',
    capabilities: ['marketing.write', 'marketing.read', 'social.publish', 'social.write', 'social.read'],
  },
  {
    name: 'prospector-paulina',
    title: 'Prospector Paulina',
    doc: 'prospector/COMMANDS.md',
    capabilities: ['paulina.prepare', 'paulina.send', 'paulina.read', 'email.send', 'email.read'],
  },
  {
    name: 'sarah-email',
    title: 'Sarah Email',
    doc: 'sarah-email/COMMANDS.md',
    capabilities: ['email.send', 'email.read'],
  },
  {
    name: 'reengager-regina',
    title: 'Reengager Regina',
    doc: 'regina/COMMANDS.md',
    capabilities: ['regina.send'],
  },
  {
    name: 'sarah-coach',
    title: 'Sarah Coach',
    doc: 'sarah-coach/COMMANDS.md',
    capabilities: ['guest_messages.draft'],
  },
  {
    name: 'accounting',
    title: 'Accounting, receipts, and the owner ledger',
    doc: 'accounting/COMMANDS.md',
    capabilities: [
      'accounting.write', 'accounting.read_scoped', 'qbo.write', 'qbo.read',
      'qbo.owner_expense.write', 'receipts.write', 'receipts.submit', 'receipts.read',
    ],
  },
  {
    name: 'reservations',
    title: 'Reservations and OwnerRez',
    doc: 'docs/commands/reservations.md',
    capabilities: ['ownerrez.write', 'ownerrez.read'],
  },
];

// Capabilities no single operator surface owns. Each records why, and the docs
// generator refuses to run when a registered workflow is covered by neither a
// surface nor an entry here.
const UNSURFACED = {
  'crm.write': 'automatic ingestion and sync — provider webhooks and scheduled syncs, no operator entry point',
  'crm.read': 'cross-domain read, available from the business-intel channel through the agent tool',
  'business.read': 'cross-domain read, available from the business-intel channel through the agent tool',
  'squarespace.read': 'cross-domain read, available from the business-intel channel through the agent tool',
};

// Commands that work in every controlled channel rather than belonging to one
// surface. `!review resolve` is not a workflow trigger — manual-review
// resolution is a control-plane call — so nothing in the registry would ever
// surface it, which is how it stayed undocumented.
const GLOBAL_COMMANDS = [
  {
    usage: [
      '!review resolve <review-id> sent <provider-ref>',
      '!review resolve <review-id> <not-sent|abandon>',
    ],
    detail: 'resolves an open manual review from any controlled channel',
  },
  {
    usage: ['!help'],
    detail: 'lists the commands and workflows this channel can actually run right now',
  },
];

// Commands whose only home is an operator terminal. Typing one in Slack does
// nothing at all, which is exactly the confusion F-048 recorded, so the
// unknown-command reply names them instead of staying silent.
const TERMINAL_ONLY_COMMANDS = {
  '!sent': 'Regina draft bookkeeping — `node regina/scripts/sent.js --slack-thread-ts <ts>`',
  '!skip': 'Regina draft bookkeeping — `node regina/scripts/skip.js --slack-thread-ts <ts>`',
  '!defer': 'Regina draft bookkeeping — `node regina/scripts/defer.js --slack-thread-ts <ts> --message "!defer <days>"`',
};

function triggerInfo(trigger) {
  return TRIGGERS[trigger || '*'] || { label: `\`${trigger}\``, usage: [], detail: '' };
}

function surfaceByName(name) {
  return SURFACES.find(surface => surface.name === name) || null;
}

// The distinct typed commands reachable from a set of definitions, in the order
// the definitions supply them. Definitions with no typed trigger contribute
// nothing; a workflow may contribute a command through more than one trigger.
function commandsFor(definitions, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const seen = new Map();
  for (const definition of definitions) {
    if (excluded.has(definition.name)) continue;
    for (const trigger of definition.allowed_triggers || []) {
      const info = triggerInfo(trigger);
      if (!info.usage.length || seen.has(trigger)) continue;
      seen.set(trigger, info);
    }
  }
  return [...seen.values()];
}

module.exports = {
  TRIGGERS,
  SURFACES,
  UNSURFACED,
  GLOBAL_COMMANDS,
  TERMINAL_ONLY_COMMANDS,
  triggerInfo,
  surfaceByName,
  commandsFor,
};
