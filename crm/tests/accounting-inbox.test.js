'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { accountingWorkflowsLive, archiveProcessedFile } = require('../scripts/accounting-inbox');

test('accounting inbox honors narrow live workflows while global shadow remains enabled', () => {
  assert.equal(accountingWorkflowsLive({
    shadow_mode: true,
    live_workflows: ['accounting.classify', 'qbo.write'],
  }), true);
  assert.equal(accountingWorkflowsLive({
    shadow_mode: true,
    live_workflows: ['accounting.classify'],
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
