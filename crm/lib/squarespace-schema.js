'use strict';

// Additive, idempotent schema for the Squarespace commerce read model.
// Squarespace is the payment/order source for direct bookings only. OwnerRez
// remains the booking and occupancy source for every channel.

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS squarespace_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    orders_seen INTEGER NOT NULL DEFAULT 0,
    transactions_seen INTEGER NOT NULL DEFAULT 0,
    contacts_seen INTEGER NOT NULL DEFAULT 0,
    contacts_linked INTEGER NOT NULL DEFAULT 0,
    bookings_linked INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_sync_state (
    stream TEXT PRIMARY KEY,
    last_modified_on TEXT,
    last_success_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_customers (
    squarespace_customer_id TEXT PRIMARY KEY,
    contact_id INTEGER REFERENCES contacts(id),
    email TEXT,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    accepts_marketing INTEGER,
    marketing_joined_on TEXT,
    marketing_left_on TEXT,
    locale TEXT,
    address_json TEXT,
    created_on TEXT,
    first_order_on TEXT,
    last_order_on TEXT,
    order_count INTEGER,
    total_order_value TEXT,
    total_refund_value TEXT,
    currency TEXT,
    raw_json TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_orders (
    order_id TEXT PRIMARY KEY,
    order_number TEXT,
    squarespace_customer_id TEXT REFERENCES squarespace_customers(squarespace_customer_id),
    contact_id INTEGER REFERENCES contacts(id),
    customer_email TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    booking_source TEXT NOT NULL DEFAULT 'direct' CHECK (booking_source = 'direct'),
    channel TEXT,
    channel_name TEXT,
    created_on TEXT NOT NULL,
    modified_on TEXT NOT NULL,
    fulfillment_status TEXT,
    payment_state TEXT,
    currency TEXT,
    subtotal_value TEXT,
    discount_total_value TEXT,
    shipping_total_value TEXT,
    tax_total_value TEXT,
    grand_total_value TEXT,
    service_start_date TEXT,
    service_end_date TEXT,
    guest_count INTEGER,
    property_hint TEXT,
    form_submission_json TEXT,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_order_items (
    order_id TEXT NOT NULL REFERENCES squarespace_orders(order_id) ON DELETE CASCADE,
    line_item_id TEXT NOT NULL,
    product_id TEXT,
    variant_id TEXT,
    sku TEXT,
    title TEXT,
    line_item_type TEXT,
    department TEXT NOT NULL DEFAULT 'direct_booking',
    quantity INTEGER,
    currency TEXT,
    unit_price_value TEXT,
    line_total_value TEXT,
    customizations_json TEXT,
    raw_json TEXT NOT NULL,
    PRIMARY KEY (order_id, line_item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_transaction_documents (
    document_id TEXT PRIMARY KEY,
    order_id TEXT,
    customer_email TEXT,
    created_on TEXT,
    modified_on TEXT NOT NULL,
    currency TEXT,
    total_sales_value TEXT,
    total_net_sales_value TEXT,
    total_payment_value TEXT,
    total_net_payment_value TEXT,
    total_tax_value TEXT,
    voided INTEGER NOT NULL DEFAULT 0,
    gateway_error TEXT,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_payments (
    payment_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES squarespace_transaction_documents(document_id) ON DELETE CASCADE,
    order_id TEXT,
    provider TEXT,
    paid_on TEXT,
    currency TEXT,
    amount_value TEXT,
    net_amount_value TEXT,
    refunded_amount_value TEXT,
    external_transaction_id TEXT,
    credit_card_type TEXT,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_processing_fees (
    fee_id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL REFERENCES squarespace_payments(payment_id) ON DELETE CASCADE,
    order_id TEXT,
    currency TEXT,
    amount_value TEXT,
    net_amount_value TEXT,
    refunded_amount_value TEXT,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_refunds (
    refund_id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL REFERENCES squarespace_payments(payment_id) ON DELETE CASCADE,
    order_id TEXT,
    refunded_on TEXT,
    currency TEXT,
    amount_value TEXT,
    external_transaction_id TEXT,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_order_ownerrez_links (
    order_id TEXT PRIMARY KEY REFERENCES squarespace_orders(order_id) ON DELETE CASCADE,
    ownerrez_booking_id INTEGER,
    contact_id INTEGER REFERENCES contacts(id),
    status TEXT NOT NULL DEFAULT 'unmatched',
    match_method TEXT,
    confidence REAL,
    matched_at TEXT,
    reviewed_at TEXT,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS commerce_expense_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    squarespace_order_id TEXT REFERENCES squarespace_orders(order_id),
    squarespace_line_item_id TEXT,
    ownerrez_booking_id INTEGER,
    qbo_transaction_id TEXT,
    slack_channel_id TEXT,
    slack_message_ts TEXT,
    allocated_value TEXT,
    currency TEXT,
    confidence REAL,
    status TEXT NOT NULL DEFAULT 'proposed',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(slack_channel_id, slack_message_ts, squarespace_order_id, squarespace_line_item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS squarespace_notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    audience TEXT NOT NULL,
    event_type TEXT NOT NULL,
    order_id TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sq_customers_contact ON squarespace_customers(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_customers_email ON squarespace_customers(email)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_orders_modified ON squarespace_orders(modified_on)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_orders_created ON squarespace_orders(created_on)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_orders_contact ON squarespace_orders(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_orders_payment ON squarespace_orders(payment_state)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_items_department ON squarespace_order_items(department)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_docs_order ON squarespace_transaction_documents(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_payments_order ON squarespace_payments(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_fees_order ON squarespace_processing_fees(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_refunds_order ON squarespace_refunds(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_links_ownerrez ON squarespace_order_ownerrez_links(ownerrez_booking_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sq_outbox_status ON squarespace_notification_outbox(status, created_at)`,
];

function ensureSchemaBetterSqlite(db) {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
}

async function ensureSchemaAsync(db, sql) {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.query(sql.__dangerous__rawValue(statement));
  }
}

module.exports = { SCHEMA_STATEMENTS, ensureSchemaAsync, ensureSchemaBetterSqlite };
