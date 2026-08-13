#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const { OPENCLAW_BIN, ROOT } = require('../lib/runtime-paths');
const { configure } = require('./configure-sarah-email');
const {
  installLaunchAgent, retireLaunchAgent, run,
} = require('./cutover-social-autonomy');

const GMAIL_LAUNCHAGENT = 'com.lapuestadelsolresort.gmail-reply-forwarder.plist';
const RETIRED_LAUNCHAGENT = 'com.lapuestadelsolresort.inbound-email-scanner.plist';

function slackProbe(command = run) {
  const result = command(OPENCLAW_BIN, [
    'channels', 'status', '--channel', 'slack', '--probe', '--json', '--timeout', '15000',
  ]);
  const payload = JSON.parse(String(result.stdout || '{}'));
  const accounts = payload.channelAccounts?.slack || [];
  const resort = accounts.find(account => account.accountId === process.env.OPENCLAW_SLACK_ACCOUNT)
    || accounts.find(account => account.name === 'Instagram Drafts Workspace');
  if (!resort?.running || !resort?.connected || !resort?.probe?.ok) {
    throw new Error('resort Slack Socket Mode account is not connected and healthy');
  }
  return { accountId: resort.accountId, connected: true, probeOk: true };
}

async function main(args = process.argv.slice(2), deps = {}) {
  if (!args.includes('--confirm-production')) {
    throw new Error('refusing Sarah email cutover without --confirm-production');
  }
  const channelIndex = args.indexOf('--channel-id');
  const channelId = channelIndex >= 0 ? args[channelIndex + 1] : process.env.SARAH_EMAIL_SLACK_CHANNEL;
  if (!channelId) throw new Error('--channel-id or SARAH_EMAIL_SLACK_CHANNEL is required');
  const command = deps.run || run;
  const configurePolicy = deps.configure || configure;
  const install = deps.installLaunchAgent || installLaunchAgent;
  const retire = deps.retireLaunchAgent || retireLaunchAgent;
  const probe = deps.slackProbe || slackProbe;

  // Both provider reads must succeed before policy, Slack, or LaunchAgent state changes.
  command(process.execPath, ['crm/scripts/verify-gmail-send-scope.js']);
  command(process.execPath, ['crm/scripts/verify-ownerrez-messaging-scope.js']);
  const socketBefore = probe(command);

  command('/bin/bash', ['crm/migrations/020_sarah_email_console.sh']);
  const configured = configurePolicy(['--channel-id', channelId, '--confirm-production']);
  command(process.execPath, ['scripts/render-launchagents.js']);
  const patchPath = path.join(ROOT, 'workflow', 'openclaw-policy.patch.json');
  command(process.execPath, ['scripts/render-openclaw-workflow-policy.js', '--output', patchPath]);
  command(process.execPath, ['scripts/apply-openclaw-shadow.js', '--confirm-shadow']);

  const domain = `gui/${process.getuid()}`;
  const backupDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents', 'socialsol-backups');
  const installed = install(GMAIL_LAUNCHAGENT, domain, backupDirectory);
  const retired = retire(RETIRED_LAUNCHAGENT, domain, backupDirectory);
  command('/bin/launchctl', ['kickstart', '-k', `${domain}/ai.openclaw.gateway`]);
  command('/bin/launchctl', ['kickstart', '-k', `${domain}/com.lapuestadelsolresort.workflow-worker`]);
  command('/bin/launchctl', ['kickstart', '-k', `${domain}/com.lapuestadelsolresort.gmail-reply-forwarder`]);
  const socketAfter = probe(command);

  const welcome = command(OPENCLAW_BIN, [
    'message', 'send', '--channel', 'slack', '--account', socketAfter.accountId,
    '--target', `channel:${channelId}`, '--json', '--message',
    '✅ *Sarah email console is live*\nNew Gmail messages and OwnerRez Airbnb/Vrbo messages are written to the durable CRM conversation ledger and projected here. Reply inside a message thread with `!email reply <message>`, then paste the exact emitted `!email confirm …` command in the same thread. Plain Slack replies never send.',
  ]);
  const welcomePayload = JSON.parse(String(welcome.stdout || '{}'));
  const welcomeTs = welcomePayload.payload?.result?.messageId || null;
  if (!welcomeTs) throw new Error('Sarah email Slack welcome post was not acknowledged');

  return {
    ok: true, configured, installed, retired,
    gmailScopeVerified: true, ownerRezMessagingVerified: true,
    socketBefore, socketAfter, welcomeTs,
    gatewayRestarted: true, workerRestarted: true, forwarderStarted: true,
  };
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`[cutover-sarah-email] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  GMAIL_LAUNCHAGENT,
  RETIRED_LAUNCHAGENT,
  main,
  slackProbe,
};
