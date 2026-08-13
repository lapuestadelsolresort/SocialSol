#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { ROOT, DB_PATH } = require('../lib/runtime-paths');
const { classifyReply } = require('../crm/lib/email-conversations');
const { configure } = require('./configure-email-replies');
const { installLaunchAgent, run } = require('./cutover-social-autonomy');

const GMAIL_LAUNCHAGENT = 'com.lapuestadelsolresort.gmail-reply-forwarder.plist';

function ledgerSnapshot(databasePath = DB_PATH) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT id, direction, body_text, raw_body_text,
        sentiment, classification_source, processing_status, outreach_send_id, slack_thread_ts,
        slack_message_ts
      FROM email_threads
      WHERE provider_message_id IS NOT NULL`).all();
    const emailRuns = db.prepare(`SELECT r.status, o.status AS outbox_status
      FROM workflow_runs r
      LEFT JOIN workflow_outbox o ON o.run_id=r.id AND o.topic='slack.notification'
      WHERE r.workflow_name='email.message.observe'`).all();
    const classifiedWrong = rows.filter(row => row.direction === 'inbound'
      && row.classification_source === 'email_conversation_classifier'
      && row.sentiment && classifyReply(row.body_text || row.raw_body_text || '').quality !== row.sentiment);
    return {
      events: rows.length,
      matchedInbound: rows.filter(row => row.direction === 'inbound' && row.outreach_send_id).length,
      matchedOutbound: rows.filter(row => row.direction === 'outbound' && row.outreach_send_id).length,
      active: rows.filter(row => ['pending', 'queued'].includes(row.processing_status)).length,
      failed: rows.filter(row => row.processing_status === 'failed').length,
      unthreadedMatched: rows.filter(row => row.outreach_send_id
        && (!row.slack_thread_ts || !row.slack_message_ts)).length,
      classifierDrift: classifiedWrong.length,
      activeRuns: emailRuns.filter(row => !['completed', 'failed'].includes(row.status)).length,
      failedRuns: emailRuns.filter(row => row.status === 'failed').length,
      pendingSlack: emailRuns.filter(row => row.outbox_status && row.outbox_status !== 'completed').length,
    };
  } finally {
    db.close();
  }
}

async function waitForConversationLedger({
  databasePath = DB_PATH,
  timeoutMs = 15 * 60_000,
  pollMs = 1000,
  snapshot = ledgerSnapshot,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() <= deadline) {
    current = snapshot(databasePath);
    if (current.failed || current.failedRuns || current.classifierDrift) {
      throw new Error(`email conversation verification failed: ${JSON.stringify(current)}`);
    }
    if (!current.active && !current.activeRuns && !current.pendingSlack && !current.unthreadedMatched) {
      return current;
    }
    await sleep(pollMs);
  }
  throw new Error(`email conversation ledger did not settle: ${JSON.stringify(current || {})}`);
}

async function main(args = process.argv.slice(2), deps = {}) {
  if (!args.includes('--confirm-production')) {
    throw new Error('refusing email reply cutover without --confirm-production');
  }
  const command = deps.run || run;
  const configurePolicy = deps.configure || configure;
  const install = deps.installLaunchAgent || installLaunchAgent;
  const wait = deps.waitForConversationLedger || waitForConversationLedger;

  // This token request fails before any production state changes unless Google
  // Workspace DWD authorizes both gmail.readonly and gmail.send.
  command(process.execPath, ['crm/scripts/verify-gmail-send-scope.js']);
  command('/bin/bash', ['crm/migrations/019_email_conversation_ledger.sh']);
  const configured = configurePolicy(['--confirm-production']);
  command(process.execPath, ['scripts/render-launchagents.js']);
  const patchPath = path.join(ROOT, 'workflow', 'openclaw-policy.patch.json');
  command(process.execPath, ['scripts/render-openclaw-workflow-policy.js', '--output', patchPath]);
  command(process.execPath, ['scripts/apply-openclaw-shadow.js', '--confirm-shadow']);

  const domain = `gui/${process.getuid()}`;
  const backupDirectory = path.join(
    os.homedir(), 'Library', 'LaunchAgents', 'socialsol-backups',
  );
  const installed = install(GMAIL_LAUNCHAGENT, domain, backupDirectory);
  command('/bin/launchctl', ['kickstart', '-k', `${domain}/ai.openclaw.gateway`]);
  const reconciliationResult = command(process.execPath, [
    'crm/scripts/reconcile-email-conversations.js', '--apply', '--days', '365',
  ]);
  const reconciliation = JSON.parse(String(reconciliationResult.stdout || '{}'));
  command('/bin/launchctl', ['kickstart', '-k', `${domain}/com.lapuestadelsolresort.workflow-worker`]);
  const ledger = await wait();
  return {
    ok: true, configured, installed, reconciliation, ledger,
    gmailScopeVerified: true, gatewayRestarted: true, workerRestarted: true,
  };
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`[cutover-email-replies] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  GMAIL_LAUNCHAGENT,
  ledgerSnapshot,
  main,
  waitForConversationLedger,
};
