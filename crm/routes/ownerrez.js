/**
 * OwnerRez webhook durability boundary.
 *
 * A webhook is acknowledged only after its exact payload and processing intent
 * are committed to SQLite. The workflow worker performs API/CRM work later;
 * no external side effect is hidden in a fire-and-forget callback.
 */
'use strict';

const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { sql } = require('@databases/sqlite');
const { SECRETS_DIR } = require('../../lib/runtime-paths');
const { stableJson, sha256 } = require('../lib/workflow-store');

function normalizeEventType(event) {
  if (!event || typeof event !== 'object') return 'unknown';
  if (event.event_type || event.type) return String(event.event_type || event.type).toLowerCase();
  const entityType = event.entity_type || (typeof event.entity === 'string' ? event.entity : null);
  const action = event.action;
  if (entityType && action) return `${String(entityType).toLowerCase()}_${String(action).toLowerCase()}`;
  if (entityType) return String(entityType).toLowerCase();
  return 'unknown';
}

function readCredentials() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
    return { user: parsed.webhook_user || '', pass: parsed.webhook_password || '' };
  } catch {
    return { user: '', pass: '' };
  }
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireBasicAuth(loadCredentials = readCredentials) {
  return (req, res, next) => {
    const expected = loadCredentials();
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Basic ') || !expected.user || !expected.pass) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    let user = '';
    let pass = '';
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      user = separator >= 0 ? decoded.slice(0, separator) : '';
      pass = separator >= 0 ? decoded.slice(separator + 1) : '';
    } catch {}
    if (!equalSecret(user, expected.user) || !equalSecret(pass, expected.pass)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    return next();
  };
}

function buildRouter(getDb, services = {}) {
  const router = express.Router();
  router.post('/webhook', requireBasicAuth(services.loadCredentials), async (req, res) => {
    const event = req.body;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return res.status(400).json({ error: 'OwnerRez event body must be an object' });
    }
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'database unavailable; retry webhook' });

    const payload = stableJson(event);
    const payloadHash = sha256(payload);
    const eventType = normalizeEventType(event);
    const receivedAt = new Date().toISOString();
    try {
      await db.query(sql`INSERT OR IGNORE INTO ownerrez_events
        (event_type, payload, payload_hash, received_at, processed, processing_status)
        VALUES (${eventType}, ${payload}, ${payloadHash}, ${receivedAt}, 0, 'pending')`);
      const [stored] = await db.query(sql`SELECT id, processing_status FROM ownerrez_events
        WHERE payload_hash=${payloadHash} LIMIT 1`);
      if (!stored) throw new Error('event insert had no durable readback');
      return res.status(200).json({ ok: true, accepted: true, duplicate: stored.processing_status !== 'pending' });
    } catch (error) {
      console.error('[ownerrez] durable event insert failed:', error.message);
      // A non-2xx response tells OwnerRez to retry. Claiming success here would
      // silently lose the event.
      return res.status(503).json({ error: 'event was not durably stored; retry webhook' });
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ status: getDb() ? 'ok' : 'degraded', service: 'ownerrez-webhook', durable: true });
  });
  return router;
}

module.exports = { buildRouter, equalSecret, normalizeEventType, requireBasicAuth };
