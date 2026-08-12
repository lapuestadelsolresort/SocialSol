'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');
const {
  applyHighConfidenceReconciliation,
  buildOwnerCashFlow,
  comparableName,
  formatOwnerCashFlow,
} = require('../lib/owner-cash-flow');

function setup() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY)');
  ensureSchemaBetterSqlite(db);
  return db;
}

function addOrder(db, {
  id, number, guest, start, end, property, title, amount, fee, created = '2026-07-01T00:00:00Z',
}) {
  const raw = {
    id, orderNumber: number, createdOn: created, modifiedOn: created,
    lineItems: [{ id: `${id}-line`, productName: title }],
  };
  db.prepare(`INSERT INTO squarespace_orders (
    order_id, order_number, customer_name, created_on, modified_on, payment_state,
    currency, grand_total_value, service_start_date, service_end_date,
    property_hint, raw_json
  ) VALUES (?, ?, ?, ?, ?, 'PAID', 'USD', ?, ?, ?, ?, ?)`).run(
    id, number, guest, created, created, String(amount), start, end, property, JSON.stringify(raw)
  );
  db.prepare(`INSERT INTO squarespace_order_items (
    order_id, line_item_id, title, department, quantity, currency,
    line_total_value, raw_json
  ) VALUES (?, ?, ?, 'direct_booking', 1, 'USD', ?, '{}')`).run(
    id, `${id}-line`, title, String(amount)
  );
  db.prepare(`INSERT INTO squarespace_transaction_documents (
    document_id, order_id, modified_on, currency, raw_json
  ) VALUES (?, ?, ?, 'USD', '{}')`).run(`${id}-doc`, id, created);
  db.prepare(`INSERT INTO squarespace_payments (
    payment_id, document_id, order_id, paid_on, currency, amount_value,
    net_amount_value, raw_json
  ) VALUES (?, ?, ?, ?, 'USD', ?, ?, '{}')`).run(
    `${id}-payment`, `${id}-doc`, id, created, String(amount), String(amount - fee)
  );
  db.prepare(`INSERT INTO squarespace_processing_fees (
    fee_id, payment_id, order_id, currency, amount_value, raw_json
  ) VALUES (?, ?, ?, 'USD', ?, '{}')`).run(`${id}-fee`, `${id}-payment`, id, String(fee));
  db.prepare(`INSERT INTO squarespace_order_ownerrez_links (order_id, status)
    VALUES (?, 'unmatched')`).run(id);
}

test('builds an owner outlook without treating booked value as bank cash', () => {
  const db = setup();
  try {
    addOrder(db, {
      id: 'direct-deposit', number: '1', guest: 'Direct Guest',
      start: '2026-09-01', end: '2026-09-04', property: 'Puesta del Sol Resort',
      title: '50% Deposit to Book Puesta del Sol Resort September 1st-4th 2026',
      amount: 500, fee: 15,
    });
    addOrder(db, {
      id: 'direct-final', number: '2', guest: 'Direct Guest',
      start: '2026-09-01', end: '2026-09-04', property: 'Puesta del Sol Resort',
      title: 'Remaining final 50% payment for Puesta del Sol Resort September 1st-4th 2026',
      amount: 500, fee: 15,
    });
    addOrder(db, {
      id: 'balance-deposit', number: '3', guest: 'Balance Guest',
      start: '2026-10-01', end: '2026-10-04', property: 'Villa Crab',
      title: '50% Deposit to reserve Villa Crab October 1st-4th 2026',
      amount: 400, fee: 12,
    });

    const ownerrezBookings = [
      { id: 10, type: 'block', is_block: true, status: 'active', title: 'Direct Guest wedding',
        arrival: '2026-09-01', departure: '2026-09-04', property: { name: 'Puesta del Sol Resort' } },
      { id: 20, type: 'booking', status: 'active', guest_id: 200, listing_site: 'Airbnb',
        arrival: '2026-11-01', departure: '2026-11-04', property: { name: 'Puesta del Sol Resort' },
        currency_code: 'USD', total_amount: 1000, total_host_fees: 150, total_paid: 1000 },
      { id: 30, type: 'booking', status: 'active', guest_id: 300,
        arrival: '2027-01-01', departure: '2027-01-04', property: { name: 'Casa Mirador' } },
      { id: 40, type: 'block', is_block: true, status: 'active', title: 'Unpriced retreat',
        arrival: '2027-02-01', departure: '2027-02-04', property: { name: 'Puesta del Sol Resort' } },
    ];
    const report = buildOwnerCashFlow(db, {
      ownerrezBookings,
      guestNames: { 200: 'Platform Guest', 300: 'Unpriced Guest' },
      asOf: '2026-08-10',
      generatedAt: '2026-08-10T12:00:00Z',
    });

    assert.equal(report.direct.totals.commitment_count, 2);
    assert.equal(report.direct.totals.expected_gross, 1800);
    assert.equal(report.direct.totals.collected_gross, 1400);
    assert.equal(report.direct.totals.actual_processing_fees, 42);
    assert.equal(report.direct.totals.inferred_balance_gross, 400);
    assert.equal(report.direct.totals.estimated_future_net, 388);
    assert.equal(report.direct.totals.reconciled, 1);
    assert.equal(report.direct.totals.missing, 1);
    assert.equal(report.platform.totals.anticipated_net_payout, 850);
    assert.equal(report.combined.priced_future_stay_value, 2800);
    assert.equal(report.combined.estimated_future_receipts_net, 1238);
    assert.equal(report.combined.estimated_eventual_net_value, 2596);
    assert.deepEqual(report.timing.platform_by_stay_month, [{
      stay_month: '2026-11', anticipated_net_payout: 850,
      timing_basis: 'stay_month_proxy_not_payout_date',
    }]);
    assert.equal(report.unresolved.active_unpriced_bookings[0].guest, 'Unpriced Guest');
    assert.equal(report.unresolved.unpriced_or_unreconciled_blocks[0].title, 'Unpriced retreat');

    const text = formatOwnerCashFlow(report);
    assert.match(text, /not the current bank balance/i);
    assert.match(text, /direct balances are inferred/i);
    assert.match(text, /Kapital not verified/);
    assert.match(text, /Blocks are not automatically confirmed bookings or revenue/);

    assert.deepEqual(applyHighConfidenceReconciliation(db, report), {
      matched_orders: 2, review_orders: 0,
    });
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM squarespace_order_ownerrez_links
      WHERE status='matched' AND ownerrez_booking_id=10`).get().n, 2);
  } finally {
    db.close();
  }
});

test('name comparison accepts safe first-name variants but rejects generic calendar blocks', () => {
  assert.equal(comparableName('Alexander Falcon', 'Dominique and Alex wedding'), true);
  assert.equal(comparableName('Leeann Tesorieri', 'Airbnb (Not available)'), false);
});
