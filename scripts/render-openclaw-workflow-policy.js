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
  whatsapp: 'This channel is the human WhatsApp console. Use only resort_workflow for messages and status. Never infer sent, delivered, read, or viewed; report the exact persisted Twilio state. A guest-facing send requires the explicit !wa command.',
  'social-sol': 'This channel owns paid Meta, campaign-linked landing variants, social content, and Meta DMs. Use marketing.snapshot.read before performance decisions. Reads and proposals may be autonomous. meta.campaign.autonomous may only execute the exact pause or budget decrease authorized by fresh healthy snapshot evidence, with one autonomous mutation per campaign per 24 hours. New campaigns, activation, budget increases, and landing changes require marketing.change.propose followed by the exact !meta confirm command. Never bypass resort_workflow or claim a mutation without workflow, effect, and readback evidence.',
  'prospector-paulina': 'This channel owns Paulina outreach and its email conversation ledger. In the original recorded outreach thread, !email reply creates an immutable proposal and only the exact emitted !email confirm command in that same thread sends through Gmail. Plain Slack replies and top-level email commands never send email. Use resort_workflow for performance and report provider/readback evidence exactly.',
  'sarah-email': 'This channel is the complete inbound console for Sarah Gmail and OwnerRez channel messages. Every message is projected from the durable conversation ledger. In the original message thread, !email reply creates an immutable proposal; only the exact emitted !email confirm command from the same user in that same thread sends through the recorded provider. Plain Slack replies and top-level email commands never send. Report provider acceptance and readback evidence exactly.',
  'reengager-regina': 'This channel owns Regina reengagement. Use resort_workflow for campaign runs and CRM facts. Do not send through ad-hoc shell or email tools.',
  'sarah-coach': 'This channel drafts guest replies but does not send them. Use guest.reply.draft through resort_workflow and label the result as a draft.',
  'business-intel': 'This is the cross-domain read surface. Use source-specific resort_workflow reads for mutable facts. OwnerRez controls occupancy, Squarespace direct charges, QBO/Kapital cash, CRM leads, and Twilio WhatsApp state. Say not queried when an authority was not queried; never fill a source gap from memory.',
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
  return `This is the scoped ${name} receipt channel. Channel members may submit or amend this channel's receipts and read only this channel's receipt ledger through resort_workflow. When one Slack post contains multiple receipt or invoice files, inspect every attachment and pass one receipt.annotate item per source document; the item amounts must sum to the parent reimbursement amount. receipt.annotate creates the stable Kapital reference and queues the itemized confirmation/payment instruction in the original thread. Set reimbursementRecipientUserId only when the reimbursement recipient is not the Slack submitter. Never invent or manually format a payment reference. Cross-channel accounting data is not available here.`;
}

function ownerExpensePrompt(name) {
  return `This is the scoped ${name} owner-ledger channel. The normal case is an owner-paid business expense that increases the configured liability. Rare business-paid reimbursements or payments on the owner's behalf reduce that liability and always require the exact !receipt confirm repayment command emitted in-thread. Uploads are captured automatically and posted only through the fixed workflow after extraction or explicit confirmation. Do not invoke a generic QBO write or infer that an entry posted without a workflow and QBO readback id.`;
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
      || (receipt && ['receipt.ingest', 'receipt.annotate',
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
        : 'SHADOW MODE: keep the existing production path active. resort_workflow mutations are disabled; use its reads only as comparison evidence. Provider delivery and completion claims still require a real artifact.',
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
