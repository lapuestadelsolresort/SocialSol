#!/usr/bin/env node
/**
 * ownerrez-weekly-calendar.js — Weekly booking calendar for the ops team
 *
 * Posts a bilingual (English + Spanish) summary of upcoming reservations
 * to the configured #reservations channel every Monday morning so the team
 * (especially Sergio) can plan maintenance around guest stays.
 *
 * Shows the next 4 weeks of active bookings, blocks, and holds by property.
 *
 * Usage:
 *   node ownerrez-weekly-calendar.js           # post to Slack
 *   node ownerrez-weekly-calendar.js --dry-run  # print only
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadPolicy } = require('../lib/channel-policy');
const { createApiGet } = require('./lib/ownerrez-api');
const {
  fetchFullOccupancy,
  isBlock,
  reservationDisplayName,
} = require('./lib/ownerrez-occupancy');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const CHANNEL = process.env.RESORT_RESERVATIONS_CHANNEL
  || Object.entries(loadPolicy().channels || {}).find(([, channel]) => channel.name === 'reservations')?.[0]
  || '';

const SECRETS = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
const TOKEN = SECRETS.access_token;

const DRY_RUN = process.argv.includes('--dry-run');

// ─── API ─────────────────────────────────────────────────────────────────────
const apiGet = createApiGet({ token: TOKEN });

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

  // Occupancy is intentionally independent from the CRM contact sync. This
  // includes guestless/manual reservations and every block/hold type.
  const upcoming = await fetchFullOccupancy(apiGet, { start, end });

  // Enrich only the records that actually have a guest link. Guestless items
  // remain in the calendar and use their local title/type as the label.
  const guestNames = {};
  for (const b of upcoming) {
    if (!b.guest_id) continue;
    const guestKey = String(b.guest_id);
    if (!guestNames[guestKey]) {
      try {
        const g = await apiGet(`guests/${b.guest_id}`);
        guestNames[guestKey] = [g.first_name, g.last_name].filter(Boolean).join(' ') || 'Guest';
      } catch { guestNames[guestKey] = 'Guest'; }
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
      `No upcoming reservations or blocks in the next 4 weeks.\n\n` +
      `🇲🇽 *Calendario Semanal de Reservaciones* (${formatDateEs(start)} — ${formatDateEs(end)})\n` +
      `No hay reservaciones ni bloqueos en las próximas 4 semanas.`;
    if (DRY_RUN) { console.log(msg); return; }
    slackSend(msg);
    return;
  }

  // Build English message
  let en = `📅 *Weekly Booking Calendar* (${formatDate(start)} — ${formatDate(end)})\n`;
  en += `${upcoming.length} upcoming reservation/block record(s):\n\n`;

  for (const [prop, bookings] of Object.entries(byProperty)) {
    en += `*${prop}*\n`;
    for (const b of bookings) {
      const guest = reservationDisplayName(b, guestNames);
      if (isBlock(b)) {
        en += `  • ${formatDate(b.arrival)} → ${formatDate(b.departure)} — ${guest} (blocks availability)\n`;
        continue;
      }
      const adults = b.adults || '?';
      const children = b.children || 0;
      const guestInfo = children > 0 ? `${adults}A + ${children}C` : `${adults} guests`;
      en += `  • ${formatDate(b.arrival)} → ${formatDate(b.departure)} — ${guest} (${guestInfo})\n`;
    }
    en += `\n`;
  }

  // Build Spanish message
  let es = `🇲🇽 *Calendario Semanal de Reservaciones* (${formatDateEs(start)} — ${formatDateEs(end)})\n`;
  es += `${upcoming.length} reservación(es)/bloqueo(s) próximo(s):\n\n`;

  for (const [prop, bookings] of Object.entries(byProperty)) {
    es += `*${prop}*\n`;
    for (const b of bookings) {
      const guest = reservationDisplayName(b, guestNames);
      if (isBlock(b)) {
        es += `  • ${formatDateEs(b.arrival)} → ${formatDateEs(b.departure)} — ${guest} (bloquea disponibilidad)\n`;
        continue;
      }
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
  console.log(`[weekly-calendar] Posted ${upcoming.length} occupancy records to #reservations`);
}

function slackSend(message) {
  if (!SLACK_ACCOUNT || !CHANNEL) throw new Error('Slack account and RESORT_RESERVATIONS_CHANNEL are required');
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
