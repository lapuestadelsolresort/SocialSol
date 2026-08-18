#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/squarespace-schema');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(ROOT, 'crm', 'data', 'crm.db'));
const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const AUDIENCES = {
  'business-intel': process.env.RESORT_BIZEVENT_CHANNEL || '',
  accounting: process.env.RESORT_ACCOUNTING_CHANNEL || '',
  reservations: process.env.RESORT_RESERVATIONS_CHANNEL || '',
  housekeeping: process.env.RESORT_HOUSEKEEPING_CHANNEL || '',
};

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function money(value, currency) {
  const parsed = Number(value || 0);
  return `${currency || 'USD'} ${parsed.toFixed(2)}`;
}

function audienceLine(audience, payload) {
  const dates = payload.start_date
    ? `${payload.start_date}${payload.end_date ? ` → ${payload.end_date}` : ''}`
    : 'dates pending';
  const ownerRez = payload.ownerrez_booking_id
    ? `OwnerRez ${payload.ownerrez_booking_id} (${payload.ownerrez_match_status})`
    : `OwnerRez ${payload.ownerrez_match_status || 'unmatched'}`;
  if (audience === 'reservations') {
    return `• ${payload.guest || 'Guest'} — ${dates}; ${payload.payment_state || 'payment unknown'}; ${ownerRez}`;
  }
  if (audience === 'housekeeping') {
    return `• ${payload.guest || 'Guest'} — ${dates}; ${money(payload.housekeeping_total, payload.housekeeping_currency)} housekeeping on order ${payload.order_number || payload.order_id}; ${ownerRez}`;
  }
  return `• Order ${payload.order_number || payload.order_id}: ${payload.guest || 'Guest'}, ${dates}, `
    + `${money(payload.grand_total, payload.currency)}, ${payload.payment_state || 'payment unknown'}, ${ownerRez}`;
}

function buildAudienceReport(db, audience, limit = 20) {
  const rows = db.prepare(`SELECT * FROM squarespace_notification_outbox
    WHERE audience=? AND status='pending' ORDER BY created_at LIMIT ?`).all(audience, limit);
  if (!rows.length) return null;
  const currentOrder = db.prepare(`SELECT o.currency, o.grand_total_value,
      l.ownerrez_booking_id, l.status AS ownerrez_match_status
    FROM squarespace_orders o
    LEFT JOIN squarespace_order_ownerrez_links l ON l.order_id=o.order_id
    WHERE o.order_id=?`);
  const housekeepingTotal = db.prepare(`SELECT currency,
      COALESCE(SUM(CAST(line_total_value AS REAL)),0) AS amount
    FROM squarespace_order_items
    WHERE order_id=? AND department='housekeeping'`);
  const payloads = rows.map(row => {
    const payload = JSON.parse(row.payload_json);
    const current = row.order_id ? currentOrder.get(row.order_id) : null;
    const housekeeping = row.order_id ? housekeepingTotal.get(row.order_id) : null;
    return {
      ...payload,
      ...(current || {}),
      housekeeping_total: Number(housekeeping?.amount || 0),
      housekeeping_currency: housekeeping?.currency || current?.currency || payload.currency,
    };
  });
  const title = {
    'business-intel': 'Squarespace direct-booking commerce update',
    accounting: 'Squarespace direct-booking financial update',
    reservations: 'Squarespace direct reservation payment update',
    housekeeping: 'Squarespace housekeeping order update',
  }[audience] || 'Squarespace update';
  const exceptions = db.prepare(`SELECT COUNT(*) AS n
    FROM squarespace_order_ownerrez_links WHERE status!='matched'`).get().n;
  const lines = [`*${title}*`, ...payloads.map(payload => audienceLine(audience, payload))];
  if (audience === 'business-intel' || audience === 'accounting') {
    lines.push(`_OwnerRez link exceptions awaiting review: ${exceptions}_`);
  }
  return { message: lines.join('\n'), ids: rows.map(row => row.id) };
}

function post(channel, message) {
  execFileSync(OPENCLAW, [
    'message', 'send', '--channel', 'slack', '--account', SLACK_ACCOUNT,
    '--target', `channel:${channel}`, '--message', message, '--json',
  ], { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(args = process.argv.slice(2), injected = {}) {
  const requested = optionValue(args, '--audience');
  const audiences = args.includes('--all') ? Object.keys(AUDIENCES) : [requested || 'business-intel'];
  const live = args.includes('--post');
  const enabled = process.env.SQUARESPACE_SLACK_ENABLED === '1';
  const postImpl = injected.post || post;
  // Preview mode only reads; only --post updates the notification outbox.
  // Opening write-capable for a preview took write locks and ran a schema
  // ensure on a read path (F-042).
  const db = injected.db || new Database(DB_PATH, live ? {} : { readonly: true });
  const ownsDb = !injected.db;
  try {
    if (live) ensureSchemaBetterSqlite(db);
    for (const audience of audiences) {
      if (!Object.hasOwn(AUDIENCES, audience)) throw new Error(`Unknown audience: ${audience}`);
      const report = buildAudienceReport(db, audience);
      if (!report) continue;
      if (!live) {
        console.log(`[${audience}]\n${report.message}\n`);
        continue;
      }
      if (!enabled) {
        console.log(`[squarespace-report] Slack disabled; pending ${audience} report retained`);
        continue;
      }
      const channel = AUDIENCES[audience];
      if (!channel || !SLACK_ACCOUNT) throw new Error(`Slack is not configured for ${audience}`);
      const placeholders = report.ids.map(() => '?').join(',');
      try {
        postImpl(channel, report.message);
      } catch (error) {
        // Only the success path wrote attempts/last_error, so a failed Slack
        // post left its evidence in job stderr alone: the rows stayed pending
        // with attempts=0 and nothing recorded why (F-043). Retry semantics
        // are unchanged — the rows stay pending and the run still fails.
        db.prepare(`UPDATE squarespace_notification_outbox SET
          attempts=attempts+1, last_error=?
          WHERE id IN (${placeholders})`).run(String(error.message).slice(0, 500), ...report.ids);
        throw error;
      }
      db.prepare(`UPDATE squarespace_notification_outbox SET
        status='delivered', delivered_at=datetime('now'), attempts=attempts+1, last_error=NULL
        WHERE id IN (${placeholders})`).run(...report.ids);
    }
  } finally {
    if (ownsDb) db.close();
  }
}

if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error(`[squarespace-report] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { audienceLine, buildAudienceReport, run };
