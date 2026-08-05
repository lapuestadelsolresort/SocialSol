#!/usr/bin/env node
/**
 * ownerrez-sync.js — OwnerRez → CRM real-time sync
 *
 * Polls OwnerRez API for new inquiries, bookings, and guest data.
 * Upserts into contacts + leads tables so the full funnel is visible:
 *   - New Airbnb/VRBO/website inquiries → leads (status=new) + contacts
 *   - Confirmed bookings → contacts (status=booked) with full guest data
 *
 * Designed to run every 15 minutes via LaunchAgent.
 * Also called by the webhook handler for real-time events.
 *
 * Usage:
 *   node ownerrez-sync.js              # normal poll (since last run)
 *   node ownerrez-sync.js --full       # full historical sync
 *   node ownerrez-sync.js --since 2026-07-01  # sync from date
 *   node ownerrez-sync.js --guest 623344882   # sync one guest
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const DB_PATH = path.join(REPO_ROOT, 'crm', 'data', 'crm.db');
const STATE_PATH = path.join(REPO_ROOT, 'memory', 'ownerrez-sync-state.json');
const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const BIZ_CHANNEL = process.env.RESORT_BIZEVENT_CHANNEL || 'C0B384L2TNC';

// ─── Config ──────────────────────────────────────────────────────────────────
let SECRETS = {};
try {
  SECRETS = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
} catch (e) {
  console.error('[ownerrez-sync] Cannot read ownerrez.json:', e.message);
  process.exit(1);
}

const TOKEN = SECRETS.access_token;
const BASE = 'api.ownerrez.com';
const UA = 'OpenClaw LPDS/1.0';

// All property IDs
const PROPERTY_IDS = '455776,456957,456958,456959,456960,456961,456962,456963';

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { last_inquiry_utc: null, last_booking_utc: null, last_run: null }; }
}

function saveState(state) {
  state.last_run = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── OwnerRez API ────────────────────────────────────────────────────────────
function apiGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const fullPath = `/v2/${endpoint}${qs ? '?' + qs : ''}`;
    const opts = {
      hostname: BASE,
      path: fullPath,
      method: 'GET',
      headers: {
        'Authorization': `bearer ${TOKEN}`,
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status_code && parsed.status_code >= 400) {
            reject(new Error(`API ${parsed.status_code}: ${parsed.messages?.join(', ') || 'unknown'}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Parse error on ${endpoint}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchGuest(guestId) {
  try {
    return await apiGet(`guests/${guestId}`);
  } catch (e) {
    console.warn(`[ownerrez-sync] Could not fetch guest ${guestId}: ${e.message}`);
    return null;
  }
}

async function fetchInquiries(sinceUtc) {
  const params = { since_utc: sinceUtc };
  const result = await apiGet('inquiries', params);
  return result.items || [];
}

async function fetchBookings(sinceUtc) {
  const allItems = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const params = { property_ids: PROPERTY_IDS, since_utc: sinceUtc, limit: String(limit), offset: String(offset) };
    const result = await apiGet('bookings', params);
    const items = result.items || [];
    allItems.push(...items);
    if (items.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 300));
  }
  return allItems;
}

// ─── Database ────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
let db;

function openDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

function formatAddress(addr) {
  if (!addr) return null;
  const parts = [addr.street1, addr.city, addr.state || addr.province, addr.postal_code, addr.country]
    .filter(Boolean);
  return parts.join(', ') || null;
}

function normalizePhone(phones) {
  if (!phones || !phones.length) return null;
  return phones[0].number || null;
}

function normalizeEmail(emails) {
  if (!emails || !emails.length) return null;
  return emails[0].address || null;
}

/**
 * Upsert a guest into the contacts table.
 * Returns { action: 'created'|'updated'|'skipped', contact_id }
 */
function upsertContact(guest, meta = {}) {
  const {
    listing_site = null,
    arrival = null,
    departure = null,
    guests_count = null,
    booking_id = null,
    inquiry_id = null,
    is_booking = false,
  } = meta;

  const firstName = guest.first_name || '';
  const lastName = guest.last_name || '';
  const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
  const email = normalizeEmail(guest.email_addresses);
  const phone = normalizePhone(guest.phones);
  const address = formatAddress(guest.addresses?.[0]);
  const ownerrezGuestId = guest.id;

  // Check for existing contact by ownerrez_guest_id
  const existing = db.prepare(
    'SELECT id, email, phone, status FROM contacts WHERE ownerrez_guest_id = ?'
  ).get(ownerrezGuestId);

  if (existing) {
    // Update with any new data
    const updates = [];
    const params = [];

    if (email && !existing.email) { updates.push('email = ?'); params.push(email); }
    if (phone && !existing.phone) { updates.push('phone = ?'); params.push(phone); }
    if (address) { updates.push('address = ?'); params.push(address); }
    if (is_booking && existing.status !== 'booked' && existing.status !== 'converted') {
      updates.push('status = ?'); params.push('booked');
      updates.push('last_stay_date = ?'); params.push(arrival);
    }
    if (booking_id) { updates.push('ownerrez_booking_id = ?'); params.push(booking_id); }
    if (listing_site) { updates.push('listing_channel = ?'); params.push(listing_site); }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(existing.id);
      db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { action: 'updated', contact_id: existing.id };
    }
    return { action: 'skipped', contact_id: existing.id };
  }

  // Also check by email dedup
  if (email) {
    const byEmail = db.prepare('SELECT id FROM contacts WHERE email = ?').get(email);
    if (byEmail) {
      // Link the ownerrez_guest_id to existing contact
      db.prepare(`UPDATE contacts SET ownerrez_guest_id = ?, listing_channel = ?,
        phone = COALESCE(phone, ?), address = COALESCE(address, ?),
        updated_at = datetime('now') WHERE id = ?`)
        .run(ownerrezGuestId, listing_site, phone, address, byEmail.id);
      return { action: 'updated', contact_id: byEmail.id };
    }
  }

  // Create new contact
  const dedupKey = email || `ownerrez_${ownerrezGuestId}`;
  const source = listing_site
    ? `ownerrez_${listing_site.toLowerCase().replace(/\s+/g, '_')}`
    : 'ownerrez';
  const status = is_booking ? 'booked' : 'inquiry';
  const notes = [
    listing_site ? `Via ${listing_site}` : null,
    arrival ? `Dates: ${arrival} → ${departure}` : null,
    guests_count ? `${guests_count} guests` : null,
  ].filter(Boolean).join('. ');

  try {
    const result = db.prepare(`
      INSERT INTO contacts (
        name, first_name, last_name, email, phone, address,
        dedup_key, source, context_source, status, notes,
        ownerrez_guest_id, ownerrez_booking_id, listing_channel,
        relationship_type, contact_provenance, addressable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, firstName, lastName, email, phone, address,
      dedupKey, source, 'ownerrez_sync', status, notes,
      ownerrezGuestId, booking_id, listing_site,
      'past_guest', 'ownerrez_channel', (email || phone) ? 1 : 0
    );
    return { action: 'created', contact_id: result.lastInsertRowid };
  } catch (e) {
    if (/UNIQUE constraint/i.test(e.message)) {
      return { action: 'skipped', contact_id: null };
    }
    throw e;
  }
}

/**
 * Upsert an inquiry into the leads table.
 */
function upsertLead(inquiry, guest) {
  const existing = db.prepare(
    'SELECT id FROM leads WHERE ownerrez_inquiry_id = ?'
  ).get(inquiry.id);
  if (existing) return { action: 'skipped', lead_id: existing.id };

  const name = [guest?.first_name, guest?.last_name].filter(Boolean).join(' ') || 'Unknown';
  const email = normalizeEmail(guest?.email_addresses);
  const phone = normalizePhone(guest?.phones);
  const listingSite = inquiry.listing_site || 'Unknown';

  try {
    const result = db.prepare(`
      INSERT INTO leads (
        name, email, phone, source, status, notes,
        checkin_date, checkout_date, group_size_mentioned,
        ownerrez_guest_id, ownerrez_inquiry_id, listing_channel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, email, phone,
      listingSite.toLowerCase().replace(/\s+/g, '_'),
      'new',
      `${listingSite} inquiry — ${inquiry.guests || '?'} guests, ${inquiry.arrival} to ${inquiry.departure}`,
      inquiry.arrival, inquiry.departure,
      inquiry.guests ? String(inquiry.guests) : null,
      inquiry.guest_id, inquiry.id, listingSite
    );
    return { action: 'created', lead_id: result.lastInsertRowid };
  } catch (e) {
    if (/UNIQUE constraint/i.test(e.message)) {
      return { action: 'skipped', lead_id: null };
    }
    throw e;
  }
}

// ─── Slack notification ──────────────────────────────────────────────────────
function notifySlack(message) {
  if (!SLACK_ACCOUNT || !BIZ_CHANNEL) {
    console.log('[ownerrez-sync] Slack notification (no channel configured):', message);
    return;
  }
  try {
    const { execFileSync } = require('child_process');
    execFileSync(OPENCLAW, [
      'message', 'send',
      '--account', SLACK_ACCOUNT,
      '--target', BIZ_CHANNEL,
      '--message', message,
    ], { timeout: 10000, stdio: 'ignore' });
  } catch (e) {
    console.warn('[ownerrez-sync] Slack send failed:', e.message);
  }
}

// ─── Main sync ───────────────────────────────────────────────────────────────
async function sync(opts = {}) {
  const state = loadState();
  const since = opts.since
    || state.last_inquiry_utc
    || '2025-01-01T00:00:00Z';

  console.log(`[ownerrez-sync] Syncing since ${since}`);
  openDb();

  const stats = { inquiries: 0, bookings: 0, contacts_created: 0, contacts_updated: 0, leads_created: 0 };

  // 1. Sync inquiries
  try {
    const inquiries = await fetchInquiries(since);
    console.log(`[ownerrez-sync] Found ${inquiries.length} inquiries`);

    for (const inq of inquiries) {
      const guest = await fetchGuest(inq.guest_id);
      if (!guest) continue;

      // Upsert contact
      const cr = upsertContact(guest, {
        listing_site: inq.listing_site,
        arrival: inq.arrival,
        departure: inq.departure,
        guests_count: inq.guests,
        inquiry_id: inq.id,
      });
      if (cr.action === 'created') stats.contacts_created++;
      if (cr.action === 'updated') stats.contacts_updated++;

      // Upsert lead
      const lr = upsertLead(inq, guest);
      if (lr.action === 'created') stats.leads_created++;
      stats.inquiries++;

      // Rate limiting courtesy
      await new Promise(r => setTimeout(r, 200));
    }

    if (inquiries.length > 0) {
      const newest = inquiries.reduce((a, b) =>
        (b.created_utc || '') > (a.created_utc || '') ? b : a
      );
      state.last_inquiry_utc = newest.created_utc || since;
    }
  } catch (e) {
    console.error('[ownerrez-sync] Inquiry sync error:', e.message);
  }

  // 2. Sync bookings (with guest data)
  try {
    const bookings = await fetchBookings(since);
    const realBookings = bookings.filter(b => b.guest_id && b.type === 'booking');
    console.log(`[ownerrez-sync] Found ${realBookings.length} bookings (${bookings.length} total incl. blocks)`);

    for (const bk of realBookings) {
      const guest = await fetchGuest(bk.guest_id);
      if (!guest) continue;

      const cr = upsertContact(guest, {
        listing_site: bk.listing_site_name,
        arrival: bk.arrival,
        departure: bk.departure,
        booking_id: bk.id,
        is_booking: true,
      });
      if (cr.action === 'created') stats.contacts_created++;
      if (cr.action === 'updated') stats.contacts_updated++;
      stats.bookings++;

      await new Promise(r => setTimeout(r, 200));
    }

    if (realBookings.length > 0) {
      const newest = realBookings.reduce((a, b) =>
        (b.created_utc || '') > (a.created_utc || '') ? b : a
      );
      state.last_booking_utc = newest.created_utc || since;
    }
  } catch (e) {
    console.error('[ownerrez-sync] Booking sync error:', e.message);
  }

  saveState(state);
  db.close();

  console.log(`[ownerrez-sync] Done:`, stats);

  // Notify if there's anything new
  if (stats.contacts_created > 0 || stats.leads_created > 0) {
    notifySlack(
      `☀️ *OwnerRez Sync* — ${stats.leads_created} new lead(s), ` +
      `${stats.contacts_created} new contact(s), ${stats.contacts_updated} updated. ` +
      `(${stats.inquiries} inquiries, ${stats.bookings} bookings processed)`
    );
  }

  return stats;
}

// ─── Single guest sync (called from webhook handler) ─────────────────────────
async function syncGuest(guestId, meta = {}) {
  openDb();
  const guest = await fetchGuest(guestId);
  if (!guest) { db.close(); return null; }
  const result = upsertContact(guest, meta);
  db.close();
  return result;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};

  if (args.includes('--full')) {
    opts.since = '2020-01-01T00:00:00Z';
  } else if (args.includes('--since')) {
    const idx = args.indexOf('--since');
    opts.since = new Date(args[idx + 1]).toISOString();
  } else if (args.includes('--guest')) {
    const idx = args.indexOf('--guest');
    syncGuest(parseInt(args[idx + 1])).then(r => {
      console.log('Result:', r);
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1); });
    return;
  }

  sync(opts).then(() => process.exit(0)).catch(e => {
    console.error('[ownerrez-sync] Fatal:', e);
    process.exit(1);
  });
}

module.exports = { sync, syncGuest, fetchGuest, upsertContact, upsertLead };
