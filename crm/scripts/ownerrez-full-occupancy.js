#!/usr/bin/env node
/**
 * ownerrez-full-occupancy.js — Complete OwnerRez occupancy query
 *
 * Read-only source for booking-calendar and availability questions. Unlike the
 * CRM contact sync, this includes every active booking/block in the requested
 * window regardless of guest_id or type.
 *
 * Usage:
 *   node crm/scripts/ownerrez-full-occupancy.js
 *   node crm/scripts/ownerrez-full-occupancy.js --start 2026-08-10 --end 2026-09-07
 *   node crm/scripts/ownerrez-full-occupancy.js --start 2026-08-10 --end 2026-09-07 --json
 *   node crm/scripts/ownerrez-full-occupancy.js --start 2026-08-10 --end 2027-08-15 --enriched-json
 *   node crm/scripts/ownerrez-full-occupancy.js --summary
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createApiGet } = require('./lib/ownerrez-api');
const {
  attachGuestNames,
  fetchFullOccupancy,
  fetchGuestNames,
  humanizeType,
  isBlock,
  reservationDisplayName,
  validateDate,
} = require('./lib/ownerrez-occupancy');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return args[index + 1];
}

function printHelp() {
  console.log(`Usage: node crm/scripts/ownerrez-full-occupancy.js [options]

Options:
  --start YYYY-MM-DD  First date in the occupancy window (default: today)
  --end YYYY-MM-DD    Last date in the occupancy window (default: start + 28 days)
  --json              Print the full matching OwnerRez records as JSON
  --enriched-json     Print records with guest names resolved live from OwnerRez
  --summary           Print counts only
  --help              Show this help`);
}

function propertyName(booking) {
  return booking.property?.name || `Property ${booking.property_id || 'unknown'}`;
}

function summaryFor(bookings, start, end) {
  const blocks = bookings.filter(isBlock).length;
  return {
    start,
    end,
    active_occupancy_records: bookings.length,
    reservations: bookings.length - blocks,
    blocks_and_holds: blocks,
    with_guest_id: bookings.filter(booking => booking.guest_id).length,
    without_guest_id: bookings.filter(booking => !booking.guest_id).length,
  };
}

async function run(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    printHelp();
    return;
  }

  const start = optionValue(args, '--start') || today();
  const end = optionValue(args, '--end') || addDays(start, 28);
  validateDate(start, 'start');
  validateDate(end, 'end');
  if (end < start) throw new Error('end must be on or after start');

  const secrets = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
  const apiGet = createApiGet({ token: secrets.access_token });
  const bookings = await fetchFullOccupancy(apiGet, { start, end });

  if (args.includes('--summary')) {
    console.log(JSON.stringify(summaryFor(bookings, start, end), null, 2));
    return;
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(bookings, null, 2));
    return;
  }

  if (args.includes('--enriched-json')) {
    const guestNames = await fetchGuestNames(apiGet, bookings);
    console.log(JSON.stringify(attachGuestNames(bookings, guestNames), null, 2));
    return;
  }

  console.log(`OwnerRez full occupancy: ${start} to ${end}`);
  console.log(`${bookings.length} active reservation/block record(s)`);

  for (const booking of bookings) {
    const kind = isBlock(booking) ? humanizeType(booking.type) : 'booking';
    console.log(
      `${booking.arrival} -> ${booking.departure} | ${propertyName(booking)} | ` +
      `${kind} | ${reservationDisplayName(booking)}`
    );
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error('[ownerrez-full-occupancy] Fatal:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { addDays, run, summaryFor, today };
