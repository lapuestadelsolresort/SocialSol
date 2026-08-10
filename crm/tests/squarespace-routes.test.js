'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/squarespace-schema');
const { buildRouter } = require('../routes/squarespace');

async function request(app, endpoint, options = {}) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('protected read model routes expose normalized direct-commerce totals and receipt links', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'squarespace-routes-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT)`);
    await ensureSchemaAsync(db, sql);
    await db.query(sql`INSERT INTO squarespace_orders (
        order_id, order_number, customer_name, created_on, modified_on,
        payment_state, currency, grand_total_value, raw_json
      ) VALUES ('order-1', '101', 'Direct Guest', '2026-08-10T18:00:00Z',
        '2026-08-10T18:05:00Z', 'PAID', 'USD', '1000.00', '{}')`);
    await db.query(sql`INSERT INTO squarespace_order_ownerrez_links
        (order_id, ownerrez_booking_id, status, match_method, confidence)
      VALUES ('order-1', 4242, 'matched', 'contact_and_dates', 0.99)`);
    await db.query(sql`INSERT INTO squarespace_order_items
        (order_id, line_item_id, title, department, quantity, currency,
         unit_price_value, line_total_value, raw_json)
      VALUES ('order-1', 'clean-1', 'Housekeeping', 'housekeeping', 1,
        'USD', '100.00', '100.00', '{}')`);
    await db.query(sql`INSERT INTO squarespace_transaction_documents
        (document_id, order_id, modified_on, currency, raw_json)
      VALUES ('document-1', 'order-1', '2026-08-10T18:05:00Z', 'USD', '{}')`);
    await db.query(sql`INSERT INTO squarespace_payments
        (payment_id, document_id, order_id, paid_on, currency, amount_value,
         net_amount_value, raw_json)
      VALUES ('payment-1', 'document-1', 'order-1', '2026-08-10T18:05:00Z',
        'USD', '1000.00', '972.00', '{}')`);
    await db.query(sql`INSERT INTO squarespace_processing_fees
        (fee_id, payment_id, order_id, currency, amount_value,
         refunded_amount_value, raw_json)
      VALUES ('fee-1', 'payment-1', 'order-1', 'USD', '30.00', '2.00', '{}')`);
    await db.query(sql`INSERT INTO squarespace_refunds
        (refund_id, payment_id, order_id, refunded_on, currency, amount_value, raw_json)
      VALUES ('refund-1', 'payment-1', 'order-1', '2026-08-10T19:00:00Z',
        'USD', '100.00', '{}')`);

    const app = express();
    app.use(express.json());
    app.use('/api/squarespace', buildRouter(() => db));

    const summary = await request(app, '/api/squarespace/summary?start=2026-08-10&end=2026-08-11');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.booking_channel, 'direct');
    assert.equal(summary.body.order_count, 1);
    assert.equal(summary.body.housekeeping_orders, 1);
    assert.equal(summary.body.net_after_fees_and_refunds, 872);

    const detail = await request(app, '/api/squarespace/orders/order-1');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.order.ownerrez_booking_id, 4242);
    assert.equal(detail.body.items[0].department, 'housekeeping');
    assert.equal(Object.hasOwn(detail.body.order, 'raw_json'), false);

    const linked = await request(app, '/api/squarespace/expense-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        squarespace_order_id: 'order-1',
        squarespace_line_item_id: 'clean-1',
        slack_channel_id: 'test-channel',
        slack_message_ts: '123.456',
        allocated_value: '100.00',
        currency: 'USD',
      }),
    });
    assert.equal(linked.status, 201);
    const expenseLinks = await request(app, '/api/squarespace/expense-links?order_id=order-1');
    assert.equal(expenseLinks.body.links.length, 1);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
