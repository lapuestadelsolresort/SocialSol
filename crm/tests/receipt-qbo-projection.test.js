'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { projectReceiptQboWrites } = require('../workflows/operational-jobs');

test('verified QBO receipt writes project the purchase onto receipt and reconciliation ledgers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-qbo-projection-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await ensureSchemaAsync(db, sql);
    const runId = '11111111-1111-4111-8111-111111111111';
    const receiptId = '22222222-2222-4222-8222-222222222222';
    await db.query(sql`INSERT INTO workflow_runs (
      id, workflow_name, workflow_version, idempotency_key, status,
      trigger_type, input_json, state_json
    ) VALUES (${runId}, 'qbo.write', 2, 'test:qbo-write', 'running', 'system', '{}', '{}')`);
    await db.query(sql`INSERT INTO accounting_receipts (
      id, slack_channel_id, slack_message_id, submitted_at, source_hash, status,
      transaction_date, currency, amount, payment_reference
    ) VALUES (${receiptId}, 'C-RECEIPT', '171.2', '2026-08-13T12:00:00Z', 'hash',
      'matched', '2026-08-13', 'MXN', 2105, 'LPDS-R-A1B2C3D4E5F60718')`);
    await db.query(sql`INSERT INTO accounting_reconciliations (
      id, receipt_id, bank_reference, status
    ) VALUES ('reconciliation-1', ${receiptId}, 'bank-1', 'matched')`);
    const verified = await projectReceiptQboWrites(db, runId, [{
      receipt_id: receiptId,
      qbo_id: 'QBO-42',
      request_id: 'request-42',
    }]);
    assert.equal(verified, true);
    const [receipt] = await db.query(sql`SELECT status, qbo_entity_type, qbo_entity_id,
      qbo_request_id, posted_at FROM accounting_receipts WHERE id=${receiptId}`);
    assert.equal(receipt.status, 'posted');
    assert.equal(receipt.qbo_entity_type, 'Purchase');
    assert.equal(receipt.qbo_entity_id, 'QBO-42');
    assert.equal(receipt.qbo_request_id, 'request-42');
    assert.ok(receipt.posted_at);
    const [reconciliation] = await db.query(sql`SELECT qbo_entity_type, qbo_entity_id
      FROM accounting_reconciliations WHERE receipt_id=${receiptId}`);
    assert.deepEqual(reconciliation, { qbo_entity_type: 'Purchase', qbo_entity_id: 'QBO-42' });
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
