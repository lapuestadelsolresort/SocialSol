'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { accountingWorkflowsLive, archiveProcessedFile, main } = require('../scripts/accounting-inbox');
const { buildQboNotificationMessage } = require('../workflows/operational-jobs');

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
  assert.match(message, /Principal transactions written: 5/);
  assert.match(message, /SPEI fee records written: 10/);
  assert.match(message, /Existing transactions skipped: 6/);
  assert.match(message, /Held for review: 2/);
  assert.match(message, /2026-08-06 MXN 2,105\.00/);
  assert.match(message, /2026-08-10 MXN 2,499\.00/);
});
