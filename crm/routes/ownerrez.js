/**
 * OwnerRez Webhook Receiver + Real-time CRM Sync
 *
 * Phase 1: Stores raw events in ownerrez_events table.
 * Phase 2: On booking/inquiry events, triggers immediate guest sync
 *          into contacts + leads, and notifies #business-intel.
 *
 * Responds within 2s as required by OwnerRez.
 */

const express = require('express');
const { sql } = require('@databases/sqlite');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR
  || path.join(REPO_ROOT, 'secrets');
const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const BIZ_CHANNEL = process.env.RESORT_BIZEVENT_CHANNEL || 'C0B384L2TNC';
const RESERVATIONS_CHANNEL = 'C067JQ1JWDS';

// Load webhook credentials
let WEBHOOK_USER = '';
let WEBHOOK_PASS = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
  WEBHOOK_USER = cfg.webhook_user || '';
  WEBHOOK_PASS = cfg.webhook_password || '';
  console.log('[ownerrez] Webhook auth loaded');
} catch (e) {
  console.warn('[ownerrez] WARNING: ownerrez.json not found — webhook endpoint will reject all requests');
}

// Basic Auth middleware
function requireBasicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user !== WEBHOOK_USER || pass !== WEBHOOK_PASS) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  next();
}

// Event types that trigger CRM sync
const SYNC_EVENT_TYPES = new Set([
  'booking_created', 'booking_updated', 'booking_confirmed',
  'inquiry_created', 'inquiry_updated',
  'guest_created', 'guest_updated',
  // OwnerRez may use different naming — catch broadly
  'booking', 'inquiry', 'guest',
]);

function shouldTriggerSync(eventType) {
  if (!eventType) return false;
  const lower = eventType.toLowerCase();
  return SYNC_EVENT_TYPES.has(lower)
    || lower.includes('booking')
    || lower.includes('inquiry')
    || lower.includes('guest');
}

/**
 * Fire-and-forget: run the sync script for a specific guest or a quick poll.
 * This runs AFTER we've already responded 200 to OwnerRez.
 */
function triggerBackgroundSync(event) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'ownerrez-sync.js');
  const args = [scriptPath];

  // If we can extract a guest_id, sync just that guest
  const guestId = event.guest_id || event.data?.guest_id;
  if (guestId) {
    args.push('--guest', String(guestId));
  } else {
    // Otherwise, quick poll from 1 hour ago
    const since = new Date(Date.now() - 3600000).toISOString();
    args.push('--since', since);
  }

  execFile('node', args, { timeout: 30000, cwd: REPO_ROOT }, (err, stdout, stderr) => {
    if (err) {
      console.error('[ownerrez] Background sync error:', err.message);
    } else {
      console.log('[ownerrez] Background sync:', stdout.trim());
    }
  });
}

function slackSend(channel, message) {
  if (!SLACK_ACCOUNT || !channel) return;
  execFile(OPENCLAW, [
    'message', 'send',
    '--account', SLACK_ACCOUNT,
    '--target', channel,
    '--message', message,
  ], { timeout: 10000 }, (err) => {
    if (err) console.warn('[ownerrez] Slack notify failed:', err.message);
  });
}

/**
 * Notify channels about significant events.
 * - #business-intel gets inquiries + bookings
 * - #reservations (C067JQ1JWDS) gets bookings only (bilingual)
 */
function notifyEvent(event) {
  const eventType = event.event_type || event.type || 'unknown';
  const lower = eventType.toLowerCase();

  if (lower.includes('booking') && lower.includes('creat')) {
    const guestName = event.guest?.name || event.data?.guest_name || '';
    const arrival = event.arrival || event.data?.arrival || '?';
    const departure = event.departure || event.data?.departure || '?';
    const property = event.property?.name || event.data?.property_name || '';
    const adults = event.adults || event.data?.adults || '?';
    const children = event.children || event.data?.children || 0;
    const guestCount = children > 0 ? `${adults} adults, ${children} children` : `${adults} guests`;

    // #business-intel — English
    slackSend(BIZ_CHANNEL,
      `📥 *New OwnerRez Booking* — ${guestName || 'a guest'}, ${property || 'property'}, ${arrival} → ${departure}`
    );

    // #reservations — bilingual for the team
    const enMsg = `🏨 *New Reservation*\n` +
      `${property ? `*Property:* ${property}\n` : ''}` +
      `*Check-in:* ${arrival} | *Check-out:* ${departure}\n` +
      `*Guests:* ${guestCount}` +
      `${guestName ? `\n*Guest:* ${guestName}` : ''}`;
    const esMsg = `\n\n🇲🇽 *Nueva Reservación*\n` +
      `${property ? `*Propiedad:* ${property}\n` : ''}` +
      `*Llegada:* ${arrival} | *Salida:* ${departure}\n` +
      `*Huéspedes:* ${guestCount}` +
      `${guestName ? `\n*Huésped:* ${guestName}` : ''}`;
    slackSend(RESERVATIONS_CHANNEL, enMsg + esMsg);
  } else if (lower.includes('inquiry') && lower.includes('creat')) {
    const site = event.listing_site || event.data?.listing_site || '?';
    slackSend(BIZ_CHANNEL, `💬 *New OwnerRez Inquiry* from ${site}`);
    // Inquiries do NOT go to #reservations per Jason's directive
  }
}

function buildRouter(getDb) {
  const router = express.Router();

  // POST /webhook — receive OwnerRez events
  router.post('/webhook', requireBasicAuth, async (req, res) => {
    const event = req.body;
    const receivedAt = new Date().toISOString();
    const eventType = event.event_type || event.type || 'unknown';

    // Respond immediately (OwnerRez needs < 2s response)
    try {
      const db = getDb();
      if (!db) throw new Error('DB not available');

      const payload = JSON.stringify(event);
      await db.query(sql`
        INSERT INTO ownerrez_events (event_type, payload, received_at, processed)
        VALUES (${eventType}, ${payload}, ${receivedAt}, 0)
      `);

      console.log(`[ownerrez] Event received: ${eventType} at ${receivedAt}`);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[ownerrez] Error storing event:', err.message);
      res.status(200).json({ ok: true, warning: 'stored with error' });
    }

    // Phase 2: Fire-and-forget background sync for relevant events
    if (shouldTriggerSync(eventType)) {
      setImmediate(() => {
        triggerBackgroundSync(event);
        notifyEvent(event);
      });
    }
  });

  // GET /health — quick check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ownerrez-webhook' });
  });

  return router;
}

module.exports = { buildRouter };
