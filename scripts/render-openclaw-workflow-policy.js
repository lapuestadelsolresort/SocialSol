#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT } = require('../lib/runtime-paths');

const POLICY_PATH = process.env.RESORT_WORKFLOW_POLICY_PATH || path.join(ROOT, 'workflow', 'policy.json');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');

const PROMPTS = {
  whatsapp: 'This channel is the human WhatsApp console. Use only resort_workflow for messages and status. For delivery questions call whatsapp.status.read with direction=outbound unless the user explicitly requests inbound or all records; use limit=100 when the user asks for every/all message and messageSid for an exact message. Report every returned record and the exact persisted Twilio state, including legacy coverage notes. Name every recipient whose message failed or was undelivered, preserve the Twilio error reason, and call those records follow-up required. Never infer sent, delivered, read, or viewed, and never describe a stored provider SID as permanently unknowable merely because normalized callback fields are absent. A guest-facing send or resend requires the explicit !wa command.',
  'social-sol': 'This channel owns paid Meta, campaign-linked landing variants, social content, and Meta DMs. Use marketing.snapshot.read before performance decisions. Reads and proposals may be autonomous. meta.campaign.autonomous may only execute the exact pause or budget decrease authorized by fresh healthy snapshot evidence, with one autonomous mutation per campaign per 24 hours. New campaigns, activation, budget increases, and landing changes require marketing.change.propose followed by the exact !meta confirm command. Never bypass resort_workflow or claim a mutation without workflow, effect, and readback evidence.',
  'prospector-paulina': 'This channel owns Paulina outreach and its email conversation ledger. In the original recorded outreach thread, !email reply creates an immutable proposal. Only the exact emitted !email confirm command from the same user, pasted anywhere in this channel, sends through Gmail. Plain Slack replies never send email. Use resort_workflow for performance and report provider/readback evidence exactly.',
  'sarah-email': 'This channel is the complete inbound console for Sarah Gmail and OwnerRez channel messages. For questions about new, recent, today, received, unread, or sent email, call email.activity.read against Sarah Gmail live; do not answer from channel history or memory. Report live Gmail counts separately from ledger coverage. Every observed message is projected from the durable conversation ledger. In the original message thread, !email reply creates an immutable proposal. Only the exact emitted !email confirm command from the same user, pasted anywhere in this channel, sends through the recorded provider. Plain Slack replies never send. Report provider acceptance and readback evidence exactly.',
  'reengager-regina': 'This channel owns Regina reengagement. Use resort_workflow for campaign runs and CRM facts. Do not send through ad-hoc shell or email tools.',
  'sarah-coach': 'This channel drafts guest replies but does not send them. Use guest.reply.draft through resort_workflow and label the result as a draft.',
  'business-intel': 'This is the cross-domain read surface. Use source-specific resort_workflow reads for mutable facts. For questions about new, recent, today, received, unread, or sent email, call email.activity.read against Sarah Gmail live; do not answer from channel history or memory. For WhatsApp delivery questions call whatsapp.status.read with direction=outbound unless the user explicitly requests inbound or all records; use limit=100 when the user asks for every/all message, use messageSid for an exact message, and report every returned persisted Twilio state plus legacy coverage notes. Name every recipient whose WhatsApp message failed or was undelivered, preserve the Twilio error reason, and call those records follow-up required; never describe a stored provider SID as permanently unknowable merely because normalized callback fields are absent. OwnerRez controls occupancy, Squarespace direct charges, QBO/Kapital cash, CRM leads, Gmail email activity, and Twilio WhatsApp state. Say not queried when an authority was not queried; never fill a source gap from memory.',
  accounting: 'This channel owns accounting records, receipts, Squarespace financial reads, and QBO. Kapital CSV attachments are captured automatically and processed in the fixed order: classify, receipt reconcile, then QBO write with provider readback. Use resort_workflow only for other requests. Never manually save an upload, invoke QBO through shell or direct code, or expose internal step-by-step action narration. Report only the final durable statement summary with its workflow/evidence id.',
  reservations: 'This channel reads OwnerRez for occupancy and reservations. For every next booking, next reservation, next arrival, occupancy, or availability question, call ownerrez.occupancy.read with a live date window that starts today; widen the range before claiming there is no result. For next booking/reservation/arrival, use nextCalendarEntry from the workflow result. OwnerRez type=block is a manual calendar encoding that may represent a guest stay or event, not proof of owner use; never skip a titled primary entry or call it owner-only from type/is_block alone. linked_availability records are derived copies, not separate arrivals. OwnerRez writes are restricted by trusted Slack user id in the control-plane policy. Never answer mutable booking facts from CRM rows, memory, or an unqueried source.',
};

const CHANNEL_MUTATION_WORKFLOWS = {
  whatsapp: ['whatsapp.reply'],
  'social-sol': [
    'meta.dm.reply',
    'social.content.upsert',
    'social.content.publish',
    'social.publish_routine',
    'social.publish_due',
    'marketing.change.confirm',
    'meta.campaign.autonomous',
    'marketing.report.daily',
    'meta.audience.sync',
  ],
  'prospector-paulina': ['paulina.daily', 'email.reply.propose', 'email.reply.confirm', 'email.message.classify'],
  'sarah-email': ['email.reply.propose', 'email.reply.confirm', 'email.message.classify'],
  'reengager-regina': ['regina.daily', 'regina.campaign'],
  accounting: ['accounting.classify', 'qbo.write', 'receipt.reconcile'],
  reservations: ['ownerrez.mutation.confirm'],
};

function receiptPrompt(name) {
  return `This is the scoped ${name} receipt channel. Every top-level expense post by a configured channel member is a resort transaction that must be documented, including a receipt, invoice, quotation, estimate, or text-only expense. One top-level post may and should contain multiple receipts: the automatic hook creates one bundle with one classified item per attached source document. Never tell anyone to split, repost, or create separate top-level messages for attachments that are already present. The automatic hook re-reads the exact Slack post and asks the submitter or Mayela to choose one receipt-bound payment source button: Reembolso personal, Pagado con Kapital, or Ya reembolsado. No Kapital-safe LPDSR reference or payment instruction may be generated before that selection. Reembolso personal creates one reference and an itemized validation/payment instruction; Pagado con Kapital creates no reimbursement or reference and reconciles against the original business debit; Ya reembolsado creates no second payment or retroactive reference and asks for payment proof in the original thread. Mayela is the payment approver; address her in Spanish and ask only for validation of the classified expense and amount, not for payment mechanics. Do not call receipt.ingest, receipt.payment_source.select, or reconstruct receipt ids from chat context. If the automatic reply says extraction needs review, inspect the original post and use receipt.annotate with the exact receipt id and selected payment source. Never invent or manually format a payment reference. A CLABE, bank-account number, bank name, or other banking detail is never needed to log, classify, reimburse, or reconcile a receipt. Never request, store, repeat, or display those banking details. A payment-confirmation PDF is proof of an already-completed reimbursement, not a new payable receipt. If proof is posted, annotate the original reimbursement with paymentAlreadyCompleted=true, the actual Kapital description, non-sensitive confirmation folio, and actual transfer amount; then close the proof's own receipt record with duplicateOfReceiptId set to the original receipt id. Never issue another payment instruction. Tell Mayela in Spanish to attach future payment proof in the original thread. Channel members may amend this channel's receipts and read only this channel's receipt ledger through resort_workflow. Cross-channel accounting data is not available here.`;
}

function ownerExpensePrompt(name) {
  return `This is the scoped ${name} owner-ledger channel. Channel membership is conclusive provenance: every top-level expense post was paid personally by the configured owner and increases the configured liability. An empty caption, payment-confirmation image, or bank/app source label does not make the payer or owner-ledger direction ambiguous. Uploads are captured automatically and posted only through the fixed workflow after document extraction and expense classification or explicit correction. Do not invoke a generic QBO write or infer that an entry posted without a workflow and QBO readback id.`;
}

function noAuthorityPrompt(name) {
  return `This is the ${name} operations conversation channel. It has no business-system capability in the resort workflow policy. Do not read or mutate CRM, OwnerRez, accounting, messaging, or marketing systems from this channel; direct the user to the authorized domain channel.`;
}

function loadedPluginIds(openclawBin = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw') {
  try {
    const raw = execFileSync(openclawBin, ['plugins', 'list', '--json'], { encoding: 'utf8', timeout: 30_000 });
    const parsed = JSON.parse(raw);
    return (parsed.plugins || []).filter(plugin => plugin.status === 'loaded').map(plugin => plugin.id);
  } catch {
    return [];
  }
}

function render({ policy, currentConfig, pluginIds = [] }) {
  const configuredAccounts = Object.keys(currentConfig.channels?.slack?.accounts || {});
  const policyNames = new Set(Object.values(policy.channels || {}).map(channel => channel.name));
  const scoredAccounts = configuredAccounts.map(id => {
    const keys = Object.keys(currentConfig.channels?.slack?.accounts?.[id]?.channels || {});
    const score = keys.filter(key => policyNames.has(key.replace(/^#/, ''))).length;
    return { id, score };
  }).sort((left, right) => right.score - left.score);
  const inferredAccount = scoredAccounts[0]?.score > (scoredAccounts[1]?.score || 0)
    ? scoredAccounts[0].id
    : '';
  const accountId = process.env.OPENCLAW_SLACK_ACCOUNT
    || (configuredAccounts.length === 1 ? configuredAccounts[0] : inferredAccount);
  if (!accountId) {
    throw new Error('OPENCLAW_SLACK_ACCOUNT is required when the OpenClaw config has zero or multiple Slack accounts');
  }
  const channels = {};
  const liveWorkflows = new Set(Array.isArray(policy.live_workflows) ? policy.live_workflows : []);
  for (const [channelId, channel] of Object.entries(policy.channels || {})) {
    const receipt = channel.capabilities.includes('accounting.read_scoped');
    const ownerExpense = channel.capabilities.includes('qbo.owner_expense.write');
    const hasCapabilities = channel.capabilities.length > 0;
    const prompt = PROMPTS[channel.name]
      || (ownerExpense ? ownerExpensePrompt(channel.name)
        : receipt ? receiptPrompt(channel.name)
        : hasCapabilities ? 'Use resort_workflow for durable, channel-authorized resort operations.'
          : noAuthorityPrompt(channel.name));
    const namedMutations = CHANNEL_MUTATION_WORKFLOWS[channel.name] || [];
    const hasLiveMutation = namedMutations.some(workflow => liveWorkflows.has(workflow))
      || (receipt && ['receipt.ingest', 'receipt.process', 'receipt.payment_source.select', 'receipt.annotate',
        'receipt.owner_expense.ingest', 'receipt.owner_expense.process', 'receipt.owner_expense.confirm']
        .some(workflow => liveWorkflows.has(workflow)));
    const workflowOnly = policy.shadow_mode !== true || hasLiveMutation || channel.name === 'reservations';
    channels[channelId] = {
      enabled: true,
      requireMention: false,
      allowBots: false,
      ...(workflowOnly
        // The empty additive list is intentional. Production config is updated
        // with a deep merge, so this clears a stale shadow-mode alsoAllow value.
        ? { tools: { allow: hasCapabilities ? ['resort_workflow'] : [], alsoAllow: [] } }
        : policy.shadow_mode === true
        ? (hasCapabilities ? { tools: { alsoAllow: ['resort_workflow'] } } : {})
        : {}),
      systemPrompt: workflowOnly
        ? prompt
        : `${prompt} SHADOW MODE: resort_workflow mutations are disabled; its read workflows remain the required evidence for mutable facts. Provider delivery and completion claims still require a real artifact.`,
    };
  }
  const existingPaths = currentConfig.plugins?.load?.paths || [];
  const pluginPath = path.join(ROOT, 'openclaw-plugins', 'resort-workflows');
  const allow = [...new Set([
    ...(currentConfig.plugins?.allow || []),
    ...pluginIds,
    ...Object.keys(currentConfig.plugins?.entries || {}),
    'resort-workflows',
  ])].sort();
  const receiptChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.capabilities.includes('accounting.read_scoped'))
    .map(([id]) => id);
  const ownerExpenseChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.capabilities.includes('qbo.owner_expense.write'))
    .map(([id]) => id);
  const accountingChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.name === 'accounting')
    .map(([id]) => id);
  const whatsappChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.name === 'whatsapp')
    .map(([id]) => id);
  const socialChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.name === 'social-sol')
    .map(([id]) => id);
  const emailChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.capabilities.includes('email.send'))
    .map(([id]) => id);
  const ownerrezChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.capabilities.includes('ownerrez.write'))
    .map(([id]) => id);
  const reservationsChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.name === 'reservations')
    .map(([id]) => id);
  const currentWorkflowConfig = currentConfig.plugins?.entries?.['resort-workflows']?.config || {};
  const taskTrackerConfig = {};
  for (const key of ['taskTrackerAgentIds', 'taskTrackerAccountIds', 'taskTrackerChannelIds']) {
    if (Array.isArray(currentWorkflowConfig[key])) taskTrackerConfig[key] = currentWorkflowConfig[key];
  }
  for (const key of ['taskTrackerDatabasePath', 'taskTrackerConfigPath']) {
    if (typeof currentWorkflowConfig[key] === 'string' && currentWorkflowConfig[key]) {
      taskTrackerConfig[key] = currentWorkflowConfig[key];
    }
  }
  return {
    channels: {
      slack: {
        accounts: {
          [accountId]: {
            // Slack's allowlist is the stable channel-id map below. Unlike
            // several other OpenClaw channels, Slack has no groupAllowFrom
            // field: omitting per-channel `users` intentionally admits every
            // member of an admitted Slack channel.
            groupPolicy: 'allowlist',
            dangerouslyAllowNameMatching: false,
            channels,
          },
        },
      },
    },
    plugins: {
      allow,
      bundledDiscovery: 'compat',
      load: { paths: [...new Set([...existingPaths, pluginPath])] },
      entries: {
        'resort-workflows': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: {
            agentIds: ['resort'],
            crmBaseUrl: 'http://127.0.0.1:3456',
            slackAccountId: accountId,
            whatsappChannelIds,
            socialChannelIds,
            emailChannelIds,
            ownerrezChannelIds,
            reservationsChannelIds,
            receiptChannelIds,
            ownerExpenseChannelIds,
            accountingChannelIds,
            controlledChannelIds: Object.keys(policy.channels || {}),
            ...taskTrackerConfig,
            controlPlaneTokenEnv: 'RESORT_WORKFLOW_CONTROL_TOKEN',
            controlPlaneTokenFile: path.join(
              process.env.SOCIALSOL_SECRETS_DIR || path.join(ROOT, 'secrets'),
              'workflow-control.json',
            ),
            shadowMode: policy.shadow_mode === true,
            liveWorkflowNames: [...liveWorkflows],
          },
        },
      },
    },
  };
}

function main() {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  const currentConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const patch = render({ policy, currentConfig, pluginIds: loadedPluginIds() });
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (outputIndex >= 0 && !output) throw new Error('--output requires a file path');
  const rendered = `${JSON.stringify(patch, null, 2)}\n`;
  if (output) {
    const resolved = path.resolve(ROOT, output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, rendered, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${path.relative(ROOT, resolved)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

if (require.main === module) main();

module.exports = {
  CHANNEL_MUTATION_WORKFLOWS,
  CONFIG_PATH,
  POLICY_PATH,
  PROMPTS,
  loadedPluginIds,
  noAuthorityPrompt,
  receiptPrompt,
  ownerExpensePrompt,
  render,
};
