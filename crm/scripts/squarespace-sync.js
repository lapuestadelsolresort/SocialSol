#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');
const {
  applyTransactionSummaries,
  normalizeEmail,
  upsertCustomer,
  upsertOrder,
  upsertTransactionDocument,
} = require('../lib/squarespace-commerce');
const { createSquarespaceClient } = require('./lib/squarespace-api');
const { createApiGet: createOwnerRezApiGet } = require('./lib/ownerrez-api');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(ROOT, 'secrets');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db'));
const CONFIG_PATH = path.resolve(process.env.SQUARESPACE_CONFIG
  || path.join(ROOT, 'squarespace', 'config.json'));
const CONFIG_EXAMPLE = path.join(ROOT, 'squarespace', 'config.example.json');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (fallback !== null) return fallback;
    throw new Error(`Cannot read ${path.basename(file)}: ${error.message}`);
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function validDate(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} must be an ISO date/time`);
  return parsed.toISOString();
}

function subtractMinutes(iso, minutes) {
  return new Date(new Date(iso).valueOf() - minutes * 60000).toISOString();
}

function maxModified(rows, field = 'modifiedOn') {
  return rows.reduce((latest, row) => {
    const value = row[field];
    return value && (!latest || value > latest) ? value : latest;
  }, null);
}

function getState(db, stream) {
  return db.prepare('SELECT * FROM squarespace_sync_state WHERE stream=?').get(stream) || {};
}

function setState(db, stream, { lastModifiedOn = null, success = false, error = null } = {}) {
  db.prepare(`
    INSERT INTO squarespace_sync_state
      (stream, last_modified_on, last_success_at, last_error, updated_at)
    VALUES (?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, ?, datetime('now'))
    ON CONFLICT(stream) DO UPDATE SET
      last_modified_on=COALESCE(excluded.last_modified_on, squarespace_sync_state.last_modified_on),
      last_success_at=CASE WHEN ? THEN datetime('now') ELSE squarespace_sync_state.last_success_at END,
      last_error=?, updated_at=datetime('now')
  `).run(stream, lastModifiedOn, success ? 1 : 0, error, success ? 1 : 0, error);
}

function candidateOwnerRezIds(db) {
  return db.prepare(`
    SELECT order_id, ownerrez_booking_id
      FROM squarespace_order_ownerrez_links
     WHERE status='candidate' AND ownerrez_booking_id IS NOT NULL
  `).all();
}

async function fetchOwnerRezCandidates(db, ordersById) {
  const secrets = readJson(path.join(SECRETS_DIR, 'ownerrez.json'), {});
  if (!secrets.access_token) return new Map();
  const apiGet = createOwnerRezApiGet({ token: secrets.access_token });
  const output = new Map();
  for (const row of candidateOwnerRezIds(db)) {
    if (!ordersById.has(row.order_id) || output.has(row.ownerrez_booking_id)) continue;
    try {
      output.set(row.ownerrez_booking_id, await apiGet(`bookings/${row.ownerrez_booking_id}`));
    } catch (error) {
      console.warn(`[squarespace-sync] OwnerRez validation skipped for booking ${row.ownerrez_booking_id}: ${error.message}`);
    }
  }
  return output;
}

function printHelp() {
  console.log(`Usage: node crm/scripts/squarespace-sync.js [options]

Read-only Squarespace Commerce sync into the local CRM. It never writes to
Squarespace, OwnerRez, QuickBooks, Kapital, or Slack.

Options:
  --full                 Backfill from sync.initial_backfill_since
  --since ISO_DATETIME   Override the incremental watermark
  --dry-run              Fetch and report counts without changing the CRM
  --json                 Print a machine-readable summary
  --help                 Show this help`);
}

async function run(args = process.argv.slice(2), injected = {}) {
  if (args.includes('--help')) { printHelp(); return null; }
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const config = injected.config || readJson(CONFIG_PATH, readJson(CONFIG_EXAMPLE, {}));
  const secrets = injected.squarespaceSecrets || readJson(path.join(SECRETS_DIR, 'squarespace.json'));
  if (!secrets.api_key) throw new Error('squarespace.json does not contain api_key');
  const client = injected.client || createSquarespaceClient({ apiKey: secrets.api_key });
  // --dry-run performs no writes, so it takes a read-only handle (F-042).
  const db = injected.db || new Database(DB_PATH, dryRun ? { readonly: true } : {});
  const ownsDb = !injected.db;
  const startedAt = new Date().toISOString();
  const now = new Date().toISOString();
  let runId = null;

  try {
    db.pragma('foreign_keys = ON');
    if (!dryRun) ensureSchemaBetterSqlite(db);
    const state = dryRun ? {} : getState(db, 'orders');
    const overlap = Number(config.sync?.overlap_minutes || 15);
    const override = optionValue(args, '--since');
    const initial = config.sync?.initial_backfill_since || '2020-01-01T00:00:00.000Z';
    const since = override
      ? validDate(override, '--since')
      : full ? validDate(initial, 'initial_backfill_since')
        : state.last_modified_on ? subtractMinutes(state.last_modified_on, overlap)
          : validDate(initial, 'initial_backfill_since');
    const paymentStates = config.sync?.payment_states || [];

    if (!dryRun) {
      runId = db.prepare(`INSERT INTO squarespace_sync_runs (mode, started_at)
        VALUES (?, ?)`).run(full ? 'full' : 'incremental', startedAt).lastInsertRowid;
    }

    const [contacts, orderPages, transactions] = await Promise.all([
      client.listContacts(),
      Promise.all((paymentStates.length ? paymentStates : [null]).map(paymentState =>
        client.listOrders({
          modifiedAfter: since,
          modifiedBefore: now,
          ...(paymentState ? { paymentStates: paymentState } : {}),
        })
      )),
      client.listTransactions({ modifiedAfter: since, modifiedBefore: now }),
    ]);
    // Squarespace currently emits unusable next-page cursors for some large,
    // comma-separated payment-state filters. Querying each canonical state
    // independently preserves full coverage and makes the streams deduplicable.
    const orders = [...new Map(orderPages.flat().map(order => [order.id, order])).values()];
    const summaries = await client.getTransactionSummaries(contacts.map(contact => contact.id).filter(Boolean));
    const summaryByContact = new Map(summaries.map(summary => [summary.contactId, summary]));
    const customerById = new Map(contacts.map(contact => [contact.id, contact]));
    const ordersById = new Map(orders.map(order => [order.id, order]));
    const stats = {
      ok: true,
      dry_run: dryRun,
      mode: full ? 'full' : 'incremental',
      since,
      through: now,
      contacts_seen: contacts.length,
      orders_seen: orders.length,
      transactions_seen: transactions.length,
      contacts_linked: 0,
      bookings_linked: 0,
      booking_candidates: 0,
      booking_exceptions: 0,
    };
    if (dryRun) return stats;

    db.transaction(() => {
      for (const contact of contacts) {
        const crmContact = upsertCustomer(db, contact, summaryByContact.get(contact.id));
        if (crmContact) stats.contacts_linked += 1;
      }
      applyTransactionSummaries(db, summaries);
      for (const order of orders) {
        const result = upsertOrder(db, order, {
          customer: customerById.get(order.customerId), config, notify: !full,
        });
        if (result.link.status === 'matched') stats.bookings_linked += 1;
        else if (result.link.status === 'candidate') stats.booking_candidates += 1;
        else stats.booking_exceptions += 1;
      }
      for (const document of transactions) upsertTransactionDocument(db, document);
    })();

    // Validate conservative contact-based OwnerRez candidates with a read-only
    // booking lookup. Re-upserting the same modified version does not duplicate
    // notifications because the outbox has deterministic event keys.
    const ownerrezByBookingId = await fetchOwnerRezCandidates(db, ordersById);
    if (ownerrezByBookingId.size) {
      stats.bookings_linked = 0;
      stats.booking_candidates = 0;
      stats.booking_exceptions = 0;
      db.transaction(() => {
        for (const order of orders) {
          const candidate = db.prepare(
            'SELECT ownerrez_booking_id FROM squarespace_order_ownerrez_links WHERE order_id=?'
          ).get(order.id);
          const result = upsertOrder(db, order, {
            customer: customerById.get(order.customerId),
            config,
            notify: !full,
            ownerrezBooking: candidate?.ownerrez_booking_id
              ? ownerrezByBookingId.get(candidate.ownerrez_booking_id) || null
              : null,
          });
          if (result.link.status === 'matched') stats.bookings_linked += 1;
          else if (result.link.status === 'candidate') stats.booking_candidates += 1;
          else stats.booking_exceptions += 1;
        }
      })();
    }

    const orderWatermark = maxModified(orders) || state.last_modified_on || since;
    const txnWatermark = maxModified(transactions) || getState(db, 'transactions').last_modified_on || since;
    setState(db, 'orders', { lastModifiedOn: orderWatermark, success: true });
    setState(db, 'transactions', { lastModifiedOn: txnWatermark, success: true });
    setState(db, 'contacts', { lastModifiedOn: now, success: true });
    db.prepare(`UPDATE squarespace_sync_runs SET
      finished_at=datetime('now'), status='ok', orders_seen=?, transactions_seen=?,
      contacts_seen=?, contacts_linked=?, bookings_linked=? WHERE id=?`)
      .run(orders.length, transactions.length, contacts.length, stats.contacts_linked, stats.bookings_linked, runId);
    return stats;
  } catch (error) {
    if (!dryRun && runId) {
      db.prepare("UPDATE squarespace_sync_runs SET finished_at=datetime('now'), status='error', error=? WHERE id=?")
        .run(String(error.message).slice(0, 1000), runId);
      setState(db, 'orders', { error: String(error.message).slice(0, 1000) });
    }
    throw error;
  } finally {
    if (ownsDb) db.close();
  }
}

if (require.main === module) {
  run().then(stats => {
    if (stats) console.log(JSON.stringify(stats, null, process.argv.includes('--json') ? 0 : 2));
  }).catch(error => {
    console.error(`[squarespace-sync] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { maxModified, run, subtractMinutes };
