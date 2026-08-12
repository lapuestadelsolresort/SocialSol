#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');
const {
  applyHighConfidenceReconciliation,
  buildOwnerCashFlow,
  formatOwnerCashFlow,
} = require('../lib/owner-cash-flow');
const { createApiGet } = require('./lib/ownerrez-api');
const { fetchAllBookings, selectFutureOccupancy, validateDate } = require('./lib/ownerrez-occupancy');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db'));
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(ROOT, 'secrets');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${path.basename(file)}: ${error.message}`); }
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function printHelp() {
  console.log(`Usage: node crm/scripts/owner-cash-flow.js [options]

Canonical, read-only owner cash-flow outlook from live OwnerRez inventory and
the synchronized Squarespace commerce read model.

Options:
  --as-of YYYY-MM-DD       Outlook date (default: today in America/Los_Angeles)
  --through YYYY-MM-DD     Optional last stay-arrival date
  --json                   Print the full structured report
  --apply-reconciliation   Persist only high-confidence or review OwnerRez links
  --help                   Show this help

The report never calls Squarespace write APIs, OwnerRez write APIs, Kapital,
QuickBooks, or Slack. --apply-reconciliation only updates local CRM link rows.`);
}

async function fetchGuestNames(apiGet, bookings, { asOf, through }) {
  const future = selectFutureOccupancy(bookings, { asOf, through });
  const ids = [...new Set(future.map(booking => booking.guest_id).filter(Boolean))];
  const names = {};
  await Promise.all(ids.map(async id => {
    try {
      const guest = await apiGet(`guests/${id}`);
      const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim();
      if (name) names[String(id)] = name;
    } catch (error) {
      names[String(id)] = `OwnerRez guest ${id}`;
    }
  }));
  return names;
}

async function run(args = process.argv.slice(2), injected = {}) {
  if (args.includes('--help')) { printHelp(); return null; }
  const asOf = optionValue(args, '--as-of') || today();
  const through = optionValue(args, '--through');
  validateDate(asOf, '--as-of');
  if (through) {
    validateDate(through, '--through');
    if (through < asOf) throw new Error('--through must be on or after --as-of');
  }

  const db = injected.db || new Database(DB_PATH);
  const ownsDb = !injected.db;
  try {
    ensureSchemaBetterSqlite(db);
    const apiGet = injected.apiGet || createApiGet({
      token: (injected.ownerrezSecrets || readJson(path.join(SECRETS_DIR, 'ownerrez.json'))).access_token,
    });
    const ownerrezBookings = injected.ownerrezBookings || await fetchAllBookings(apiGet);
    const guestNames = injected.guestNames || await fetchGuestNames(apiGet, ownerrezBookings, { asOf, through });
    const report = buildOwnerCashFlow(db, { ownerrezBookings, guestNames, asOf, through });
    if (args.includes('--apply-reconciliation')) {
      report.reconciliation_write = applyHighConfidenceReconciliation(db, report);
    }
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatOwnerCashFlow(report));
    return report;
  } finally {
    if (ownsDb) db.close();
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(`[owner-cash-flow] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { fetchGuestNames, run, today };
