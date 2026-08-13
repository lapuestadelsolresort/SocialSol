'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { accountingWorkflowsLive, archiveProcessedFile, main } = require('../scripts/accounting-inbox');
const { buildQboNotificationMessage, qboWrite } = require('../workflows/operational-jobs');
const { stageSlackAccountingStatement } = require('../lib/accounting-slack-inbox');

test('accounting inbox honors narrow live workflows while global shadow remains enabled', () => {
  assert.equal(accountingWorkflowsLive({
    shadow_mode: true,
    live_workflows: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
  }), true);
  assert.equal(accountingWorkflowsLive({
    shadow_mode: true,
    live_workflows: ['accounting.classify', 'qbo.write'],
  }), false);
  assert.equal(accountingWorkflowsLive({ shadow_mode: false, live_workflows: [] }), true);
});

test('successful accounting statements are moved out of the watched inbox without overwrite', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-inbox-test-'));
  const inbox = path.join(directory, 'inbox');
  const processed = path.join(inbox, 'processed');
  fs.mkdirSync(inbox);
  try {
    const first = path.join(inbox, 'statement.csv');
    fs.writeFileSync(first, 'first');
    const firstDestination = archiveProcessedFile(first, 'a'.repeat(64), processed);
    assert.equal(path.basename(firstDestination), 'statement.csv');
    assert.equal(fs.existsSync(first), false);

    const second = path.join(inbox, 'statement.csv');
    fs.writeFileSync(second, 'second');
    const secondDestination = archiveProcessedFile(second, 'b'.repeat(64), processed);
    assert.equal(path.basename(secondDestination), `statement.${'b'.repeat(12)}.csv`);
    assert.equal(fs.readFileSync(firstDestination, 'utf8'), 'first');
    assert.equal(fs.readFileSync(secondDestination, 'utf8'), 'second');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accounting inbox reconciles receipt references before attempting the QBO write', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-inbox-order-'));
  const inbox = path.join(directory, 'inbox');
  const processed = path.join(inbox, 'processed');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'statement.csv'), 'statement');
  const calls = [];
  try {
    const result = await main(undefined, {
      inboxDirectory: inbox,
      processedDirectory: processed,
      policy: {
        shadow_mode: true,
        live_workflows: ['accounting.classify', 'receipt.reconcile', 'qbo.write'],
      },
      executeWorkflow: async (workflow, input, idempotencyKey) => {
        calls.push({ workflow, input, idempotencyKey });
        return { id: `run-${workflow}` };
      },
    });
    assert.deepEqual(calls.map(call => call.workflow), [
      'accounting.classify', 'receipt.reconcile', 'qbo.write',
    ]);
    assert.equal(result, undefined);
    assert.equal(fs.existsSync(path.join(processed, 'statement.csv')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Slack accounting intake stages each CSV once with a stable inbox name', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-slack-intake-'));
  const downloaded = path.join(directory, 'downloaded.csv');
  const inbox = path.join(directory, 'inbox');
  fs.writeFileSync(downloaded, 'date,amount\n2026-08-13,2105\n');
  const fetchSource = async () => ({
    files: [{
      id: 'F-STATEMENT', name: 'ECta826 (1).csv', mimetype: 'text/csv',
      localPath: downloaded,
    }],
  });
  try {
    const first = await stageSlackAccountingStatement({
      channelId: 'C-ACCOUNTING', messageId: '1786640000.25',
    }, { inboxDirectory: inbox, fetchSource });
    const second = await stageSlackAccountingStatement({
      channelId: 'C-ACCOUNTING', messageId: '1786640000.25',
    }, { inboxDirectory: inbox, fetchSource });
    assert.equal(first.files.length, 1);
    assert.equal(first.files[0].staged, true);
    assert.equal(second.files[0].staged, false);
    assert.equal(first.files[0].name, 'slack-1786640000.25-F-STATEMENT-ECta826_1.csv');
    assert.equal(fs.readFileSync(first.files[0].path, 'utf8'), 'date,amount\n2026-08-13,2105\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('QBO completion notification exposes every held accounting exception', () => {
  const message = buildQboNotificationMessage({
    run: { id: 'workflow-1' },
    state: {
      verify_readback: {
        summary: {
          principalWritten: 5,
          feeRecordsWritten: 10,
          dedupSkipped: 6,
          reviewRequired: 2,
          reviewDetails: [
            {
              date: '2026-08-06', currency: 'MXN', amount: 2105,
              reason: 'duplicate reimbursement requires review',
            },
            {
              date: '2026-08-10', currency: 'MXN', amount: 2499,
              reason: 'manual classification required',
            },
          ],
        },
      },
    },
  });
  assert.match(message, /Grouped statement transactions evaluated: 13/);
  assert.match(message, /Principal transactions written in this run: 5/);
  assert.match(message, /SPEI fee records written: 10/);
  assert.match(message, /Existing transactions skipped in this run: 6/);
  assert.match(message, /Held for review: 2/);
  assert.match(message, /2026-08-06 MXN 2,105\.00/);
  assert.match(message, /2026-08-10 MXN 2,499\.00/);
});

test('QBO completion notification does not mention global write reviewers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-notification-policy-'));
  const policyPath = path.join(directory, 'policy.json');
  const previous = process.env.RESORT_WORKFLOW_POLICY_PATH;
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    channels: { 'C-ACCOUNTING': { name: 'accounting', capabilities: ['qbo.write'] } },
    write_notifications: { user_ids: ['U-SARAH'], channel_ids: [] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  const queued = [];
  try {
    const notify = qboWrite.steps.find(step => step.key === 'notify_humans');
    await notify.run({
      db: {},
      run: { id: 'workflow-no-mentions', channel_id: null },
      state: { verify_readback: { summary: {} } },
      store: { enqueueOutbox: async (_db, entry) => queued.push(entry) },
    });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].payload.channelId, 'C-ACCOUNTING');
    assert.doesNotMatch(queued[0].payload.message, /U-SARAH|<@/);
  } finally {
    if (previous === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
