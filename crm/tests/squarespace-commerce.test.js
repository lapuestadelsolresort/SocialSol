'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');
const {
  classifyLineItem,
  extractBookingFields,
  extractTitleDates,
  upsertCustomer,
  upsertOrder,
  upsertTransactionDocument,
} = require('../lib/squarespace-commerce');
const { normalizeEventType } = require('../routes/ownerrez');
const { buildAudienceReport } = require('../scripts/squarespace-report');
const { run: runSquarespaceSync } = require('../scripts/squarespace-sync');

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    first_name TEXT, last_name TEXT, name TEXT NOT NULL,
    email TEXT, email_status TEXT, dedup_key TEXT UNIQUE NOT NULL,
    source TEXT, context_source TEXT NOT NULL, status TEXT,
    notes TEXT, phone TEXT, address TEXT, relationship_type TEXT,
    contact_provenance TEXT, addressable INTEGER DEFAULT 0,
    listing_channel TEXT, last_stay_date TEXT,
    ownerrez_booking_id INTEGER, do_not_contact INTEGER DEFAULT 0
  )`);
  ensureSchemaBetterSqlite(db);
  return db;
}

const customer = {
  id: 'customer-1',
  firstName: 'Direct',
  lastName: 'Guest',
  locale: 'en-US',
  primaryEmail: {
    email: 'direct.guest@example.com',
    acceptsMarketing: { acceptsMarketing: true, joinedOn: '2026-01-01T00:00:00Z' },
  },
  defaultShippingAddress: {
    address: { phoneNumber: '+1 202 555 0101', city: 'Oakland', countryCode: 'US' },
  },
};

const order = {
  id: 'order-1',
  orderNumber: '101',
  customerId: customer.id,
  customerEmail: customer.primaryEmail.email,
  channel: 'web',
  createdOn: '2026-08-01T12:00:00Z',
  modifiedOn: '2026-08-01T12:05:00Z',
  paymentState: 'PAID',
  fulfillmentStatus: 'PENDING',
  subtotal: { value: '5100.00', currency: 'USD' },
  grandTotal: { value: '5100.00', currency: 'USD' },
  billingAddress: { firstName: 'Direct', lastName: 'Guest', phone: '+1 202 555 0101' },
  formSubmission: [
    { label: 'Check-in', value: '2026-09-10' },
    { label: 'Check-out', value: '2026-09-14' },
    { label: 'Number of guests', value: '12 guests' },
  ],
  lineItems: [
    { id: 'line-room', title: 'Full Resort Direct Booking', quantity: 1,
      unitPricePaid: { value: '5000.00', currency: 'USD' } },
    { id: 'line-clean', productName: 'Additional Housekeeping Service', quantity: 1,
      unitPricePaid: { value: '100.00', currency: 'USD' } },
  ],
};

test('classifies operational line items and extracts booking fields', () => {
  assert.equal(classifyLineItem(order.lineItems[1]), 'housekeeping');
  assert.equal(classifyLineItem(order.lineItems[0]), 'direct_booking');
  assert.deepEqual(extractBookingFields(order), {
    startDate: '2026-09-10', endDate: '2026-09-14', guestCount: 12, propertyHint: null,
  });
});

test('extracts booking date ranges embedded in Squarespace product names', () => {
  const titleOrder = productName => ({ lineItems: [{ productName }] });
  assert.deepEqual(extractTitleDates(titleOrder('Deposit from 12.21.26 to 1.3.27')), {
    startDate: '2026-12-21', endDate: '2027-01-03',
  });
  assert.deepEqual(extractTitleDates(titleOrder('Final payment September 3rd-7th 2026')), {
    startDate: '2026-09-03', endDate: '2026-09-07',
  });
  assert.deepEqual(extractTitleDates(titleOrder('Stay July 31-August 3rd 2025')), {
    startDate: '2025-07-31', endDate: '2025-08-03',
  });
  assert.deepEqual(extractTitleDates(titleOrder('March 11th 2027 to March 16th 2027')), {
    startDate: '2027-03-11', endDate: '2027-03-16',
  });
});

test('upserts direct commerce into CRM and links the existing OwnerRez guest', () => {
  const db = setup();
  try {
    db.prepare(`INSERT INTO contacts
      (name, email, dedup_key, source, context_source, status, ownerrez_booking_id)
      VALUES (?, ?, ?, 'ownerrez_my_website', 'ownerrez_sync', 'booked', ?)`)
      .run('Direct Guest', 'direct.guest@example.com', 'direct.guest@example.com', 4242);

    const crmContact = upsertCustomer(db, customer, {
      transactionsSummary: {
        orderCount: 1,
        totalOrderAmount: { value: '5100.00', currency: 'USD' },
        totalRefundAmount: { value: '0.00', currency: 'USD' },
      },
    });
    assert.equal(crmContact.ownerrez_booking_id, 4242);

    const first = upsertOrder(db, order, { customer });
    assert.equal(first.link.status, 'candidate');
    assert.deepEqual(new Set(first.departments), new Set(['direct_booking', 'housekeeping']));
    assert.equal(db.prepare('SELECT booking_source FROM squarespace_orders').get().booking_source, 'direct');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 1);
    assert.equal(db.prepare("SELECT department FROM squarespace_order_items WHERE line_item_id='line-clean'").get().department, 'housekeeping');
    assert.equal(db.prepare("SELECT title FROM squarespace_order_items WHERE line_item_id='line-clean'").get().title, 'Additional Housekeeping Service');
    assert.equal(db.prepare("SELECT line_total_value FROM squarespace_order_items WHERE line_item_id='line-clean'").get().line_total_value, '100');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_notification_outbox').get().n, 4);

    const validated = upsertOrder(db, order, {
      customer,
      ownerrezBooking: { id: 4242, arrival: '2026-09-10', departure: '2026-09-14' },
    });
    assert.equal(validated.link.status, 'matched');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_notification_outbox').get().n, 4);
    assert.equal(db.prepare('SELECT accepts_marketing FROM squarespace_customers').get().accepts_marketing, 1);
    const reservations = buildAudienceReport(db, 'reservations');
    assert.match(reservations.message, /OwnerRez 4242 \(matched\)/);
    const housekeeping = buildAudienceReport(db, 'housekeeping');
    assert.match(housekeeping.message, /USD 100\.00 housekeeping/);
  } finally {
    db.close();
  }
});

test('replaces transaction children idempotently and retains fees/refunds', () => {
  const db = setup();
  try {
    const document = {
      id: 'doc-1', salesOrderId: 'order-1', customerEmail: customer.primaryEmail.email,
      createdOn: '2026-08-01T12:05:00Z', modifiedOn: '2026-08-02T12:05:00Z',
      total: { value: '5100.00', currency: 'USD' },
      totalNetPayment: { value: '4947.00', currency: 'USD' },
      payments: [{
        id: 'payment-1', provider: 'SQUARESPACE', paidOn: '2026-08-01T12:05:00Z',
        amount: { value: '5100.00', currency: 'USD' },
        netAmount: { value: '4947.00', currency: 'USD' },
        refundedAmount: { value: '100.00', currency: 'USD' },
        processingFees: [{ id: 'fee-1', amount: { value: '153.00', currency: 'USD' } }],
        refunds: [{ id: 'refund-1', refundedOn: '2026-08-02T12:00:00Z', amount: { value: '100.00', currency: 'USD' } }],
      }],
    };
    upsertTransactionDocument(db, document);
    upsertTransactionDocument(db, document);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_payments').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_processing_fees').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_refunds').get().n, 1);
  } finally {
    db.close();
  }
});

test('normalizes the actual OwnerRez webhook envelope', () => {
  assert.equal(normalizeEventType({ entity_type: 'Booking', action: 'Update' }), 'booking_update');
  assert.equal(normalizeEventType({ event_type: 'booking_created' }), 'booking_created');
  assert.equal(normalizeEventType({ action: 'update' }), 'unknown');
});

test('sync dry-run fetches every payment state without changing the CRM', async () => {
  const db = new Database(':memory:');
  const orderParams = [];
  const client = {
    listContacts: async () => [{ id: 'customer-1' }],
    listOrders: async params => { orderParams.push(params); return [order]; },
    listTransactions: async () => [],
    getTransactionSummaries: async () => [],
  };
  try {
    const result = await runSquarespaceSync(['--full', '--dry-run'], {
      db,
      client,
      squarespaceSecrets: { api_key: 'test-only' },
      config: {
        sync: {
          initial_backfill_since: '2020-01-01T00:00:00.000Z',
          payment_states: ['PAID', 'PARTIALLY_PAID', 'REFUNDED'],
        },
      },
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.orders_seen, 1);
    assert.deepEqual(orderParams.map(params => params.paymentStates), ['PAID', 'PARTIALLY_PAID', 'REFUNDED']);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'squarespace_%'").get().n, 0);
  } finally {
    db.close();
  }
});

test('full backfill can populate orders without enqueuing historical Slack notifications', () => {
  const db = setup();
  try {
    upsertCustomer(db, customer);
    upsertOrder(db, order, { customer, notify: false });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_orders').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM squarespace_notification_outbox').get().n, 0);
  } finally {
    db.close();
  }
});

test('an OwnerRez contact without Squarespace date evidence remains review-only', () => {
  const db = setup();
  try {
    db.prepare(`INSERT INTO contacts
      (name, email, dedup_key, source, context_source, status, ownerrez_booking_id)
      VALUES (?, ?, ?, 'ownerrez_my_website', 'ownerrez_sync', 'booked', ?)`)
      .run('Direct Guest', customer.primaryEmail.email, customer.primaryEmail.email, 4242);
    upsertCustomer(db, customer);
    const noDates = {
      ...order,
      id: 'order-no-dates',
      formSubmission: [],
      lineItems: [{ id: 'massage', productName: 'Deep Tissue Massage', quantity: 1,
        unitPricePaid: { value: '80.00', currency: 'USD' } }],
    };
    const result = upsertOrder(db, noDates, {
      customer,
      ownerrezBooking: { id: 4242, arrival: '2026-09-10', departure: '2026-09-14' },
    });
    assert.equal(result.link.status, 'review');
    assert.equal(result.link.method, 'contact_without_dates');
  } finally {
    db.close();
  }
});
