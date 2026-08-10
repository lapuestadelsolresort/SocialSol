'use strict';

const express = require('express');
const { sql } = require('@databases/sqlite');

function parseLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function buildRouter(getDb) {
  const router = express.Router();

  router.get('/summary', async (req, res) => {
    const db = getDb();
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    try {
      const [orders] = await db.query(sql`
        SELECT COUNT(*) AS order_count,
               COALESCE(SUM(CAST(grand_total_value AS REAL)),0) AS gross_order_value,
               COALESCE(SUM(CASE WHEN payment_state='PAID' THEN 1 ELSE 0 END),0) AS paid_orders,
               COALESCE(SUM(CASE WHEN payment_state='PARTIALLY_PAID' THEN 1 ELSE 0 END),0) AS partially_paid_orders,
               MIN(currency) AS currency
          FROM squarespace_orders
         WHERE (${start} IS NULL OR created_on>=${start})
           AND (${end} IS NULL OR created_on<${end})
      `);
      const [payments] = await db.query(sql`
        SELECT COALESCE(SUM(CAST(amount_value AS REAL)),0) AS collected,
               COALESCE(SUM(CAST(net_amount_value AS REAL)),0) AS payment_net
          FROM squarespace_payments
         WHERE (${start} IS NULL OR paid_on>=${start})
           AND (${end} IS NULL OR paid_on<${end})
      `);
      const [fees] = await db.query(sql`
        SELECT COALESCE(SUM(CAST(f.amount_value AS REAL)),0) AS processing_fees,
               COALESCE(SUM(CAST(f.refunded_amount_value AS REAL)),0) AS refunded_fees
          FROM squarespace_processing_fees f
          LEFT JOIN squarespace_payments p ON p.payment_id=f.payment_id
         WHERE (${start} IS NULL OR p.paid_on>=${start})
           AND (${end} IS NULL OR p.paid_on<${end})
      `);
      const [refunds] = await db.query(sql`
        SELECT COALESCE(SUM(CAST(amount_value AS REAL)),0) AS refunds
          FROM squarespace_refunds
         WHERE (${start} IS NULL OR refunded_on>=${start})
           AND (${end} IS NULL OR refunded_on<${end})
      `);
      const [links] = await db.query(sql`
        SELECT COALESCE(SUM(CASE WHEN status='matched' THEN 1 ELSE 0 END),0) AS matched,
               COALESCE(SUM(CASE WHEN status='candidate' THEN 1 ELSE 0 END),0) AS candidates,
               COALESCE(SUM(CASE WHEN status IN ('unmatched','review') THEN 1 ELSE 0 END),0) AS exceptions
          FROM squarespace_order_ownerrez_links
      `);
      const [housekeeping] = await db.query(sql`
        SELECT COUNT(DISTINCT order_id) AS housekeeping_orders
          FROM squarespace_order_items WHERE department='housekeeping'
      `);
      const collected = Number(payments.collected || 0);
      const processingFees = Number(fees.processing_fees || 0);
      const refundedFees = Number(fees.refunded_fees || 0);
      const refundTotal = Number(refunds.refunds || 0);
      res.json({
        source: 'squarespace',
        booking_channel: 'direct',
        window: { start, end },
        ...orders,
        ...payments,
        ...fees,
        ...refunds,
        net_after_fees_and_refunds: collected - processingFees + refundedFees - refundTotal,
        ownerrez_links: links,
        ...housekeeping,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/orders', async (req, res) => {
    const db = getDb();
    const limit = parseLimit(req.query.limit);
    const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
    const paymentState = req.query.payment_state ? String(req.query.payment_state) : null;
    const department = req.query.department ? String(req.query.department) : null;
    const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    try {
      const rows = await db.query(sql`
        SELECT o.order_id, o.order_number, o.customer_name, o.customer_email,
               o.created_on, o.modified_on, o.payment_state, o.fulfillment_status,
               o.currency, o.grand_total_value, o.service_start_date, o.service_end_date,
               o.guest_count, o.property_hint, o.contact_id,
               l.ownerrez_booking_id, l.status AS ownerrez_match_status,
               l.match_method, l.confidence
          FROM squarespace_orders o
          LEFT JOIN squarespace_order_ownerrez_links l ON l.order_id=o.order_id
         WHERE (${paymentState} IS NULL OR o.payment_state=${paymentState})
           AND (${search} IS NULL OR o.order_number LIKE ${search}
                OR o.customer_name LIKE ${search} OR o.customer_email LIKE ${search})
           AND (${department} IS NULL OR EXISTS (
             SELECT 1 FROM squarespace_order_items i
              WHERE i.order_id=o.order_id AND i.department=${department}
           ))
         ORDER BY o.modified_on DESC
         LIMIT ${limit} OFFSET ${offset}
      `);
      res.json({ orders: rows, limit, offset });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/orders/:orderId', async (req, res) => {
    const db = getDb();
    try {
      const [order] = await db.query(sql`
        SELECT o.*, l.ownerrez_booking_id, l.status AS ownerrez_match_status,
               l.match_method, l.confidence
          FROM squarespace_orders o
          LEFT JOIN squarespace_order_ownerrez_links l ON l.order_id=o.order_id
         WHERE o.order_id=${req.params.orderId}
      `);
      if (!order) return res.status(404).json({ error: 'order not found' });
      const items = await db.query(sql`
        SELECT line_item_id, product_id, variant_id, sku, title, line_item_type,
               department, quantity, currency, unit_price_value, line_total_value,
               customizations_json
          FROM squarespace_order_items WHERE order_id=${req.params.orderId}
         ORDER BY line_item_id
      `);
      const payments = await db.query(sql`
        SELECT payment_id, provider, paid_on, currency, amount_value,
               net_amount_value, refunded_amount_value, credit_card_type
          FROM squarespace_payments WHERE order_id=${req.params.orderId}
         ORDER BY paid_on
      `);
      const fees = await db.query(sql`
        SELECT fee_id, payment_id, currency, amount_value, net_amount_value, refunded_amount_value
          FROM squarespace_processing_fees WHERE order_id=${req.params.orderId}
      `);
      const refunds = await db.query(sql`
        SELECT refund_id, payment_id, refunded_on, currency, amount_value
          FROM squarespace_refunds WHERE order_id=${req.params.orderId}
         ORDER BY refunded_on
      `);
      res.json({
        order: {
          ...order,
          form_submission: safeJson(order.form_submission_json, []),
          form_submission_json: undefined,
          raw_json: undefined,
        },
        items: items.map(item => ({
          ...item,
          customizations: safeJson(item.customizations_json, []),
          customizations_json: undefined,
        })),
        payments,
        fees,
        refunds,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/reconciliation', async (req, res) => {
    const db = getDb();
    const limit = parseLimit(req.query.limit, 100, 500);
    try {
      const bookingExceptions = await db.query(sql`
        SELECT o.order_id, o.order_number, o.customer_name, o.created_on,
               o.payment_state, o.grand_total_value, o.currency,
               l.ownerrez_booking_id, l.status, l.match_method, l.confidence
          FROM squarespace_orders o
          LEFT JOIN squarespace_order_ownerrez_links l ON l.order_id=o.order_id
         WHERE l.status IS NULL OR l.status!='matched'
         ORDER BY o.created_on DESC LIMIT ${limit}
      `);
      const ordersWithoutTransactions = await db.query(sql`
        SELECT o.order_id, o.order_number, o.created_on, o.payment_state,
               o.grand_total_value, o.currency
          FROM squarespace_orders o
         WHERE o.payment_state IN ('PAID','PARTIALLY_PAID','REFUNDED')
           AND NOT EXISTS (
             SELECT 1 FROM squarespace_transaction_documents d WHERE d.order_id=o.order_id
           )
         ORDER BY o.created_on DESC LIMIT ${limit}
      `);
      const documentsWithoutOrders = await db.query(sql`
        SELECT d.document_id, d.order_id, d.customer_email, d.modified_on,
               d.total_payment_value, d.currency, d.gateway_error
          FROM squarespace_transaction_documents d
         WHERE d.order_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM squarespace_orders o WHERE o.order_id=d.order_id)
         ORDER BY d.modified_on DESC LIMIT ${limit}
      `);
      const [lastRun] = await db.query(sql`
        SELECT * FROM squarespace_sync_runs ORDER BY id DESC LIMIT 1
      `);
      res.json({ last_sync_run: lastRun || null, booking_exceptions: bookingExceptions,
        orders_without_transactions: ordersWithoutTransactions,
        transaction_documents_without_orders: documentsWithoutOrders });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/expense-links', async (req, res) => {
    const db = getDb();
    const orderId = req.query.order_id ? String(req.query.order_id) : null;
    try {
      const rows = await db.query(sql`
        SELECT * FROM commerce_expense_links
         WHERE (${orderId} IS NULL OR squarespace_order_id=${orderId})
         ORDER BY created_at DESC LIMIT 500
      `);
      res.json({ links: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/expense-links', async (req, res) => {
    const db = getDb();
    const body = req.body || {};
    if (!body.squarespace_order_id) return res.status(400).json({ error: 'squarespace_order_id is required' });
    if (!body.qbo_transaction_id && !(body.slack_channel_id && body.slack_message_ts)) {
      return res.status(400).json({ error: 'qbo_transaction_id or Slack channel/message reference is required' });
    }
    try {
      const [order] = await db.query(sql`SELECT order_id FROM squarespace_orders WHERE order_id=${body.squarespace_order_id}`);
      if (!order) return res.status(404).json({ error: 'Squarespace order not found' });
      await db.query(sql`
        INSERT INTO commerce_expense_links (
          squarespace_order_id, squarespace_line_item_id, ownerrez_booking_id,
          qbo_transaction_id, slack_channel_id, slack_message_ts,
          allocated_value, currency, confidence, status, notes
        ) VALUES (
          ${body.squarespace_order_id}, ${body.squarespace_line_item_id || null},
          ${body.ownerrez_booking_id || null}, ${body.qbo_transaction_id || null},
          ${body.slack_channel_id || null}, ${body.slack_message_ts || null},
          ${body.allocated_value || null}, ${body.currency || null},
          ${body.confidence ?? null}, ${body.status || 'proposed'}, ${body.notes || null}
        )
        ON CONFLICT(slack_channel_id, slack_message_ts, squarespace_order_id, squarespace_line_item_id)
        DO UPDATE SET qbo_transaction_id=excluded.qbo_transaction_id,
          ownerrez_booking_id=excluded.ownerrez_booking_id,
          allocated_value=excluded.allocated_value, currency=excluded.currency,
          confidence=excluded.confidence, status=excluded.status,
          notes=excluded.notes, updated_at=datetime('now')
      `);
      res.status(201).json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
