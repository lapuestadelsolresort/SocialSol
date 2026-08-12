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
  'social-sol': 'This channel owns social content and marketing read models. Use resort_workflow for content records, publishing, CRM pipeline facts, and source-backed status. Never claim a post is published when only a Postiz schedule or publish request is verified.',
  'prospector-paulina': 'This channel owns Paulina outreach. Use resort_workflow for performance and sends. Receiving-server delivery is not inbox placement; report recorded counts and their evidence timestamp.',
  'reengager-regina': 'This channel owns Regina reengagement. Use resort_workflow for campaign runs and CRM facts. Do not send through ad-hoc shell or email tools.',
  'sarah-coach': 'This channel drafts guest replies but does not send them. Use guest.reply.draft through resort_workflow and label the result as a draft.',
  'business-intel': 'This is the cross-domain read surface. Use source-specific resort_workflow reads for mutable facts. OwnerRez controls occupancy, Squarespace direct charges, QBO/Kapital cash, CRM leads, and Twilio WhatsApp state. Say not queried when an authority was not queried; never fill a source gap from memory.',
  accounting: 'This channel owns accounting records, receipts, Squarespace financial reads, and QBO. Use resort_workflow only. A QBO write is complete only after provider readback and must be reported with its workflow/evidence id.',
  reservations: 'This channel reads OwnerRez for occupancy and reservations. OwnerRez writes are restricted by trusted Slack user id in the control-plane policy. Never use CRM contact rows as availability.',
};

function receiptPrompt(name) {
  return `This is the scoped ${name} receipt channel. Channel members may submit or amend this channel's receipts and read only this channel's receipt ledger through resort_workflow. Cross-channel accounting data is not available here.`;
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
    const hasCapabilities = channel.capabilities.length > 0;
    const prompt = PROMPTS[channel.name]
      || (receipt ? receiptPrompt(channel.name)
        : hasCapabilities ? 'Use resort_workflow for durable, channel-authorized resort operations.'
          : noAuthorityPrompt(channel.name));
    const hasLiveMutation = (channel.name === 'whatsapp' && liveWorkflows.has('whatsapp.reply'))
      || (channel.name === 'social-sol' && liveWorkflows.has('meta.dm.reply'))
      || (channel.name === 'reservations' && liveWorkflows.has('ownerrez.mutation.confirm'))
      || (receipt && liveWorkflows.has('receipt.ingest'));
    channels[channelId] = {
      enabled: true,
      requireMention: false,
      allowBots: false,
      ...(policy.shadow_mode === true && !hasLiveMutation
        ? (hasCapabilities ? { tools: { alsoAllow: ['resort_workflow'] } } : {})
        : { tools: { allow: hasCapabilities ? ['resort_workflow'] : [] } }),
      systemPrompt: policy.shadow_mode === true && !hasLiveMutation
        ? 'SHADOW MODE: keep the existing production path active. resort_workflow mutations are disabled; use its reads only as comparison evidence. Provider delivery and completion claims still require a real artifact.'
        : prompt,
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
  const whatsappChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.name === 'whatsapp')
    .map(([id]) => id);
  const socialChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.name === 'social-sol')
    .map(([id]) => id);
  const ownerrezChannelIds = Object.entries(policy.channels || {})
    .filter(([, channel]) => channel.capabilities.includes('ownerrez.write'))
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
            ownerrezChannelIds,
            receiptChannelIds,
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

module.exports = { CONFIG_PATH, POLICY_PATH, PROMPTS, loadedPluginIds, noAuthorityPrompt, receiptPrompt, render };
