#!/usr/bin/env node
/**
 * ownerrez-weekly-calendar.js — Weekly booking calendar for the ops team
 *
 * Posts a bilingual (English + Spanish) summary of upcoming reservations
 * to #reservations (REDACTED_SLACK_CHANNEL) every Monday morning so the team
 * (especially Sergio) can plan maintenance around guest stays.
 *
 * Shows the next 4 weeks of confirmed bookings by property.
 *
 * Usage:
 *   node ownerrez-weekly-calendar.js           # post to Slack
 *   node ownerrez-weekly-calendar.js --dry-run  # print only
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const CHANNEL = 'REDACTED_SLACK_CHANNEL';

const SECRETS = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
const TOKEN = SECRETS.access_token;
const BASE = 'api.ownerrez.com';
const UA = 'OpenClaw LPDS/1.0';
const PROPERTY_IDS = '455776,456957,456958,456959,456960,456961,456962,456963';

const DRY_RUN = process.argv.includes('--dry-run');

// ─── API ─────────────────────────────────────────────────────────────────────
function apiGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const fullPath = `/v2/${endpoint}${qs ? '?' + qs : ''}`;
    const req = https.request({
      hostname: BASE, path: fullPath, method: 'GET',
      headers: {
        'Authorization': `bearer ${TOKEN}`,
        'User-Agent': UA,
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── Date helpers ────────────────────────────────────────────────────────────
function today() {
  // Use LA timezone
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  return d.toLocaleDateString('en-US', opts);
}

function formatDateEs(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  return d.toLocaleDateString('es-MX', opts);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const start = today();
  const end = addDays(start, 28); // 4 weeks out

  console.log(`[weekly-calendar] Fetching bookings ${start} → ${end}`);

  // Fetch all bookings in range
  const allBookings = [];
  let offset = 0;
  while (true) {
    const result = await apiGet('bookings', {
      property_ids: PROPERTY_IDS,
      since_utc: '2020-01-01T00:00:00Z',
      limit: '100',
      offset: String(offset),
    });
    const items = result.items || [];
    allBookings.push(...items);
    if (items.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 300));
  }

  // Filter: real bookings (not blocks) with guest, overlapping our window
  const upcoming = allBookings.filter(b =>
    b.guest_id &&
    b.type === 'booking' &&
    b.status === 'active' &&
    b.departure >= start &&
    b.arrival <= end
  );

  // Fetch guest names
  const guestNames = {};
  for (const b of upcoming) {
    if (!guestNames[b.guest_id]) {
      try {
        const g = await apiGet(`guests/${b.guest_id}`);
        guestNames[b.guest_id] = [g.first_name, g.last_name].filter(Boolean).join(' ') || 'Guest';
      } catch { guestNames[b.guest_id] = 'Guest'; }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Sort by arrival
  upcoming.sort((a, b) => a.arrival.localeCompare(b.arrival));

  // Group by property
  const byProperty = {};
  for (const b of upcoming) {
    const prop = b.property?.name || 'Unknown';
    if (!byProperty[prop]) byProperty[prop] = [];
    byProperty[prop].push(b);
  }

  if (upcoming.length === 0) {
    const msg = `📅 *Weekly Booking Calendar* (${formatDate(start)} — ${formatDate(end)})\n` +
      `No upcoming reservations in the next 4 weeks.\n\n` +
      `🇲🇽 *Calendario Semanal de Reservaciones* (${formatDateEs(start)} — ${formatDateEs(end)})\n` +
      `No hay reservaciones en las próximas 4 semanas.`;
    if (DRY_RUN) { console.log(msg); return; }
    slackSend(msg);
    return;
  }

  // Build English message
  let en = `📅 *Weekly Booking Calendar* (${formatDate(start)} — ${formatDate(end)})\n`;
  en += `${upcoming.length} upcoming reservation(s):\n\n`;

  for (const [prop, bookings] of Object.entries(byProperty)) {
    en += `*${prop}*\n`;
    for (const b of bookings) {
      const guest = guestNames[b.guest_id] || 'Guest';
      const adults = b.adults || '?';
      const children = b.children || 0;
      const guestInfo = children > 0 ? `${adults}A + ${children}C` : `${adults} guests`;
      en += `  • ${formatDate(b.arrival)} → ${formatDate(b.departure)} — ${guest} (${guestInfo})\n`;
    }
    en += `\n`;
  }

  // Build Spanish message
  let es = `🇲🇽 *Calendario Semanal de Reservaciones* (${formatDateEs(start)} — ${formatDateEs(end)})\n`;
  es += `${upcoming.length} reservación(es) próxima(s):\n\n`;

  for (const [prop, bookings] of Object.entries(byProperty)) {
    es += `*${prop}*\n`;
    for (const b of bookings) {
      const guest = guestNames[b.guest_id] || 'Huésped';
      const adults = b.adults || '?';
      const children = b.children || 0;
      const guestInfo = children > 0 ? `${adults}A + ${children}N` : `${adults} huéspedes`;
      es += `  • ${formatDateEs(b.arrival)} → ${formatDateEs(b.departure)} — ${guest} (${guestInfo})\n`;
    }
    es += `\n`;
  }

  const fullMsg = en + es;

  if (DRY_RUN) {
    console.log(fullMsg);
    return;
  }

  slackSend(fullMsg);
  console.log(`[weekly-calendar] Posted ${upcoming.length} bookings to #reservations`);
}

function slackSend(message) {
  if (!SLACK_ACCOUNT) {
    console.log('[weekly-calendar] No Slack account configured. Message:\n', message);
    return;
  }
  try {
    execFileSync(OPENCLAW, [
      'message', 'send',
      '--account', SLACK_ACCOUNT,
      '--target', CHANNEL,
      '--message', message,
    ], { timeout: 15000, stdio: 'ignore' });
  } catch (e) {
    console.error('[weekly-calendar] Slack send failed:', e.message);
  }
}

run().then(() => process.exit(0)).catch(e => {
  console.error('[weekly-calendar] Fatal:', e);
  process.exit(1);
});
