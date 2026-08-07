/**
 * La Puesta del Sol Resort — CRM & Marketing Funnel Tracker
 * Express + @databases/sqlite backend
 * http://localhost:3456
 */

const express = require('express');
const createDB = require('@databases/sqlite');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Webhook } = require('svix');
const rateLimit = require('express-rate-limit');
const { verifyCalSignature, verifyMetaSignature } = require('./lib/webhook-auth');
const { addSuppression } = require('./lib/suppressions');
const unsubscribeLib = require('./lib/unsubscribe');
const { postToChannel: slackPostToChannel } = require('../prospector/research/scripts/lib/slack');

const REPO_ROOT = path.resolve(__dirname, '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const SOCIAL_CHANNEL_ID = process.env.RESORT_SOCIAL_CHANNEL || '';

// ─── Chroma Vector DB ──────────────────────────────────────────────────────────
// Connection follows the canonical pattern in lib/chroma-connect.js:
//   - boot path retries with backoff (~39s) to absorb the launchd race where
//     the CRM starts before the Chroma daemon is ready
//   - /api/chroma/status falls back to a single-shot reconnect so the API
//     self-heals on the next request even if all boot retries failed
const { connectWithRetry, connectOnce } = require("./lib/chroma-connect");
const CHROMA_URL = "http://localhost:8000";
let chromaClient = null;
let chromaContacts = null;
let chromaVoiceCorpus = null;

async function initChroma({ retry = true } = {}) {
  try {
    chromaClient = retry
      ? await connectWithRetry({ url: CHROMA_URL, label: "chroma" })
      : await connectOnce({ url: CHROMA_URL });
    chromaContacts = await chromaClient.getOrCreateCollection({ name: "contacts" });
    chromaVoiceCorpus = await chromaClient.getOrCreateCollection({ name: "sarah_voice_corpus" });
    const chromaMediaCorpus = await chromaClient.getOrCreateCollection({ name: "media_corpus" });
    // Expose to mounted routers (e.g. routes/voice-draft.js, routes/media.js)
    // so they can reuse the boot-time handle instead of opening a second client.
    if (typeof app !== 'undefined' && app.locals) {
      app.locals.chromaClient = chromaClient;
      app.locals.chromaVoiceCorpus = chromaVoiceCorpus;
      app.locals.chromaMediaCorpus = chromaMediaCorpus;
    }
    console.log("[chroma] Connected — contacts + sarah_voice_corpus + media_corpus collections ready");
    return true;
  } catch (e) {
    console.warn("[chroma] Not available (set CHROMA_URL and start Chroma before the CRM):", e.message);
    chromaClient = null;
    chromaContacts = null;
    chromaVoiceCorpus = null;
    if (typeof app !== 'undefined' && app.locals) {
      app.locals.chromaClient = null;
      app.locals.chromaVoiceCorpus = null;
      app.locals.chromaMediaCorpus = null;
    }
    return false;
  }
}

// ─── Load Resend webhook secret ──────────────────────────────────────────────
const SECRETS_PATH = path.join(SECRETS_DIR, 'resend.json');
let RESEND_WEBHOOK_SECRET = null;
try {
  const resendConfig = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  RESEND_WEBHOOK_SECRET = resendConfig.webhook_secret;
  if (RESEND_WEBHOOK_SECRET) {
    console.log('[resend] Webhook signature verification ENABLED');
  } else {
    console.warn('[resend] WARNING: webhook_secret not found in resend.json — endpoint will fail closed');
  }
} catch (e) {
  console.warn('[resend] WARNING: Could not read resend.json — endpoint will fail closed:', e.message);
}

// ─── Load unsubscribe HMAC secret ────────────────────────────────────────────
// Warn-and-degrade: if the secret is missing, the server still boots but the
// /unsubscribe endpoint is fail-closed (every request returns the generic
// 400 page). Matches the Resend secret pattern above.
const UNSUB_SECRETS_PATH = path.join(SECRETS_DIR, 'unsubscribe.json');
try {
  const unsubConfig = JSON.parse(fs.readFileSync(UNSUB_SECRETS_PATH, 'utf8'));
  if (unsubConfig.secret) {
    unsubscribeLib.setSecret(unsubConfig.secret);
    console.log('[unsubscribe] HMAC signing key loaded — endpoint ARMED');
  } else {
    console.warn('[unsubscribe] WARNING: secret not found in unsubscribe.json — endpoint will fail-closed (every request returns 400)');
  }
} catch (e) {
  console.warn('[unsubscribe] WARNING: Could not read unsubscribe.json — endpoint will fail-closed:', e.message);
}

// ─── Load prospector channel config (for unsubscribe Slack notifications) ───
const PROSPECTOR_CONFIG_PATH = path.join(REPO_ROOT, 'prospector', 'config.json');
let PROSPECTOR_CHANNEL_ID = process.env.PROSPECTOR_SLACK_CHANNEL || null;
try {
  if (!PROSPECTOR_CHANNEL_ID) {
    const cfg = JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
    PROSPECTOR_CHANNEL_ID = cfg.channel_id || null;
  }
  if (!PROSPECTOR_CHANNEL_ID) {
    console.warn('[unsubscribe] WARNING: prospector/config.json has no channel_id — Slack pings on unsubscribe will be skipped');
  }
} catch (e) {
  console.warn('[unsubscribe] WARNING: Could not read prospector/config.json — Slack pings on unsubscribe will be skipped:', e.message);
}

const app = express();
// Trust the first proxy hop (Cloudflare Tunnel). Required for the
// /api/voice/draft localhost guard to read the real client IP via req.ip
// instead of the proxy's, and for express-rate-limit to key correctly.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3456;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'crm.db');

// ─── Ensure data directory exists ────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const { sql } = require('@databases/sqlite');

// ─── Database Setup (async init) ─────────────────────────────────────────────
let db;

async function initDB() {
  db = createDB(DB_PATH);

  await db.query(sql`PRAGMA journal_mode = WAL`);
  await db.query(sql`PRAGMA foreign_keys = ON`);

  async function addColumnIfMissing(table, spec) {
    try {
      await db.query(sql.__dangerous__rawValue(`ALTER TABLE ${table} ADD COLUMN ${spec}`));
    } catch (e) {
      if (!/duplicate column name/i.test(String(e && e.message))) {
        console.warn(`[db] could not add ${table}.${spec}:`, e.message);
      }
    }
  }

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS leads (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      name             TEXT,
      email            TEXT,
      phone            TEXT,
      source           TEXT    DEFAULT 'direct',
      campaign_name    TEXT,
      status           TEXT    NOT NULL DEFAULT 'new',
      notes            TEXT,
      utm_source       TEXT,
      utm_medium       TEXT,
      utm_campaign     TEXT,
      inquiry_message  TEXT,
      estimated_value  REAL    DEFAULT 0,
      checkin_date     TEXT,
      checkout_date    TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      event_type  TEXT    NOT NULL,
      source      TEXT,
      campaign    TEXT,
      meta        TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS campaigns (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      name             TEXT    NOT NULL,
      region           TEXT,
      offer            TEXT,
      target_audience  TEXT,
      budget_daily     REAL    DEFAULT 0,
      budget_total     REAL    DEFAULT 0,
      spend_actual     REAL    DEFAULT 0,
      status           TEXT    DEFAULT 'active',
      channel          TEXT    DEFAULT 'facebook_ad',
      start_date       TEXT,
      end_date         TEXT,
      meta_campaign_id TEXT,
      notes            TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS email_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      contact_id INTEGER REFERENCES contacts(id),
      outreach_send_id INTEGER REFERENCES outreach_sends(id),
      direction TEXT NOT NULL,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      resend_email_id TEXT,
      from_address TEXT,
      to_address TEXT,
      received_at TEXT,
      sentiment TEXT,
      sentiment_notes TEXT,
      forwarded_to TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lead_id INTEGER REFERENCES leads(id),
      contact_id INTEGER REFERENCES contacts(id),
      persona TEXT,
      status TEXT DEFAULT 'draft',
      title TEXT,
      drive_file_id TEXT,
      drive_url TEXT,
      photos_used TEXT,
      sent_at TEXT,
      viewed_at TEXT,
      expires_at TEXT,
      notes TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS visibility_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      audit_week TEXT NOT NULL,
      provider TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      response_text TEXT,
      we_appeared BOOLEAN DEFAULT 0,
      our_position INTEGER,
      competitors_mentioned TEXT,
      attributes_noted TEXT,
      score INTEGER,
      notes TEXT,
      UNIQUE(audit_week, provider, prompt_id)
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS attribution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT,
      lead_id INTEGER REFERENCES leads(id),
      contact_id INTEGER REFERENCES contacts(id),
      event_type TEXT NOT NULL,
      channel TEXT,
      campaign TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      landing_url TEXT,
      referrer TEXT,
      meta TEXT
    )
  `);

  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_leads_status      ON leads(status)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_leads_source      ON leads(source)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_leads_created_at  ON leads(created_at)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_events_type       ON events(event_type)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_campaigns_status  ON campaigns(status)`);

  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_email_threads_contact  ON email_threads(contact_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_email_threads_received ON email_threads(received_at)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_proposals_lead         ON proposals(lead_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_proposals_status       ON proposals(status)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_visibility_week        ON visibility_audits(audit_week)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_attr_session           ON attribution_events(session_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_attr_lead              ON attribution_events(lead_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_attr_event_type        ON attribution_events(event_type)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_attr_created           ON attribution_events(created_at)`);

  // Idempotency and delivery audit for verified server-side conversions.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS conversion_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      request_meta TEXT,
      response_meta TEXT,
      error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, event_id)
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_conversion_delivery_status ON conversion_deliveries(status, updated_at)`);

  // ─── Meta DM inbox ────────────────────────────────────────────────────────
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS meta_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      platform     TEXT    NOT NULL,
      sender_id    TEXT    NOT NULL,
      sender_name  TEXT,
      message_id   TEXT    UNIQUE,
      message_text TEXT,
      raw_payload  TEXT
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_meta_msg_received  ON meta_messages(received_at)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_meta_msg_sender    ON meta_messages(sender_id)`);

  // ─── Landing-page variant optimizer (WhatsApp-click funnel) ────────────────
  // Ported from GoldRoute, adapted: tenancy is page_slug (weddings|fitness|
  // retreats) instead of partner/store, and the conversion is a WhatsApp button
  // click (wa_click) instead of a form submit. Telemetry served cross-origin to
  // the Astro landing pages via the webhook subdomain.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS lp_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      page_slug TEXT NOT NULL,                    -- weddings | fitness | retreats
      language TEXT NOT NULL DEFAULT 'en',
      source TEXT,                                -- utm_source match, NULL = any
      audience TEXT,                              -- utm_content match, NULL = any
      status TEXT NOT NULL DEFAULT 'draft',       -- draft | live | paused | retired
      traffic_weight INTEGER NOT NULL DEFAULT 0,  -- 0..100 within match group
      config TEXT NOT NULL,                       -- JSON: hero/cta/social_proof/urgency
      created_by TEXT DEFAULT 'seed',
      approved_by TEXT,
      approved_at TEXT,
      retired_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await addColumnIfMissing('lp_variants', "experiment_id INTEGER");
  await addColumnIfMissing('lp_variants', "type TEXT DEFAULT 'landing_page'");
  await addColumnIfMissing('lp_variants', "is_control INTEGER DEFAULT 0");
  await addColumnIfMissing('lp_variants', "compliance_status TEXT DEFAULT 'unknown'");
  await addColumnIfMissing('lp_variants', "bucket TEXT DEFAULT 'leads'");
  await addColumnIfMissing('lp_variants', "funnel_stage TEXT DEFAULT 'cta'");
  await addColumnIfMissing('lp_variants', "meta_object_id TEXT");
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_lpv_status ON lp_variants(status)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_lpv_match  ON lp_variants(page_slug, language, source, audience)`);
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_lpv_slug ON lp_variants(slug)`);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS lp_assignments (
      session_id TEXT PRIMARY KEY,
      variant_id INTEGER NOT NULL REFERENCES lp_variants(id),
      assigned_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS page_sessions (
      id TEXT PRIMARY KEY,                         -- UUID minted client-side (LPDS_SID)
      created_at TEXT DEFAULT (datetime('now')),
      page_slug TEXT,                              -- weddings | fitness | retreats
      variant_id INTEGER REFERENCES lp_variants(id),
      lead_id INTEGER REFERENCES leads(id),
      language TEXT,
      ip_address TEXT,
      user_agent TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      device TEXT,                                 -- mobile | tablet | desktop
      viewport_w INTEGER,
      viewport_h INTEGER,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      dwell_ms INTEGER DEFAULT 0,
      max_scroll_pct INTEGER DEFAULT 0,
      reached_cta INTEGER DEFAULT 0,               -- a wa-cta entered viewport (cta_view)
      cta_clicked INTEGER DEFAULT 0,               -- wa_click fired
      abandoned_field TEXT,
      converted INTEGER DEFAULT 0                  -- verified inbound lead, not a button tap
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ps_variant ON page_sessions(variant_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ps_created ON page_sessions(created_at)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ps_page    ON page_sessions(page_slug)`);
  await addColumnIfMissing('page_sessions', 'whatsapp_ref TEXT');
  await addColumnIfMissing('page_sessions', 'is_bot INTEGER DEFAULT 0');
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ps_is_bot ON page_sessions(is_bot)`);
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_whatsapp_ref ON page_sessions(whatsapp_ref) WHERE whatsapp_ref IS NOT NULL`);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS page_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts TEXT DEFAULT (datetime('now')),
      kind TEXT NOT NULL,                          -- pageview|scroll|click|deadclick|rageclick|cta_view|heartbeat|visible|hidden|abandon|wa_click
      target TEXT,
      value_meta TEXT
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_pe_session ON page_events(session_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_pe_kind    ON page_events(kind)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_pe_ts      ON page_events(ts)`);

  // Experiments ledger. Every live LP or paid-campaign change must link to an
  // observable metric. UTM-linked rows can pin a campaign to a live variant.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      kind TEXT,
      bucket TEXT,
      funnel_stage TEXT,
      blast_radius TEXT DEFAULT 'low',
      hypothesis TEXT,
      rationale TEXT,
      change_made TEXT,
      primary_metric TEXT NOT NULL,
      guardrail_metrics TEXT,
      baseline_value TEXT,
      target_value TEXT,
      observation_window TEXT,
      review_at TEXT,
      linked_variant_slug TEXT,
      linked_campaign_id TEXT,
      linked_utm_campaign TEXT,
      result TEXT,
      conclusion TEXT,
      source TEXT DEFAULT 'operator',
      created_by TEXT DEFAULT 'sol',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      concluded_at TEXT
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_exp_status  ON experiments(status)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_exp_variant ON experiments(linked_variant_slug)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_exp_utm     ON experiments(linked_utm_campaign)`);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS optimizer_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS bandit_arms (
      arm_id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      bucket TEXT NOT NULL,
      metric TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1.0,
      beta REAL NOT NULL DEFAULT 1.0,
      n_qualified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_arms_bucket ON bandit_arms(bucket)`);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      pass_id TEXT,
      actor TEXT DEFAULT 'optimizer',
      action TEXT NOT NULL,
      target_kind TEXT,
      target_id TEXT,
      before TEXT,
      after TEXT,
      rationale TEXT
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_decisions_pass    ON decisions(pass_id)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at)`);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS budget_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      bucket TEXT NOT NULL,
      variant_id INTEGER,
      meta_object_id TEXT,
      planned_spend REAL DEFAULT 0,
      actual_spend REAL DEFAULT 0,
      sessions INTEGER DEFAULT 0,
      qualified_sessions INTEGER DEFAULT 0,
      cta_views INTEGER DEFAULT 0,
      cta_clicks INTEGER DEFAULT 0,
      leads INTEGER DEFAULT 0,
      bookings INTEGER DEFAULT 0,
      reconciled_at TEXT
    )
  `);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ledger_date   ON budget_ledger(date)`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ledger_bucket ON budget_ledger(bucket)`);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS optimizer_compliance_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      draft_id TEXT,
      channel TEXT,
      failed_check TEXT,
      details TEXT,
      source TEXT DEFAULT 'agent_generated'
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS meta_smoke_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT
    )
  `);

  // Never auto-seed fake data — real leads only
  // (seedData() removed from auto-init)
}

async function logEvent(type, source = null, campaign = null, meta = null) {
  await db.query(sql`
    INSERT INTO events (event_type, source, campaign, meta)
    VALUES (${type}, ${source}, ${campaign}, ${meta ? JSON.stringify(meta) : null})
  `);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
function captureRawBody(req, res, buf) {
  if (buf && buf.length) req.rawBody = Buffer.from(buf);
}

app.use(express.json({ limit: '128kb', verify: captureRawBody }));
app.use(express.urlencoded({
  extended: true,
  limit: '64kb',
  parameterLimit: 200,
  verify: captureRawBody,
}));
// Fallback: parse text/plain bodies as JSON (sendBeacon without Blob sends text/plain)
app.use((req, res, next) => {
  if (req.is('text/plain') && !req.body) {
    let raw = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 64 * 1024) raw += chunk;
    });
    req.on('end', () => {
      if (bytes > 64 * 1024) return res.status(413).json({ error: 'payload too large' });
      req.rawBody = Buffer.from(raw, 'utf8');
      try { req.body = JSON.parse(raw); } catch (e) { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

const ALLOWED_BROWSER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?lapuestadelsolresort\.com$/i;
const ALLOWED_DEV_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

function browserSourceAllowed(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  if (origin && (ALLOWED_BROWSER_ORIGIN.test(origin) || ALLOWED_DEV_ORIGIN.test(origin))) return true;
  if (!origin && referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return ALLOWED_BROWSER_ORIGIN.test(refOrigin) || ALLOWED_DEV_ORIGIN.test(refOrigin);
    } catch (_) { return false; }
  }
  return false;
}

function requireBrowserSource(req, res, next) {
  if (req.internalApiAuthorized) return next();
  const ip = req.ip || req.socket?.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (loopback || browserSourceAllowed(req)) return next();
  return res.status(403).json({ error: 'origin not allowed' });
}

function requireLoopback(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'local access only' });
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  const origin = String(req.headers.origin || '');
  if (origin && (ALLOWED_BROWSER_ORIGIN.test(origin) || ALLOWED_DEV_ORIGIN.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    if (browserSourceAllowed(req)) return res.sendStatus(204);
    return res.status(403).json({ error: 'origin not allowed' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  },
}));

// ─── Internal API guard ──────────────────────────────────────────────────────
// Default deny for remote /api/* routes. Only browser telemetry and LP config
// are public; every other API is local-only unless Basic auth is configured.
const { guardProtected } = require('./lib/api-auth');
app.use(guardProtected);

// ─── Health Check ───────────────────────────────────────────────────────────────
app.get('/healthz', async (req, res) => {
  try {
    if (!db) throw new Error('database not initialized');
    await db.query(sql`SELECT 1`);
    res.json({ ok: true, db: true, ts: Date.now() });
  } catch (_) {
    res.status(503).json({ ok: false, db: false, ts: Date.now() });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const VALID_SOURCES  = ['meta_ad', 'facebook_ad', 'instagram_ad', 'organic_instagram', 'organic', 'direct', 'referral', 'whatsapp'];
const VALID_STATUSES = ['new', 'contacted', 'quote_sent', 'booked', 'lost'];

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function sanitizeLead(body) {
  return {
    name:            cleanText(body.name, 200),
    email:           cleanText(body.email, 320),
    phone:           cleanText(body.phone, 40),
    source:          VALID_SOURCES.includes(body.source) ? body.source : 'direct',
    campaign_name:   cleanText(body.campaign_name || body.utm_campaign, 200),
    status:          VALID_STATUSES.includes(body.status) ? body.status : 'new',
    notes:           cleanText(body.notes, 4000),
    utm_source:      cleanText(body.utm_source, 120),
    utm_medium:      cleanText(body.utm_medium, 120),
    utm_campaign:    cleanText(body.utm_campaign, 200),
    inquiry_message: cleanText(body.inquiry_message || body.message, 4000),
    estimated_value: parseFloat(body.estimated_value) || 0,
    checkin_date:    cleanText(body.checkin_date, 32),
    checkout_date:   cleanText(body.checkout_date, 32),
  };
}

// ─── Webhook Endpoints ────────────────────────────────────────────────────────

// Forward-only status ordering for outreach_sends
const STATUS_ORDER = {
  drafted: 0, pending_approval: 1, approved: 2, scheduled: 3,
  sent: 4, delivered: 5, opened: 6, clicked: 7, replied: 8,
  // Terminal states (high number so they never get overwritten)
  bounced: 99, complained: 100, cancelled: 101
};

function canTransition(currentStatus, newStatus) {
  const current = STATUS_ORDER[currentStatus];
  const next = STATUS_ORDER[newStatus];
  if (current === undefined || next === undefined) return false;
  // Terminal states can't be overwritten
  if (current >= 99) return false;
  return next > current;
}

// Webhook orphan log (warmup-era sends that predate outreach_sends)
const ORPHAN_LOG = path.join(__dirname, '..', 'prospector', 'webhook_orphans.jsonl');

// Step 3.3: rolling-window threshold check helper. Closure over the live db
// + sql so the bounce/complaint case blocks can call it after each event.
// Imported lazily so the dev loop survives the prospector dir not being
// installed yet (e.g., fresh checkout, tests).
let _checkThresholdsAndMaybePause = null;
function loadThresholdChecker() {
  if (_checkThresholdsAndMaybePause) return _checkThresholdsAndMaybePause;
  // eslint-disable-next-line global-require
  _checkThresholdsAndMaybePause = require('../prospector/lib/threshold-pause').checkThresholdsAndMaybePause;
  return _checkThresholdsAndMaybePause;
}

app.post('/webhook/resend', express.json(), async (req, res) => {
  const event = req.body || {};
  const now = new Date().toISOString();
  console.log('[resend webhook]', now, event.type, event.data?.email_id || 'no-id');

  // Threshold checker is a closure binding the per-request db + sql + helpers.
  // Defined here so both bounce and complaint case blocks call the same wrapper.
  const runThresholdCheck = async () => {
    try {
      const checkFn = loadThresholdChecker();
      const config = JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
      const result = await checkFn(db, sql, config, {
        slackPost: async (msg) => {
          if (PROSPECTOR_CHANNEL_ID) {
            await slackPostToChannel('channel:' + PROSPECTOR_CHANNEL_ID, msg);
          }
        },
        healthcheckFail: () => {
          let url;
          try {
            const hc = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'healthchecks.json'), 'utf8'));
            const id = hc.checks?.['orchestrator-autopause'];
            if (!hc.base_url || !id) {
              console.warn(`[resend webhook] healthcheck 'orchestrator-autopause' not configured, skipping fail ping`);
              return;
            }
            url = `${hc.base_url}/${id}/fail`;
          } catch (e) {
            console.warn(`[resend webhook] healthcheck config read failed: ${e.message}`);
            return;
          }
          // Synchronous — block until ping lands or 5s timeout.
          // Matches orchestrator.js pingHealthcheck pattern.
          try {
            execFileSync('/usr/bin/curl', ['-fsS', '--max-time', '5', url], {
              stdio: 'ignore',
              timeout: 6000,
            });
          } catch { /* ping failure is non-fatal */ }
        },
      }, {
        statePath: path.join(__dirname, '..', 'prospector', 'state.json'),
      });
      if (result.tripped) {
        console.log(`[resend webhook] AUTO-PAUSED (${result.paused_by}): ${result.reason}`);
      }
    } catch (e) {
      console.error('[resend webhook] threshold check failed (non-fatal):', e.message);
    }
  };

  // ─── Step 1: Signature verification ───────────────────────────────
  if (!RESEND_WEBHOOK_SECRET || !Buffer.isBuffer(req.rawBody)) {
    console.error('[resend webhook] Signature verification unavailable');
    return res.status(503).json({ error: 'Webhook verification unavailable' });
  }
  try {
    const wh = new Webhook(RESEND_WEBHOOK_SECRET);
    wh.verify(req.rawBody.toString('utf8'), {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch (err) {
    console.error('[resend webhook] Signature verification FAILED:', err.message);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // ─── Step 2: Write to warmup events log (preserve existing behavior) ───
  const emailId = event.data?.email_id || null;
  if (emailId) {
    const eventsPath = path.join(__dirname, '..', 'warmup', 'events.jsonl');
    const logLine = JSON.stringify({
      ts: now,
      type: event.type,
      email_id: emailId,
      data: event.data
    }) + '\n';
    try { fs.appendFileSync(eventsPath, logLine); } catch (e) { /* warmup dir may not exist yet */ }
  }

  // ─── Step 3: Update outreach_sends based on event type ───────────────
  if (emailId && db) {
    try {
      const sends = await db.query(sql`SELECT * FROM outreach_sends WHERE resend_email_id = ${emailId}`);

      if (sends.length === 0) {
        // Orphan: warmup-era or manually-sent email, not in outreach_sends
        const orphanLine = JSON.stringify({ ts: now, type: event.type, email_id: emailId }) + '\n';
        try { fs.mkdirSync(path.dirname(ORPHAN_LOG), { recursive: true }); } catch (e) {}
        try { fs.appendFileSync(ORPHAN_LOG, orphanLine); } catch (e) {}
      } else {
        const send = sends[0];

        switch (event.type) {
          case 'email.sent': {
            if (canTransition(send.status, 'sent')) {
              await db.query(sql`UPDATE outreach_sends SET status = 'sent', sent_at = ${now} WHERE id = ${send.id}`);
              console.log(`[resend webhook] Send #${send.id} → sent`);
            }
            break;
          }

          case 'email.delivered': {
            if (canTransition(send.status, 'delivered')) {
              await db.query(sql`UPDATE outreach_sends SET status = 'delivered', delivered_at = ${now} WHERE id = ${send.id}`);
              console.log(`[resend webhook] Send #${send.id} → delivered`);
            }
            break;
          }

          case 'email.opened': {
            if (canTransition(send.status, 'opened')) {
              await db.query(sql`UPDATE outreach_sends SET status = 'opened', opened_at = ${now} WHERE id = ${send.id}`);
              console.log(`[resend webhook] Send #${send.id} → opened`);
            } else if (!send.opened_at) {
              // Already at a higher status but first open timestamp not recorded
              await db.query(sql`UPDATE outreach_sends SET opened_at = ${now} WHERE id = ${send.id}`);
            }
            // Ignore subsequent opens (only record first)
            break;
          }

          case 'email.clicked': {
            if (canTransition(send.status, 'clicked')) {
              await db.query(sql`UPDATE outreach_sends SET status = 'clicked', clicked_at = ${now} WHERE id = ${send.id}`);
              console.log(`[resend webhook] Send #${send.id} → clicked`);
            } else if (!send.clicked_at) {
              await db.query(sql`UPDATE outreach_sends SET clicked_at = ${now} WHERE id = ${send.id}`);
            }
            break;
          }

          case 'email.bounced': {
            // Bounced is terminal — always apply (overrides everything except other terminals)
            if (send.status !== 'bounced' && send.status !== 'complained') {
              await db.query(sql`UPDATE outreach_sends SET status = 'bounced', bounced_at = ${now} WHERE id = ${send.id}`);
              console.log(`[resend webhook] Send #${send.id} → bounced (TERMINAL)`);

              // Suppress the contact
              const [contact] = await db.query(sql`SELECT email FROM contacts WHERE id = ${send.contact_id}`);
              if (contact && contact.email) {
                await addSuppression(db, {
                  email: contact.email,
                  reason: 'bounce',
                  source: 'resend_webhook',
                  addedBy: 'system_webhook',
                  cascadeContactId: send.contact_id,
                });
                console.log(`[resend webhook] Contact #${send.contact_id} (${contact.email}) → suppressed (bounce)`);
              }

              // Step 3.3: rolling-window threshold check after each bounce.
              await runThresholdCheck();
            }
            break;
          }

          case 'email.complained': {
            // Complained is terminal — highest priority
            if (send.status !== 'complained') {
              await db.query(sql`UPDATE outreach_sends SET status = 'complained', complained_at = ${now} WHERE id = ${send.id}`);
              console.log(`[resend webhook] Send #${send.id} → complained (TERMINAL)`);

              // Suppress the contact
              const [contact] = await db.query(sql`SELECT email FROM contacts WHERE id = ${send.contact_id}`);
              if (contact && contact.email) {
                await addSuppression(db, {
                  email: contact.email,
                  reason: 'complaint',
                  source: 'resend_webhook',
                  addedBy: 'system_webhook',
                  cascadeContactId: send.contact_id,
                });
                console.log(`[resend webhook] Contact #${send.contact_id} (${contact.email}) → suppressed (complaint)`);
              }

              // Step 3.3: rolling-window threshold check after each complaint.
              await runThresholdCheck();
            }
            break;
          }

          case 'email.delivery_delayed': {
            // Log only, don't change status
            console.log(`[resend webhook] Send #${send.id} delivery delayed`);
            break;
          }

          default: {
            // Handle unsubscribe (may arrive as 'email.unsubscribed' or similar)
            if (event.type && event.type.includes('unsubscrib')) {
              if (!send.unsubscribe_detected_at) {
                await db.query(sql`UPDATE outreach_sends SET unsubscribe_detected_at = ${now} WHERE id = ${send.id}`);
                console.log(`[resend webhook] Send #${send.id} → unsubscribe detected`);
              }

              // Suppress the contact
              const [contact] = await db.query(sql`SELECT email FROM contacts WHERE id = ${send.contact_id}`);
              if (contact && contact.email) {
                await addSuppression(db, {
                  email: contact.email,
                  reason: 'unsubscribe_link',
                  source: 'resend_webhook',
                  addedBy: 'system_webhook',
                  cascadeContactId: send.contact_id,
                });
                console.log(`[resend webhook] Contact #${send.contact_id} (${contact.email}) → suppressed (unsubscribe)`);
              }
            } else {
              console.log(`[resend webhook] Unknown event type: ${event.type}`);
            }
            break;
          }
        }
      }
    } catch (dbErr) {
      console.error('[resend webhook] DB error processing event:', dbErr.message);
      // Don't fail the webhook response — Resend will retry
    }
  }

  // Always log the raw event to events table for audit trail
  try {
    await logEvent('resend_webhook', event.type || 'unknown', null, { email_id: emailId, event_type: event.type });
  } catch (e) { /* non-blocking */ }

  res.status(200).json({ received: true });
});

// ─── Public Unsubscribe Endpoint (RFC 8058 one-click + body link) ────────────
//
// Hit by:
//   - Recipients clicking the unsubscribe link in an outbound email body (GET)
//   - Gmail/Yahoo's one-click unsubscribe infrastructure (POST with body
//     "List-Unsubscribe=One-Click" — body content not validated; token is
//     the auth)
//   - Mail security scanners pre-fetching URLs (GET). Yes, this can
//     accidentally unsubscribe the recipient. That's the correct compliance
//     posture per Gmail/Yahoo bulk-sender guidelines: false positives are
//     vastly preferable to false negatives.
//
// Token format: {contactId}.{campaignName}.{base64url_hmac}
// See crm/lib/unsubscribe.js for generation/verification.

const unsubLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests',
});

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Unsubscribed</title><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 0 1rem;">
  <h1>You've been unsubscribed.</h1>
  <p>We won't send you any more outreach from La Puesta del Sol. Sorry for the noise.</p>
  <p style="color: #666; font-size: 0.9em;">If this was a mistake, reply to any past message and we'll add you back.</p>
</body>
</html>`;

const ALREADY_HTML = `<!DOCTYPE html>
<html>
<head><title>Already unsubscribed</title><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 0 1rem;">
  <h1>You're already unsubscribed.</h1>
  <p>You won't receive any more outreach from La Puesta del Sol.</p>
</body>
</html>`;

const INVALID_HTML = `<!DOCTYPE html>
<html>
<head><title>Invalid link</title><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 0 1rem;">
  <h1>This unsubscribe link is invalid or expired.</h1>
  <p>If you'd like to stop receiving messages, reply to any past email from us with "unsubscribe" and we'll remove you manually.</p>
</body>
</html>`;

async function handleUnsubscribe(req, res, asJson) {
  const token = (req.query && req.query.token) || (req.body && req.body.token) || '';
  const tokenHash = unsubscribeLib.tokenHashForLog(token);

  const sendInvalid = (logMsg) => {
    console.warn(`[unsubscribe] invalid (${tokenHash}): ${logMsg}`);
    if (asJson) return res.status(400).json({ ok: false, error: 'invalid_token' });
    return res.status(400).type('html').send(INVALID_HTML);
  };

  const verified = unsubscribeLib.verifyUnsubscribeToken(token);
  if (!verified.valid) return sendInvalid('verify failed or no secret loaded');

  if (!db) return sendInvalid('db not ready');

  try {
    const [contact] = await db.query(sql`SELECT id, email FROM contacts WHERE id = ${verified.contactId}`);
    if (!contact || !contact.email) {
      return sendInvalid(`no contact id=${verified.contactId}`);
    }

    const result = await addSuppression(db, {
      email: contact.email,
      reason: 'unsubscribe_link',
      source: 'unsubscribe_link',
      addedBy: 'system',
      notes: `via /unsubscribe (campaign=${verified.campaignName})`,
    });

    console.log(`[unsubscribe] contact #${verified.contactId} (${contact.email}) ${result.alreadyExisted ? 'already-suppressed' : 'newly-suppressed'} — campaign=${verified.campaignName} hash=${tokenHash}`);

    // Slack ping on first-time suppression only.
    if (!result.alreadyExisted && PROSPECTOR_CHANNEL_ID) {
      const message = `🚫 Unsubscribe: ${contact.email} from \`${verified.campaignName}\` (contact #${verified.contactId})`;
      slackPostToChannel('channel:' + PROSPECTOR_CHANNEL_ID, message)
        .then((r) => {
          if (!r.ok) console.warn(`[unsubscribe] slack post failed: ${r.error || ''} ${r.stderr || ''}`);
        });
    }

    if (asJson) return res.status(200).json({ ok: true, alreadyExisted: result.alreadyExisted });
    return res.status(200).type('html').send(result.alreadyExisted ? ALREADY_HTML : SUCCESS_HTML);
  } catch (err) {
    console.error('[unsubscribe] error:', err.message);
    return sendInvalid('server error');
  }
}

app.get('/unsubscribe', unsubLimiter, (req, res) => handleUnsubscribe(req, res, false));
app.post('/unsubscribe', unsubLimiter, express.urlencoded({ extended: false }), express.json(), (req, res) => handleUnsubscribe(req, res, true));

// ─── Cal.com Booking Webhook ─────────────────────────────────────────────────
const CALCOM_SECRETS_PATH = path.join(SECRETS_DIR, 'calcom.json');

function loadCalcomSecrets() {
  try { return JSON.parse(fs.readFileSync(CALCOM_SECRETS_PATH, 'utf8')); }
  catch { return {}; }
}

app.post("/webhook/calcom", async (req, res) => {
  const calSecret = loadCalcomSecrets().webhook_secret;
  if (!calSecret || !Buffer.isBuffer(req.rawBody)) {
    return res.status(503).json({ error: 'Webhook verification unavailable' });
  }
  if (!verifyCalSignature(req.rawBody, calSecret, req.headers['x-cal-signature-256'])) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body || {};
  console.log("[calcom webhook]", new Date().toISOString(), event.triggerEvent || "unknown");

  if (event.triggerEvent !== "BOOKING_CREATED") {
    return res.status(200).json({ received: true, skipped: true });
  }

  const payload = event.payload || {};
  const attendee = (payload.attendees || [])[0] || {};

  const name = attendee.name || payload.title || null;
  const email = attendee.email || null;
  const notes = `Cal.com booking: ${payload.title || "Discovery call"} on ${payload.startTime || "unknown time"}`;
  const source = "direct";

  if (!db) return res.status(503).json({ error: "DB not ready" });

  try {
    await db.query(sql`
      INSERT INTO leads (name, email, source, status, notes, utm_source, utm_medium, utm_campaign)
      VALUES (${name}, ${email}, ${source}, "new", ${notes}, "calcom", "booking", "discovery_call")
    `);
    const [{ id: newLeadId }] = await db.query(sql`SELECT last_insert_rowid() as id`);

    // Log attribution event
    await db.query(sql`
      INSERT INTO attribution_events (event_type, channel, campaign, lead_id, meta)
      VALUES ("calcom_booking", "direct", "discovery_call", ${newLeadId || null}, ${JSON.stringify({ title: payload.title, startTime: payload.startTime, attendee: attendee.email })})
    `);

    // Slack notification
    const slackMsg = `📅 *New Cal.com booking*\n• Name: ${name || "unknown"}\n• Email: ${email || "unknown"}\n• ${notes}`;
    if (SOCIAL_CHANNEL_ID && SLACK_ACCOUNT) {
      try {
        execFileSync(OPENCLAW_BIN, [
          'send', 'slack', SLACK_ACCOUNT,
          '--target', `channel:${SOCIAL_CHANNEL_ID}`,
          slackMsg,
        ], { timeout: 5000, stdio: 'ignore' });
      } catch (e) {
        console.warn("[calcom webhook] Slack notification failed:", e.message);
      }
    }

    res.status(200).json({ received: true, lead_id: newLeadId });
  } catch (err) {
    console.error("[calcom webhook] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook/attribution", requireLoopback, async (req, res) => {
  const body = req.body || {};
  try {
    await db.query(sql`
      INSERT INTO attribution_events (session_id, lead_id, contact_id, event_type, channel, campaign, utm_source, utm_medium, utm_campaign, landing_url, referrer, meta)
      VALUES (${body.session_id || null}, ${body.lead_id || null}, ${body.contact_id || null}, ${body.event_type || "page_view"}, ${body.channel || null}, ${body.campaign || null}, ${body.utm_source || null}, ${body.utm_medium || null}, ${body.utm_campaign || null}, ${body.landing_url || null}, ${body.referrer || null}, ${body.meta ? JSON.stringify(body.meta) : null})
    `);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[attribution webhook] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const inquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/webhook/inquiry', requireBrowserSource, inquiryLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const formData = body.formData || body.data || body;
    const lead = sanitizeLead({
      name:            formData.name || [formData.firstName, formData.lastName].filter(Boolean).join(' ') || null,
      email:           formData.email,
      phone:           formData.phone,
      source:          body.source || formData.source || 'direct',
      campaign_name:   body.campaign_name || formData.campaign_name,
      utm_source:      body.utm_source || formData.utm_source,
      utm_medium:      body.utm_medium || formData.utm_medium,
      utm_campaign:    body.utm_campaign || formData.utm_campaign,
      inquiry_message: formData.message || formData.inquiry_message || formData.comments,
      estimated_value: formData.estimated_value || 0,
      checkin_date:    formData.checkin_date || formData.checkIn || formData['check-in'],
      checkout_date:   formData.checkout_date || formData.checkOut || formData['check-out'],
    });
    if (!lead.name && !lead.email && !lead.phone && !lead.inquiry_message) {
      return res.status(400).json({ error: 'contact details or message required' });
    }
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
      return res.status(400).json({ error: 'invalid email' });
    }

    const [inserted] = await db.query(sql`
      INSERT INTO leads (name, email, phone, source, campaign_name, status,
        utm_source, utm_medium, utm_campaign, inquiry_message,
        estimated_value, checkin_date, checkout_date)
      VALUES (${lead.name}, ${lead.email}, ${lead.phone}, ${lead.source}, ${lead.campaign_name}, 'new',
        ${lead.utm_source}, ${lead.utm_medium}, ${lead.utm_campaign}, ${lead.inquiry_message},
        ${lead.estimated_value}, ${lead.checkin_date}, ${lead.checkout_date})
    `);

    const [newLead] = await db.query(sql`SELECT * FROM leads ORDER BY id DESC LIMIT 1`);
    await logEvent('form_submission', lead.source, lead.campaign_name, { lead_id: newLead.id });
    console.log(`[webhook] New lead #${newLead.id} from ${lead.source} — ${lead.name || lead.email}`);
    res.json({ success: true, lead_id: newLead.id });
  } catch (err) {
    console.error('[webhook] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const pixelLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });
app.get('/webhook/pixel', requireBrowserSource, pixelLimiter, async (req, res) => {
  const event = cleanText(req.query.event || 'click', 40);
  const source = cleanText(req.query.source, 120);
  const campaign = cleanText(req.query.campaign, 200);
  const medium = cleanText(req.query.medium, 120);
  await logEvent(event, source, campaign, { medium });
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL_GIF.length,
    'Cache-Control': 'no-store',
  });
  res.end(PIXEL_GIF);
});

// ─── API: Leads ───────────────────────────────────────────────────────────────

app.get('/api/leads', async (req, res) => {
  try {
    const { status, source, search, limit = 200, offset = 0, sort = 'created_at', order = 'desc' } = req.query;
    const leads = await db.query(sql`SELECT * FROM leads ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`);
    const [{ n: total }] = await db.query(sql`SELECT COUNT(*) as n FROM leads`);
    res.json({ leads, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const lead = sanitizeLead(req.body);
    await db.query(sql`
      INSERT INTO leads (name, email, phone, source, campaign_name, status, notes,
        utm_source, utm_medium, utm_campaign, inquiry_message, estimated_value, checkin_date, checkout_date)
      VALUES (${lead.name}, ${lead.email}, ${lead.phone}, ${lead.source}, ${lead.campaign_name}, ${lead.status}, ${lead.notes},
        ${lead.utm_source}, ${lead.utm_medium}, ${lead.utm_campaign}, ${lead.inquiry_message},
        ${lead.estimated_value}, ${lead.checkin_date}, ${lead.checkout_date})
    `);
    const [created] = await db.query(sql`SELECT * FROM leads ORDER BY id DESC LIMIT 1`);
    await logEvent('manual_entry', lead.source, lead.campaign_name, { lead_id: created.id });
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await db.query(sql`SELECT * FROM leads WHERE id = ${parseInt(id)}`);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const b = req.body;
    await db.query(sql`
      UPDATE leads SET
        name = ${b.name !== undefined ? b.name : existing.name},
        email = ${b.email !== undefined ? b.email : existing.email},
        phone = ${b.phone !== undefined ? b.phone : existing.phone},
        source = ${b.source !== undefined ? b.source : existing.source},
        campaign_name = ${b.campaign_name !== undefined ? b.campaign_name : existing.campaign_name},
        status = ${b.status !== undefined ? b.status : existing.status},
        notes = ${b.notes !== undefined ? b.notes : existing.notes},
        inquiry_message = ${b.inquiry_message !== undefined ? b.inquiry_message : existing.inquiry_message},
        estimated_value = ${b.estimated_value !== undefined ? parseFloat(b.estimated_value) : existing.estimated_value},
        checkin_date = ${b.checkin_date !== undefined ? b.checkin_date : existing.checkin_date},
        checkout_date = ${b.checkout_date !== undefined ? b.checkout_date : existing.checkout_date},
        updated_at = datetime('now')
      WHERE id = ${parseInt(id)}
    `);

    if (b.status && b.status !== existing.status) {
      await logEvent('status_change', existing.source, existing.campaign_name,
        { lead_id: id, from: existing.status, to: b.status });
    }

    const [updated] = await db.query(sql`SELECT * FROM leads WHERE id = ${parseInt(id)}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await db.query(sql`DELETE FROM leads WHERE id = ${parseInt(req.params.id)}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Stats ───────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [{ n: total_leads }]      = await db.query(sql`SELECT COUNT(*) n FROM leads`);
    const [{ n: leads_this_month }] = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE created_at LIKE ${month + '%'}`);
    const [{ n: total_booked }]     = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE status = 'booked'`);
    const [{ n: booked_month }]     = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE status='booked' AND created_at LIKE ${month + '%'}`);
    const [{ v: pipeline_value }]   = await db.query(sql`SELECT COALESCE(SUM(estimated_value),0) v FROM leads WHERE status NOT IN ('lost')`);
    const [{ v: booked_value }]     = await db.query(sql`SELECT COALESCE(SUM(estimated_value),0) v FROM leads WHERE status = 'booked'`);
    const conversion_rate = total_leads > 0 ? ((total_booked / total_leads) * 100).toFixed(1) : '0.0';

    const by_status      = await db.query(sql`SELECT status, COUNT(*) n FROM leads GROUP BY status`);
    const by_source      = await db.query(sql`SELECT source, COUNT(*) n, COALESCE(SUM(estimated_value),0) value FROM leads GROUP BY source`);
    const recent_events  = await db.query(sql`SELECT * FROM events ORDER BY created_at DESC LIMIT 20`);

    res.json({ total_leads, leads_this_month, total_booked, booked_month, pipeline_value, booked_value, conversion_rate, by_status, by_source, recent_events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Email Threads ───────────────────────────────────────────────────────
app.get("/api/email-threads", async (req, res) => {
  const contactId = req.query.contact_id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const rows = contactId
      ? await db.query(sql`SELECT * FROM email_threads WHERE contact_id = ${parseInt(contactId)} ORDER BY received_at DESC LIMIT ${limit}`)
      : await db.query(sql`SELECT * FROM email_threads ORDER BY received_at DESC LIMIT ${limit}`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Proposals ───────────────────────────────────────────────────────────
app.get("/api/proposals", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const rows = await db.query(sql`SELECT * FROM proposals ORDER BY created_at DESC LIMIT ${limit}`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Visibility Audits ───────────────────────────────────────────────────
app.get("/api/visibility", async (req, res) => {
  const week = req.query.week;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const rows = week
      ? await db.query(sql`SELECT * FROM visibility_audits WHERE audit_week = ${week} ORDER BY provider, prompt_id`)
      : await db.query(sql`SELECT * FROM visibility_audits ORDER BY created_at DESC LIMIT ${limit}`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Attribution Events ──────────────────────────────────────────────────
app.get("/api/attribution", async (req, res) => {
  const leadId = req.query.lead_id;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const rows = leadId
      ? await db.query(sql`SELECT * FROM attribution_events WHERE lead_id = ${parseInt(leadId)} ORDER BY created_at ASC`)
      : await db.query(sql`SELECT * FROM attribution_events ORDER BY created_at DESC LIMIT ${limit}`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/attribution/:leadId/path", async (req, res) => {
  const leadId = parseInt(req.params.leadId);
  try {
    const events = await db.query(sql`SELECT event_type, channel, campaign, created_at, meta FROM attribution_events WHERE lead_id = ${leadId} ORDER BY created_at ASC`);
    const lead = await db.query(sql`SELECT * FROM leads WHERE id = ${leadId}`);
    res.json({ lead: lead[0] || null, touchpoints: events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Voice Service (Phase R, R3) ────────────────────────────────────────
// POST /api/voice/draft — RAG-conditioned Sarah-voice draft generation.
// Localhost-only; mounted here so initChroma's chromaVoiceCorpus handle
// is already exposed via app.locals by the time a request arrives.
const { buildRouter: buildVoiceRouter } = require('./routes/voice-draft');
app.use('/api/voice', buildVoiceRouter(() => db));

// ─── API: Media Library (Phase M, migration 015) ─────────────────────────────
// GET/POST /api/media/* — agent-facing media query + serve API for the
// Sarah-drive footage indexed by ../media/scripts/*. Localhost-only.
const { buildRouter: buildMediaRouter } = require('./routes/media');
app.use('/api/media', buildMediaRouter(() => db));

// ─── API: Landing-page video provisioning (Phase M2, migration 016) ──────────
// POST /api/landing/finalize-video — record an asset → (slug, slot) assignment
// and atomically move the operator-transcoded file into the landing app's
// public/ tree. Heavy I/O (read /Volumes source, ffmpeg encode) happens
// in the CLI; this endpoint only does file placement + DB writes.
const { buildRouter: buildLandingRouter } = require('./routes/landing');
app.use('/api/landing', buildLandingRouter(() => db));

// ─── API: Landing-page variant optimizer (WhatsApp-click funnel) ─────────────
// POST /api/track   — telemetry beacon ingest (page_sessions + page_events)
// GET  /api/lp/config — sticky variant assignment + JSON config for hydration
// GET  /api/lp/stats  — per-variant WhatsApp-click funnel. Public browser
// telemetry is source-checked and rate-limited; stats remain API-authenticated.
const lpTrackLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });
const { buildRouter: buildTrackRouter } = require('./routes/track');
app.use('/api/track', requireBrowserSource, lpTrackLimiter, buildTrackRouter(() => db));
const { buildRouter: buildLpRouter } = require('./routes/lp');
const lpConfigLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/lp', requireBrowserSource, lpConfigLimiter, buildLpRouter(() => db));

// ─── API: Chroma Status ───────────────────────────────────────────────────────
app.get("/api/chroma/status", async (req, res) => {
  if (!chromaClient) {
    // Lazy reconnect: a single fresh attempt so the API self-heals after
    // Chroma comes up post-reboot, even if the boot-time retry window
    // (~39s) elapsed before the daemon was ready.
    const ok = await initChroma({ retry: false });
    if (!ok) return res.json({ ok: false, reason: "not connected" });
  }
  try {
    await chromaClient.heartbeat();
    const contacts_count = chromaContacts ? await chromaContacts.count() : 0;
    const voice_corpus_count = chromaVoiceCorpus ? await chromaVoiceCorpus.count() : 0;
    const media_corpus_count = app.locals.chromaMediaCorpus ? await app.locals.chromaMediaCorpus.count() : 0;
    res.json({ ok: true, contacts_count, voice_corpus_count, media_corpus_count });
  } catch (e) {
    // Heartbeat failed mid-flight — drop the client so the next call re-connects.
    chromaClient = null;
    chromaContacts = null;
    chromaVoiceCorpus = null;
    res.json({ ok: false, reason: e.message });
  }
});

app.get('/api/stats/funnel', async (req, res) => {
  try {
    const [{ n: impressions }]      = await db.query(sql`SELECT COUNT(*) n FROM events WHERE event_type = 'impression'`);
    const [{ n: clicks }]           = await db.query(sql`SELECT COUNT(*) n FROM events WHERE event_type IN ('click','contact_click','book_click')`);
    const [{ n: form_views }]       = await db.query(sql`SELECT COUNT(*) n FROM events WHERE event_type = 'form_view'`);
    const [{ n: form_submissions }] = await db.query(sql`SELECT COUNT(*) n FROM leads`);
    const [{ n: booked }]           = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE status = 'booked'`);

    const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—';

    res.json({ stages: [
      { label: 'Impressions',      value: impressions,      pct: '100%' },
      { label: 'Clicks',           value: clicks,           pct: pct(clicks, impressions) },
      { label: 'Form Views',       value: form_views,       pct: pct(form_views, clicks) },
      { label: 'Form Submissions', value: form_submissions, pct: pct(form_submissions, form_views) },
      { label: 'Booked',           value: booked,           pct: pct(booked, form_submissions) },
    ]});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const events = await db.query(sql`SELECT * FROM events ORDER BY created_at DESC LIMIT 50`);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Campaigns ───────────────────────────────────────────────────────────

app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await db.query(sql`SELECT * FROM campaigns ORDER BY created_at DESC`);

    // Enrich each campaign with lead/event stats
    const enriched = await Promise.all(campaigns.map(async (c) => {
      const [{ n: clicks }]      = await db.query(sql`SELECT COUNT(*) n FROM events WHERE campaign = ${c.name} AND event_type IN ('contact_click','book_click','click')`);
      const [{ n: form_views }]  = await db.query(sql`SELECT COUNT(*) n FROM events WHERE campaign = ${c.name} AND event_type = 'form_view'`);
      const [{ n: inquiries }]   = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE campaign_name = ${c.name}`);
      const [{ n: booked }]      = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE campaign_name = ${c.name} AND status = 'booked'`);
      const [{ v: pipeline }]    = await db.query(sql`SELECT COALESCE(SUM(estimated_value),0) v FROM leads WHERE campaign_name = ${c.name} AND status != 'lost'`);
      const conv_pct = inquiries > 0 ? ((booked / inquiries) * 100).toFixed(1) : '0.0';
      return { ...c, clicks, form_views, inquiries, booked, pipeline_value: pipeline, conversion_rate: conv_pct };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const b = req.body;
    await db.query(sql`
      INSERT INTO campaigns (name, region, offer, target_audience, budget_daily, budget_total,
        spend_actual, status, channel, start_date, end_date, meta_campaign_id, notes)
      VALUES (
        ${b.name || 'Unnamed Campaign'},
        ${b.region || null},
        ${b.offer || null},
        ${b.target_audience || null},
        ${parseFloat(b.budget_daily) || 0},
        ${parseFloat(b.budget_total) || 0},
        ${parseFloat(b.spend_actual) || 0},
        ${['active','paused','ended'].includes(b.status) ? b.status : 'active'},
        ${['facebook_ad','instagram_ad','organic_instagram','both'].includes(b.channel) ? b.channel : 'facebook_ad'},
        ${b.start_date || null},
        ${b.end_date || null},
        ${b.meta_campaign_id || null},
        ${b.notes || null}
      )
    `);
    const [created] = await db.query(sql`SELECT * FROM campaigns ORDER BY id DESC LIMIT 1`);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await db.query(sql`SELECT * FROM campaigns WHERE id = ${parseInt(id)}`);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    const b = req.body;
    await db.query(sql`
      UPDATE campaigns SET
        name             = ${b.name             !== undefined ? b.name             : existing.name},
        region           = ${b.region           !== undefined ? b.region           : existing.region},
        offer            = ${b.offer            !== undefined ? b.offer            : existing.offer},
        target_audience  = ${b.target_audience  !== undefined ? b.target_audience  : existing.target_audience},
        budget_daily     = ${b.budget_daily     !== undefined ? parseFloat(b.budget_daily)  : existing.budget_daily},
        budget_total     = ${b.budget_total     !== undefined ? parseFloat(b.budget_total)  : existing.budget_total},
        spend_actual     = ${b.spend_actual     !== undefined ? parseFloat(b.spend_actual)   : existing.spend_actual},
        status           = ${b.status           !== undefined ? b.status           : existing.status},
        channel          = ${b.channel          !== undefined ? b.channel          : existing.channel},
        start_date       = ${b.start_date       !== undefined ? b.start_date       : existing.start_date},
        end_date         = ${b.end_date         !== undefined ? b.end_date         : existing.end_date},
        meta_campaign_id = ${b.meta_campaign_id !== undefined ? b.meta_campaign_id : existing.meta_campaign_id},
        notes            = ${b.notes            !== undefined ? b.notes            : existing.notes}
      WHERE id = ${parseInt(id)}
    `);
    const [updated] = await db.query(sql`SELECT * FROM campaigns WHERE id = ${parseInt(id)}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/funnel', async (req, res) => {
  try {
    const { id } = req.params;
    const [campaign] = await db.query(sql`SELECT * FROM campaigns WHERE id = ${parseInt(id)}`);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const [{ n: clicks }]      = await db.query(sql`SELECT COUNT(*) n FROM events WHERE campaign = ${campaign.name} AND event_type IN ('contact_click','book_click','click')`);
    const [{ n: form_views }]  = await db.query(sql`SELECT COUNT(*) n FROM events WHERE campaign = ${campaign.name} AND event_type = 'form_view'`);
    const [{ n: submissions }] = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE campaign_name = ${campaign.name}`);
    const [{ n: booked }]      = await db.query(sql`SELECT COUNT(*) n FROM leads WHERE campaign_name = ${campaign.name} AND status = 'booked'`);
    const [{ v: pipeline }]    = await db.query(sql`SELECT COALESCE(SUM(estimated_value),0) v FROM leads WHERE campaign_name = ${campaign.name} AND status != 'lost'`);

    const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—';
    const conv_rate = submissions > 0 ? ((booked / submissions) * 100).toFixed(1) : '0.0';

    res.json({
      campaign,
      pipeline_value: pipeline,
      conversion_rate: conv_rate,
      stages: [
        { label: 'Clicks',       value: clicks,      pct: '100%' },
        { label: 'Form Views',   value: form_views,  pct: pct(form_views, clicks) },
        { label: 'Inquiries',    value: submissions, pct: pct(submissions, form_views) },
        { label: 'Booked',       value: booked,      pct: pct(booked, submissions) },
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Contacts (Outbound Prospector) ──────────────────────────────────────

const VALID_CONTACT_SOURCES = ['jason_pv_list', 'brave_search', 'manual_slack', 'referral'];
const VALID_CONTEXT_SOURCES = ['website_contact_page', 'business_directory', 'linkedin_business', 'manual_jason_pv_list', 'referral'];
const VALID_CONTACT_STATUSES = ['new', 'queued', 'contacted', 'replied', 'converted', 'dead'];

function computeDedupKey(contact) {
  if (contact.email) return contact.email.toLowerCase().trim();
  const parts = [
    (contact.name || '').toLowerCase().trim(),
    (contact.company || '').toLowerCase().trim(),
    (contact.website || '').toLowerCase().trim()
  ].join('|');
  return parts;
}

app.post('/api/contacts', async (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'name is required' });
    if (!b.context_source || !VALID_CONTEXT_SOURCES.includes(b.context_source)) {
      return res.status(400).json({ error: `context_source is required and must be one of: ${VALID_CONTEXT_SOURCES.join(', ')}` });
    }

    const email = b.email ? b.email.toLowerCase().trim() : null;
    const dedupKey = computeDedupKey({ ...b, email });

    // Check for duplicate
    const existing = await db.query(sql`SELECT id FROM contacts WHERE dedup_key = ${dedupKey}`);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Duplicate contact', existing_id: existing[0].id, dedup_key: dedupKey });
    }

    await db.query(sql`
      INSERT INTO contacts (first_name, last_name, name, email, email_status, dedup_key,
        company, title, linkedin_url, website, geography, specialties, recent_work, notes,
        source, source_query, context_source, status)
      VALUES (
        ${b.first_name || null}, ${b.last_name || null}, ${b.name}, ${email},
        ${b.email_status || 'unknown'}, ${dedupKey},
        ${b.company || null}, ${b.title || null}, ${b.linkedin_url || null},
        ${b.website || null}, ${b.geography || null}, ${b.specialties || null},
        ${b.recent_work || null}, ${b.notes || null},
        ${b.source || null}, ${b.source_query || null}, ${b.context_source},
        ${VALID_CONTACT_STATUSES.includes(b.status) ? b.status : 'new'}
      )
    `);

    const [created] = await db.query(sql`SELECT * FROM contacts ORDER BY id DESC LIMIT 1`);
    console.log(`[contacts] Created #${created.id}: ${created.name} (${created.email || 'no email'})`);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/bulk-import', async (req, res) => {
  try {
    const contacts = req.body;
    if (!Array.isArray(contacts)) return res.status(400).json({ error: 'Body must be an array of contact objects' });

    let inserted = 0;
    let skipped_duplicates = 0;
    const errors = [];

    for (let i = 0; i < contacts.length; i++) {
      const b = contacts[i];
      try {
        if (!b.name) { errors.push({ index: i, error: 'name is required' }); continue; }
        if (!b.context_source || !VALID_CONTEXT_SOURCES.includes(b.context_source)) {
          errors.push({ index: i, error: `invalid context_source: ${b.context_source}` }); continue;
        }

        const email = b.email ? b.email.toLowerCase().trim() : null;
        const dedupKey = computeDedupKey({ ...b, email });

        const existing = await db.query(sql`SELECT id FROM contacts WHERE dedup_key = ${dedupKey}`);
        if (existing.length > 0) { skipped_duplicates++; continue; }

        await db.query(sql`
          INSERT INTO contacts (first_name, last_name, name, email, email_status, dedup_key,
            company, title, linkedin_url, website, geography, specialties, recent_work, notes,
            source, source_query, context_source, status)
          VALUES (
            ${b.first_name || null}, ${b.last_name || null}, ${b.name}, ${email},
            ${b.email_status || 'unknown'}, ${dedupKey},
            ${b.company || null}, ${b.title || null}, ${b.linkedin_url || null},
            ${b.website || null}, ${b.geography || null}, ${b.specialties || null},
            ${b.recent_work || null}, ${b.notes || null},
            ${b.source || null}, ${b.source_query || null}, ${b.context_source},
            ${VALID_CONTACT_STATUSES.includes(b.status) ? b.status : 'new'}
          )
        `);
        inserted++;
      } catch (innerErr) {
        errors.push({ index: i, error: innerErr.message });
      }
    }

    console.log(`[contacts] Bulk import: ${inserted} inserted, ${skipped_duplicates} skipped, ${errors.length} errors`);
    res.json({ inserted, skipped_duplicates, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const { status, source, exclude_dnc, limit = 200, offset = 0 } = req.query;
    const lim = parseInt(limit);
    const off = parseInt(offset);

    let contacts;
    if (status && source && exclude_dnc === '1') {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE status = ${status} AND source = ${source} AND do_not_contact = 0 ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else if (status && source) {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE status = ${status} AND source = ${source} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else if (status && exclude_dnc === '1') {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE status = ${status} AND do_not_contact = 0 ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else if (source && exclude_dnc === '1') {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE source = ${source} AND do_not_contact = 0 ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else if (status) {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE status = ${status} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else if (source) {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE source = ${source} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else if (exclude_dnc === '1') {
      contacts = await db.query(sql`SELECT * FROM contacts WHERE do_not_contact = 0 ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    } else {
      contacts = await db.query(sql`SELECT * FROM contacts ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`);
    }

    const [{ n: total }] = await db.query(sql`SELECT COUNT(*) as n FROM contacts`);
    res.json({ contacts, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [contact] = await db.query(sql`SELECT * FROM contacts WHERE id = ${id}`);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const sends = await db.query(sql`SELECT * FROM outreach_sends WHERE contact_id = ${id} ORDER BY created_at DESC`);
    res.json({ ...contact, sends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/contacts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.query(sql`SELECT * FROM contacts WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const b = req.body;
    await db.query(sql`
      UPDATE contacts SET
        first_name = ${b.first_name !== undefined ? b.first_name : existing.first_name},
        last_name = ${b.last_name !== undefined ? b.last_name : existing.last_name},
        name = ${b.name !== undefined ? b.name : existing.name},
        email = ${b.email !== undefined ? (b.email ? b.email.toLowerCase().trim() : null) : existing.email},
        email_status = ${b.email_status !== undefined ? b.email_status : existing.email_status},
        company = ${b.company !== undefined ? b.company : existing.company},
        title = ${b.title !== undefined ? b.title : existing.title},
        linkedin_url = ${b.linkedin_url !== undefined ? b.linkedin_url : existing.linkedin_url},
        website = ${b.website !== undefined ? b.website : existing.website},
        geography = ${b.geography !== undefined ? b.geography : existing.geography},
        specialties = ${b.specialties !== undefined ? b.specialties : existing.specialties},
        recent_work = ${b.recent_work !== undefined ? b.recent_work : existing.recent_work},
        notes = ${b.notes !== undefined ? b.notes : existing.notes},
        status = ${b.status !== undefined && VALID_CONTACT_STATUSES.includes(b.status) ? b.status : existing.status},
        reply_status = ${b.reply_status !== undefined ? b.reply_status : existing.reply_status},
        last_contacted_at = ${b.last_contacted_at !== undefined ? b.last_contacted_at : existing.last_contacted_at},
        do_not_contact = ${b.do_not_contact !== undefined ? b.do_not_contact : existing.do_not_contact},
        do_not_contact_reason = ${b.do_not_contact_reason !== undefined ? b.do_not_contact_reason : existing.do_not_contact_reason},
        converted_lead_id = ${b.converted_lead_id !== undefined ? b.converted_lead_id : existing.converted_lead_id},
        updated_at = datetime('now')
      WHERE id = ${id}
    `);

    const [updated] = await db.query(sql`SELECT * FROM contacts WHERE id = ${id}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Outreach Campaigns ──────────────────────────────────────────────────

app.post('/api/outreach-campaigns', async (req, res) => {
  try {
    const b = req.body;
    // Step 3.2: slug is the operator-facing identifier (via !new-campaign).
    // Either {slug, ...} or legacy {name, landing_page_url, ...} is accepted.
    // When slug is provided, name defaults to slug; landing_page_url defaults
    // to '' (filled later by !provision-landing → Sol).
    const slug = b.slug || null;
    const name = b.name || slug;
    if (!name) return res.status(400).json({ error: 'slug or name is required' });
    const landingUrl = b.landing_page_url ?? '';
    if (slug && !/^[a-z][a-z0-9_]+$/.test(slug)) {
      return res.status(400).json({ error: 'slug must match ^[a-z][a-z0-9_]+$' });
    }

    // Check for duplicates on either column
    const dup = await db.query(sql`
      SELECT id, name, slug FROM outreach_campaigns
      WHERE name = ${name} OR (slug IS NOT NULL AND slug = ${slug})
    `);
    if (dup.length > 0) {
      return res.status(409).json({ error: 'Campaign already exists', existing_id: dup[0].id, existing: dup[0] });
    }

    await db.query(sql`
      INSERT INTO outreach_campaigns (name, slug, persona, landing_page_url, status,
                                       persona_brief_path, description, created_by)
      VALUES (${name}, ${slug}, ${b.persona || null}, ${landingUrl}, ${b.status || 'active'},
              ${b.persona_brief_path || null}, ${b.description || null}, ${b.created_by || null})
    `);
    const [created] = await db.query(sql`SELECT * FROM outreach_campaigns ORDER BY id DESC LIMIT 1`);
    console.log(`[outreach-campaigns] Created: ${created.slug || created.name}`);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Step 3.2: campaign_contacts attach ─────────────────────────────────────
// POST /api/outreach-campaigns/:id/contacts
// Body: { contact_ids: number[], attached_by: string }
// Returns: { attached: number, skipped: number, errors: [...] }
//
// Used by !attach-contacts (Slack command) and the optional 4th-arg of
// !new-campaign. INSERTs into campaign_contacts; UNIQUE constraint on
// (campaign_id, contact_id) makes this naturally idempotent.
app.post('/api/outreach-campaigns/:id/contacts', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const [campaign] = await db.query(sql`SELECT id, slug FROM outreach_campaigns WHERE id = ${campaignId}`);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const ids = Array.isArray(req.body.contact_ids) ? req.body.contact_ids.map(Number).filter(Number.isFinite) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'contact_ids[] is required and non-empty' });
    const attachedBy = req.body.attached_by || null;

    let attached = 0, skipped = 0;
    const errors = [];
    for (const cid of ids) {
      try {
        // Verify contact exists; skip otherwise.
        const [contact] = await db.query(sql`SELECT id FROM contacts WHERE id = ${cid}`);
        if (!contact) { errors.push({ contact_id: cid, error: 'not_found' }); continue; }
        // Check for existing attach (the UNIQUE constraint would 409, but explicit count is cleaner for the response).
        const existing = await db.query(sql`SELECT id FROM campaign_contacts WHERE campaign_id = ${campaignId} AND contact_id = ${cid}`);
        if (existing.length > 0) { skipped++; continue; }
        await db.query(sql`
          INSERT INTO campaign_contacts (campaign_id, contact_id, attached_by)
          VALUES (${campaignId}, ${cid}, ${attachedBy})
        `);
        attached++;
      } catch (e) {
        errors.push({ contact_id: cid, error: e.message });
      }
    }
    console.log(`[campaign-contacts] Campaign ${campaign.slug || campaignId}: ${attached} attached, ${skipped} skipped, ${errors.length} errors`);
    res.json({ attached, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/outreach-campaigns', async (req, res) => {
  try {
    const campaigns = await db.query(sql`SELECT * FROM outreach_campaigns ORDER BY created_at DESC`);
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Outreach Sends ──────────────────────────────────────────────────────

app.post('/api/outreach-sends', async (req, res) => {
  try {
    const b = req.body;
    if (!b.contact_id) return res.status(400).json({ error: 'contact_id is required' });
    if (!b.subject) return res.status(400).json({ error: 'subject is required' });
    if (!b.body_full) return res.status(400).json({ error: 'body_full is required' });

    // Verify contact exists
    const [contact] = await db.query(sql`SELECT id FROM contacts WHERE id = ${parseInt(b.contact_id)}`);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const bodyPreview = (b.body_full || '').substring(0, 200);

    await db.query(sql`
      INSERT INTO outreach_sends (contact_id, campaign_id, sequence_step, subject, body_full, body_preview,
        template_subject_id, template_body_id, status)
      VALUES (
        ${parseInt(b.contact_id)}, ${b.campaign_id ? parseInt(b.campaign_id) : null},
        ${b.sequence_step || 1}, ${b.subject}, ${b.body_full}, ${bodyPreview},
        ${b.template_subject_id || null}, ${b.template_body_id || null},
        ${b.status || 'drafted'}
      )
    `);

    const [created] = await db.query(sql`SELECT * FROM outreach_sends ORDER BY id DESC LIMIT 1`);
    console.log(`[outreach-sends] Draft #${created.id} for contact #${created.contact_id}`);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/outreach-sends/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Send not found' });

    const b = req.body;
    await db.query(sql`
      UPDATE outreach_sends SET
        status = ${b.status !== undefined ? b.status : existing.status},
        approved_by = ${b.approved_by !== undefined ? b.approved_by : existing.approved_by},
        approved_at = ${b.approved_at !== undefined ? b.approved_at : existing.approved_at},
        send_after = ${b.send_after !== undefined ? b.send_after : existing.send_after},
        scheduled_at = ${b.scheduled_at !== undefined ? b.scheduled_at : existing.scheduled_at},
        sent_at = ${b.sent_at !== undefined ? b.sent_at : existing.sent_at},
        delivered_at = ${b.delivered_at !== undefined ? b.delivered_at : existing.delivered_at},
        opened_at = ${b.opened_at !== undefined ? b.opened_at : existing.opened_at},
        clicked_at = ${b.clicked_at !== undefined ? b.clicked_at : existing.clicked_at},
        bounced_at = ${b.bounced_at !== undefined ? b.bounced_at : existing.bounced_at},
        complained_at = ${b.complained_at !== undefined ? b.complained_at : existing.complained_at},
        reply_detected_at = ${b.reply_detected_at !== undefined ? b.reply_detected_at : existing.reply_detected_at},
        unsubscribe_detected_at = ${b.unsubscribe_detected_at !== undefined ? b.unsubscribe_detected_at : existing.unsubscribe_detected_at},
        cancelled_at = ${b.cancelled_at !== undefined ? b.cancelled_at : existing.cancelled_at},
        resend_email_id = ${b.resend_email_id !== undefined ? b.resend_email_id : existing.resend_email_id},
        error = ${b.error !== undefined ? b.error : existing.error}
      WHERE id = ${id}
    `);

    const [updated] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/outreach-sends', async (req, res) => {
  try {
    const { status, contact_id, limit = 200, offset = 0 } = req.query;
    let conditions = [];
    if (status) conditions.push({ field: 'status', value: status });
    if (contact_id) conditions.push({ field: 'contact_id', value: parseInt(contact_id) });

    // Simple dynamic query
    let rows;
    if (status && contact_id) {
      rows = await db.query(sql`SELECT * FROM outreach_sends WHERE status = ${status} AND contact_id = ${parseInt(contact_id)} ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`);
    } else if (status) {
      rows = await db.query(sql`SELECT * FROM outreach_sends WHERE status = ${status} ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`);
    } else if (contact_id) {
      rows = await db.query(sql`SELECT * FROM outreach_sends WHERE contact_id = ${parseInt(contact_id)} ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`);
    } else {
      rows = await db.query(sql`SELECT * FROM outreach_sends ORDER BY created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`);
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Suppressions ────────────────────────────────────────────────────────

app.post('/api/suppressions', async (req, res) => {
  try {
    const b = req.body;
    if (!b.email) return res.status(400).json({ error: 'email is required' });
    if (!b.reason) return res.status(400).json({ error: 'reason is required' });

    const result = await addSuppression(db, {
      email: b.email,
      reason: b.reason,
      source: b.source || null,
      notes: b.notes || null,
      addedBy: b.added_by || null,
    });

    if (result.alreadyExisted) {
      return res.status(409).json({ error: 'Email already suppressed', existing_id: result.suppressionId });
    }

    const [created] = await db.query(sql`SELECT * FROM suppressions WHERE id = ${result.suppressionId}`);
    console.log(`[suppressions] Added: ${result.normalizedEmail}, reason: ${b.reason}`);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suppressions/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase().trim();
    const [suppression] = await db.query(sql`SELECT * FROM suppressions WHERE email = ${email}`);
    if (!suppression) return res.json({ suppressed: false });
    res.json({ suppressed: true, ...suppression });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suppressions', async (req, res) => {
  try {
    const rows = await db.query(sql`SELECT * FROM suppressions ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Drafts (Step 3.2 — composer + dispatcher) ──────────────────────────
//
// "Drafts" are outreach_sends rows in non-terminal compose-time statuses
// (pending_approval primarily). These endpoints implement the Approve / Reject /
// Edit handlers wired to the Slack Block Kit buttons; the OpenClaw plugin's
// invoke handler POSTs here on each click.
//
// State machine boundary with Step 3.3:
//   3.2 owns: drafted → pending_approval → approved | cancelled
//   3.3 owns: approved → scheduled → sent (and rate-based auto-pause)
//
// Approve only flips status to 'approved'; it does not invoke send.sh.

// Pause-state read helper: drives the "Queued for send." vs.
// "Approved but paused — will send on !resume." response hint.
function readProspectorPaused() {
  const statePath = path.join(__dirname, '..', 'prospector', 'state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Boolean(state.paused);
  } catch {
    return false;
  }
}

// POST /api/drafts/:id/approve
// Body: { by: string }  (Slack user id)
//
// Step 3.2: flips pending_approval → approved.
// Step 3.3 (2026-05-06): also computes scheduled_at via lib/scheduler.js per
// spec §3.2 (9–5 PT weekday window, 20–90 min jitter, weekly-cap aware).
// Status flip + scheduled_at write are wrapped in a transaction so a partial
// failure can't leave the row at status='approved' with NULL scheduled_at —
// the orchestrator's `WHERE scheduled_at <= now()` SELECT would silently
// skip such a row forever, a stuck-state class of bug.
//
// Idempotency (spec §3.3): if the row is already at approved with scheduled_at
// set, return the existing scheduled_at unchanged with HTTP 200. Plugin
// retries / re-deliveries are no-ops.
//
// Note: outreach_sends.send_after stays NULL by design. See the leading
// comment in crm/migrations/005_step_3_3_columns.sql for the why.
app.post('/api/drafts/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const by = req.body.by || null;
    const [existing] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });

    // Idempotent re-approval: if already approved with scheduled_at, return existing.
    if (existing.status === 'approved' && existing.scheduled_at) {
      const paused = readProspectorPaused();
      return res.json({
        ok: true, draft: existing, paused, idempotent: true,
        scheduled_at: existing.scheduled_at,
        message_hint: paused ? '⏸ Approved but paused — will send on !resume.' : 'Queued for send.',
      });
    }

    if (existing.status !== 'pending_approval') {
      return res.status(409).json({ error: 'Draft is not in pending_approval', current_status: existing.status });
    }

    // Compute scheduled_at BEFORE the transaction (read-only — no deadlock risk).
    let scheduling;
    try {
      const config = JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
      // eslint-disable-next-line global-require
      const { computeScheduledAt } = require('../prospector/lib/scheduler');
      // Pass our own `sql` tag — the scheduler is package-instance-agnostic.
      scheduling = await computeScheduledAt(db, sql, config, existing.campaign_id);
    } catch (e) {
      return res.status(500).json({ error: `scheduling_failed: ${e.message}` });
    }

    // Transaction: status flip + scheduled_at write together, or neither.
    const now = new Date().toISOString();
    await db.tx(async (t) => {
      await t.query(sql`
        UPDATE outreach_sends
        SET status = 'approved', approved_by = ${by}, approved_at = ${now}
        WHERE id = ${id} AND status = 'pending_approval'
      `);
      await t.query(sql`
        UPDATE outreach_sends SET scheduled_at = ${scheduling.scheduled_at} WHERE id = ${id}
      `);
    });

    const [updated] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    const paused = readProspectorPaused();
    console.log(`[drafts] #${id} approved by ${by}, scheduled_at=${scheduling.scheduled_at} (week ${scheduling.week_index}, ${scheduling.cap_remaining_in_week} remaining)${paused ? ' (paused — held)' : ''}`);
    res.json({
      ok: true, draft: updated, paused,
      scheduled_at: scheduling.scheduled_at,
      week_index: scheduling.week_index,
      cap_remaining_in_week: scheduling.cap_remaining_in_week,
      message_hint: paused
        ? '⏸ Approved but paused — will send on !resume.'
        : 'Queued for send.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/reject
// Body: { reason: string, by: string }
// Flips pending_approval → cancelled, records reason.
app.post('/api/drafts/:id/reject', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const reason = (req.body.reason || '').trim();
    const by = req.body.by || null;
    if (!reason) return res.status(400).json({ error: 'reason is required' });

    const [existing] = await db.query(sql`SELECT id, status FROM outreach_sends WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });
    if (existing.status !== 'pending_approval') {
      return res.status(409).json({ error: 'Draft is not in pending_approval', current_status: existing.status });
    }
    const now = new Date().toISOString();
    await db.query(sql`
      UPDATE outreach_sends
      SET status = 'cancelled', rejected_reason = ${reason}, rejected_by = ${by}, cancelled_at = ${now}
      WHERE id = ${id} AND status = 'pending_approval'
    `);
    const [updated] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    console.log(`[drafts] #${id} rejected by ${by}: ${reason}`);
    res.json({ ok: true, draft: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/edit
// Body: { subject: string, body: string, by: string }
//
// Per spec §4.3.3: edits ALWAYS auto-approve, regardless of gate result.
// Sarah/Jason editing a draft IS approval — the human-in-the-loop authority
// supersedes the gate at this point. But we still run a content-only gate
// (banned phrases, disclosure pattern) and log failures with source='edit_override'
// for audit. Items 4 (token), 5 (postal address), 1-3 (suppress/dnc/cap) don't
// change as a result of subject/body edits, so we skip them here — send.sh's
// gate will catch any of those at send time.
const { loadBannedPhrases, findBannedPhrase } = require('../prospector/lib/banned-phrases');
const { loadDisclosurePatterns } = require('../prospector/lib/compliance');

function editGateCheck(subject, body) {
  const failures = [];
  const text = `${subject || ''} ${body || ''}`;
  // Item 7: banned phrases
  const phrases = loadBannedPhrases();
  const hit = findBannedPhrase(text, phrases);
  if (hit) failures.push({ failed_check: 'item_7_banned_phrase', details: hit.phrase });
  // Item 6 (pattern only — semantic correctness deferred to human, who is the editor)
  const patterns = loadDisclosurePatterns();
  const haystack = (body || '').toLowerCase();
  const hasDisclosure = patterns.some((p) => haystack.includes(p));
  if (!hasDisclosure) failures.push({ failed_check: 'item_6_no_disclosure_pattern', details: null });
  return { pass: failures.length === 0, failures };
}

app.post('/api/drafts/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { subject, body, by } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });

    const [existing] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });
    if (existing.status !== 'pending_approval') {
      return res.status(409).json({ error: 'Draft is not in pending_approval', current_status: existing.status });
    }

    // Append the prior version to edit_history.
    const priorHistory = existing.edit_history ? JSON.parse(existing.edit_history) : [];
    priorHistory.push({
      subject: existing.subject,
      body: existing.body_full,
      edited_at: new Date().toISOString(),
      edited_by: by,
    });

    // Compute scheduled_at BEFORE the transaction (Step 3.3 — read-only, no
    // deadlock risk). Without this, the auto-approved edit-override row sits
    // forever at status='approved' with NULL scheduled_at because the
    // orchestrator's SELECT excludes scheduled_at IS NULL. Discovered during
    // §7 verification 2026-05-06.
    let scheduling;
    try {
      const cfg = JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
      // eslint-disable-next-line global-require
      const { computeScheduledAt } = require('../prospector/lib/scheduler');
      scheduling = await computeScheduledAt(db, sql, cfg, existing.campaign_id);
    } catch (e) {
      return res.status(500).json({ error: `scheduling_failed: ${e.message}` });
    }

    const now = new Date().toISOString();
    const bodyPreview = body.substring(0, 200);
    // Same transaction shape as /approve: status flip + scheduled_at write
    // together, or neither. A partial failure mid-edit would otherwise leave
    // the row at status='approved' with NULL scheduled_at — silent stuck state.
    await db.tx(async (t) => {
      await t.query(sql`
        UPDATE outreach_sends
        SET subject = ${subject}, body_full = ${body}, body_preview = ${bodyPreview},
            edited_by = ${by}, edited_at = ${now},
            edit_history = ${JSON.stringify(priorHistory)},
            status = 'approved', approved_by = ${by}, approved_at = ${now}
        WHERE id = ${id}
      `);
      await t.query(sql`UPDATE outreach_sends SET scheduled_at = ${scheduling.scheduled_at} WHERE id = ${id}`);
    });

    // Diagnostic gate (always logs, never blocks the auto-approve).
    const gate = editGateCheck(subject, body);
    if (!gate.pass) {
      for (const f of gate.failures) {
        await db.query(sql`
          INSERT INTO compliance_failures (contact_id, outreach_send_id, failed_check, details, source)
          VALUES (${existing.contact_id}, ${id}, ${f.failed_check}, ${f.details}, 'edit_override')
        `);
      }
      console.warn(`[drafts] #${id} edit-override by ${by} — gate failures: ${gate.failures.map(f => f.failed_check).join(',')}`);
    } else {
      console.log(`[drafts] #${id} edited and approved by ${by} (gate clean)`);
    }

    const [updated] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${id}`);
    const paused = readProspectorPaused();
    res.json({
      ok: true, draft: updated, gate, paused,
      scheduled_at: scheduling.scheduled_at,
      week_index: scheduling.week_index,
      cap_remaining_in_week: scheduling.cap_remaining_in_week,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/sweep-stale
// No body. Cancels all pending_approval drafts whose posted_at is older than 7 days.
// Called by the daily LaunchAgent and by the !sweep-stale-drafts command.
app.post('/api/drafts/sweep-stale', async (req, res) => {
  try {
    const stale = await db.query(sql`
      SELECT id FROM outreach_sends
      WHERE status = 'pending_approval'
        AND posted_at IS NOT NULL
        AND datetime(posted_at) < datetime('now', '-7 days')
    `);
    const ids = stale.map((r) => r.id);
    let n = 0;
    for (const id of ids) {
      await db.query(sql`
        UPDATE outreach_sends
        SET status = 'cancelled', cancelled_at = datetime('now'), error = 'expired'
        WHERE id = ${id} AND status = 'pending_approval'
      `);
      n++;
    }
    if (n > 0) console.log(`[drafts] Stale-draft sweep cancelled ${n} draft(s): ${ids.join(',')}`);
    res.json({ ok: true, cancelled: n, ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook: Resend Inbound replies (Step 3.2 §4.4 / §6) ────────────────────
//
// Resend Inbound (or any forwarding setup that POSTs JSON here) lands replies
// at this endpoint. We resolve the original outreach_sends row by either the
// custom `outreach_send_id` tag echoed back via In-Reply-To/References, or by
// matching the From: address to a contact + sender thread. v0 keeps it simple:
// require the inbound payload to include `outreach_send_id` in a `tags` field
// (Resend Inbound supports tag echo) OR fall back to matching by From.
//
// On success we update outreach_sends.reply_detected_at, run the auto-classify
// keyword check from slack-interaction.md §6.2, and post the formatted reply
// notification to #prospector-paulina with the three classify buttons.
app.post('/webhook/resend-reply', requireLoopback, async (req, res) => {
  const payload = req.body || {};
  const fromEmail = (payload.from?.address || payload.from || '').toLowerCase().trim();
  const replyText = String(payload.text || payload.body_text || payload.body || '').trim();
  const replyPreview = replyText.slice(0, 500);
  const tagSendId = payload.tags?.outreach_send_id || payload.tag_outreach_send_id || null;

  // Resolve outreach_send_id either via tag echo or via from-address lookup.
  let send = null;
  if (tagSendId) {
    const [row] = await db.query(sql`SELECT * FROM outreach_sends WHERE id = ${parseInt(tagSendId)}`);
    if (row) send = row;
  }
  if (!send && fromEmail) {
    const rows = await db.query(sql`
      SELECT os.* FROM outreach_sends os
      JOIN contacts c ON c.id = os.contact_id
      WHERE LOWER(c.email) = ${fromEmail}
        AND os.status IN ('sent','delivered','opened','clicked')
        AND os.reply_detected_at IS NULL
      ORDER BY os.sent_at DESC LIMIT 1
    `);
    send = rows[0] || null;
  }
  if (!send) {
    console.warn('[resend-reply] Could not match reply to a send. From:', fromEmail, 'tag:', tagSendId);
    return res.status(202).json({ ok: false, matched: false });
  }

  const now = new Date().toISOString();
  await db.query(sql`UPDATE outreach_sends SET reply_detected_at = ${now} WHERE id = ${send.id}`);

  // Auto-classification per slack-interaction.md §6.2.
  const lower = replyText.toLowerCase();
  const NOT_INTERESTED = ['unsubscribe', 'not interested', 'remove me', 'stop emailing', 'wrong person', 'no thanks'];
  const HOT = ['available dates', 'tell me more', 'send pricing', 'interested', 'would love to', 'sounds great', "let's chat"];
  const suggestion = NOT_INTERESTED.some((p) => lower.includes(p)) ? 'not_interested'
    : HOT.some((p) => lower.includes(p)) ? 'hot'
    : 'ambiguous';

  const [contact] = await db.query(sql`SELECT id, name, email FROM contacts WHERE id = ${send.contact_id}`);
  const [campaign] = await db.query(sql`SELECT slug, name FROM outreach_campaigns WHERE id = ${send.campaign_id || -1}`);
  const campaignLabel = campaign?.slug || campaign?.name || 'unknown';

  const message = [
    `📬 Reply from ${contact?.name || ''} <${fromEmail}>`,
    `   Original: Draft #${send.id} sent ${send.sent_at || '(unknown)'} (campaign: ${campaignLabel})`,
    '',
    '──────────────────────────────────────',
    `> ${replyPreview.split('\n').slice(0, 20).join('\n> ')}`,
    '──────────────────────────────────────',
    '',
    `Suggested classification: *${suggestion}*`,
    '',
    `Mark hot:           \`!classify-reply ${contact.id} hot\``,
    `Mark not_interested:\`!classify-reply ${contact.id} not_interested\``,
    `Mark needs_sarah:   \`!classify-reply ${contact.id} ambiguous\``,
    '',
    `(Block Kit buttons are Phase D polish; for v0, use the text commands above.)`,
  ].join('\n');

  try {
    if (PROSPECTOR_CHANNEL_ID) {
      await slackPostToChannel('channel:' + PROSPECTOR_CHANNEL_ID, message);
    }
  } catch (e) {
    console.warn('[resend-reply] Slack post failed:', e.message);
  }

  console.log(`[resend-reply] Reply matched to send #${send.id}, contact #${contact?.id}, suggestion=${suggestion}`);
  res.json({ ok: true, matched: true, send_id: send.id, suggestion });
});

// ─── API: Reply classification (Step 3.2 §4.4) ──────────────────────────────
// POST /api/contacts/:id/reply-classify
// Body: { quality: 'hot' | 'not_interested' | 'ambiguous', by: string }
//
// Wired from the three reply-notification buttons. For 'not_interested' we
// also cascade to the suppression flow with reason 'negative_reply'.
app.post('/api/contacts/:id/reply-classify', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const { quality, by } = req.body;
    const allowed = ['hot', 'not_interested', 'ambiguous'];
    if (!allowed.includes(quality)) {
      return res.status(400).json({ error: `quality must be one of ${allowed.join('|')}` });
    }
    const [contact] = await db.query(sql`SELECT id, email, name FROM contacts WHERE id = ${contactId}`);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    await db.query(sql`UPDATE contacts SET lead_quality = ${quality}, updated_at = datetime('now') WHERE id = ${contactId}`);

    let suppressed = false;
    if (quality === 'not_interested' && contact.email) {
      try {
        const result = await addSuppression(db, {
          email: contact.email,
          reason: 'negative_reply',
          source: 'reply_classify',
          notes: `Marked not_interested by ${by || 'unknown'}`,
          addedBy: by ? `slack_command:${by}` : null,
        });
        await db.query(sql`UPDATE contacts SET do_not_contact = 1, do_not_contact_reason = 'negative_reply' WHERE id = ${contactId}`);
        suppressed = true;
        console.log(`[reply-classify] #${contactId} (${contact.email}) → not_interested, suppressed (already=${result.alreadyExisted})`);
      } catch (e) {
        console.warn(`[reply-classify] suppression cascade failed for #${contactId}:`, e.message);
      }
    } else {
      console.log(`[reply-classify] #${contactId} → ${quality} by ${by}`);
    }

    const [updated] = await db.query(sql`SELECT id, name, email, lead_quality, do_not_contact FROM contacts WHERE id = ${contactId}`);
    res.json({ ok: true, contact: updated, suppressed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: pending_contacts_staging (direct-email importer review flow) ──────
// Backs the !staging-list / !staging-approve / !staging-reject commands.
// Rows arrive in pending_contacts_staging from import-direct-email-contacts.js;
// approvals here only flip status. The actual write to `contacts` happens in
// apply-staging-approvals.js (manual checkpoint).

// GET /api/staging
//   Query: batch_id?, status? (default: status=pending), limit? (default 50)
app.get('/api/staging', async (req, res) => {
  try {
    const status = (req.query.status || 'pending').toString();
    const batchId = req.query.batch_id ? req.query.batch_id.toString() : null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    let rows;
    if (batchId) {
      rows = await db.query(sql`
        SELECT id, thread_id, extracted_email, extracted_name, thread_subject,
               llm_classification, llm_category, llm_confidence,
               existing_contact_id, suggested_action, status, batch_id,
               created_at, reviewed_at, reviewed_by, applied_at, applied_contact_id
        FROM pending_contacts_staging
        WHERE status = ${status} AND batch_id = ${batchId}
        ORDER BY id DESC LIMIT ${limit}
      `);
    } else {
      rows = await db.query(sql`
        SELECT id, thread_id, extracted_email, extracted_name, thread_subject,
               llm_classification, llm_category, llm_confidence,
               existing_contact_id, suggested_action, status, batch_id,
               created_at, reviewed_at, reviewed_by, applied_at, applied_contact_id
        FROM pending_contacts_staging
        WHERE status = ${status}
        ORDER BY id DESC LIMIT ${limit}
      `);
    }
    res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/:id/approve
// Body: { by?: string }
app.post('/api/staging/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id must be integer' });
    const by = req.body.by || null;
    const [existing] = await db.query(sql`SELECT id, status FROM pending_contacts_staging WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Staging row not found' });
    if (existing.status === 'approved') {
      return res.json({ ok: true, idempotent: true, id, status: 'approved' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `Row is in status=${existing.status}, cannot approve` });
    }
    await db.query(sql`
      UPDATE pending_contacts_staging
      SET status = 'approved', reviewed_at = ${new Date().toISOString()}, reviewed_by = ${by}
      WHERE id = ${id}
    `);
    res.json({ ok: true, id, status: 'approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/:id/reject
// Body: { by?: string }
app.post('/api/staging/:id/reject', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id must be integer' });
    const by = req.body.by || null;
    const [existing] = await db.query(sql`SELECT id, status FROM pending_contacts_staging WHERE id = ${id}`);
    if (!existing) return res.status(404).json({ error: 'Staging row not found' });
    if (existing.status === 'rejected') {
      return res.json({ ok: true, idempotent: true, id, status: 'rejected' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `Row is in status=${existing.status}, cannot reject` });
    }
    await db.query(sql`
      UPDATE pending_contacts_staging
      SET status = 'rejected', reviewed_at = ${new Date().toISOString()}, reviewed_by = ${by}
      WHERE id = ${id}
    `);
    res.json({ ok: true, id, status: 'rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/bulk
// Body: { action: 'approve' | 'reject', batch_id?: string, by?: string }
// If batch_id is set, only that batch's pending rows are flipped.
// If batch_id is absent, ALL pending rows are flipped — use deliberately.
app.post('/api/staging/bulk', async (req, res) => {
  try {
    const action = (req.body.action || '').toString();
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }
    const by = req.body.by || null;
    const batchId = req.body.batch_id ? req.body.batch_id.toString() : null;
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const now = new Date().toISOString();
    let result;
    if (batchId) {
      result = await db.query(sql`
        UPDATE pending_contacts_staging
        SET status = ${newStatus}, reviewed_at = ${now}, reviewed_by = ${by}
        WHERE status = 'pending' AND batch_id = ${batchId}
      `);
    } else {
      result = await db.query(sql`
        UPDATE pending_contacts_staging
        SET status = ${newStatus}, reviewed_at = ${now}, reviewed_by = ${by}
        WHERE status = 'pending'
      `);
    }
    // @databases/sqlite does not return rowCount uniformly; report by re-counting.
    const [{ n }] = await db.query(sql`
      SELECT COUNT(*) AS n FROM pending_contacts_staging
      WHERE status = ${newStatus} AND reviewed_at = ${now}
    `);
    res.json({ ok: true, action, batch_id: batchId, affected: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OwnerRez Webhook ──────────────────────────────────────────────────────────
const { buildRouter: buildOwnerRezRouter } = require('./routes/ownerrez');
app.use('/api/ownerrez', buildOwnerRezRouter(() => db));

// ─── WhatsApp Bridge via Twilio ────────────────────────────────────────────────
const { buildRouter: buildWhatsAppRouter } = require('./routes/whatsapp');
app.use('/webhook/twilio-whatsapp', buildWhatsAppRouter(() => db));
app.use('/api/whatsapp', buildWhatsAppRouter(() => db));

// ─── QuickBooks OAuth ──────────────────────────────────────────────────────────
const { buildRouter: buildQuickBooksRouter } = require('./routes/quickbooks');
app.use('/api/quickbooks', buildQuickBooksRouter());

// ─── Meta Webhook (Instagram DMs + Facebook Page Messages) ─────────────────────
const META_SECRETS_PATH = path.join(SECRETS_DIR, 'meta.json');

function loadMetaSecrets() {
  try { return JSON.parse(fs.readFileSync(META_SECRETS_PATH, 'utf8')); }
  catch { return {}; }
}

async function resolveMetaSenderName(senderId, pageToken) {
  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(senderId)}?fields=name,username`, {
      headers: { Authorization: `Bearer ${pageToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return senderId;
    const data = await resp.json();
    if (data.username) return `@${data.username}`;
    if (data.name)     return data.name;
  } catch {}
  return senderId;
}

// GET — Meta webhook verification challenge
app.get('/webhook/meta', (req, res) => {
  const secrets = loadMetaSecrets();
  const VERIFY_TOKEN = secrets.webhook_verify_token;
  if (!VERIFY_TOKEN) {
    console.error('[meta webhook] Verification token unavailable');
    return res.status(503).json({ error: 'Webhook verification unavailable' });
  }
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('[meta webhook] Verification OK');
    return res.status(200).send(req.query['hub.challenge']);
  }
  console.warn('[meta webhook] Verification FAILED — bad token or mode');
  res.status(403).json({ error: 'Verification failed' });
});

// POST — incoming DM events
app.post('/webhook/meta', async (req, res) => {
  const secrets = loadMetaSecrets();
  if (!secrets.app_secret || !Buffer.isBuffer(req.rawBody)) {
    return res.status(503).json({ error: 'Webhook verification unavailable' });
  }
  if (!verifyMetaSignature(req.rawBody, secrets.app_secret, req.headers['x-hub-signature-256'])) {
    console.warn('[meta webhook] Rejected invalid signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  res.status(200).json({ received: true }); // Authenticate, then acknowledge promptly.
  const body = req.body || {};
  if (!['page', 'instagram'].includes(body.object)) return;

  const platform = body.object;
  const platformLabel = platform === 'instagram' ? 'Instagram' : 'Facebook';
  const icon = platform === 'instagram' ? '📸' : '📘';

  try {
    const sysToken = secrets.access_token;
    const pageId   = secrets.page_id;

    // Get page-scoped token for profile lookups
    let pageToken = sysToken;
    try {
      const ptResp = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}?fields=access_token`, {
        headers: { Authorization: `Bearer ${sysToken}` },
        signal: AbortSignal.timeout(8000),
      });
      const ptData = await ptResp.json();
      if (ptData.access_token) pageToken = ptData.access_token;
    } catch {}

    for (const entry of body.entry || []) {
      for (const msg of (entry.messaging || [])) {
        if (msg.message?.is_echo) continue;          // skip echoes (our own sends)
        const senderId = msg.sender?.id;
        if (!senderId || senderId === pageId) continue;

        const text    = msg.message?.text || (msg.message?.attachments ? '[attachment]' : '[no text]');
        const mid     = msg.message?.mid || null;
        const ts      = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
        const rawJson = JSON.stringify(msg);

        // Deduplicate by message_id
        if (mid && db) {
          const [{ n }] = await db.query(sql`SELECT COUNT(*) n FROM meta_messages WHERE message_id = ${mid}`);
          if (n > 0) continue;
        }

        const senderName = await resolveMetaSenderName(senderId, pageToken);

        console.log(`[meta webhook] ${platformLabel} DM from ${senderName}: ${text.slice(0, 80)}`);

        // Persist to DB and get row id
        let dmRowId = null;
        if (db) {
          try {
            await db.query(sql`
              INSERT OR IGNORE INTO meta_messages (platform, sender_id, sender_name, message_id, message_text, received_at, raw_payload)
              VALUES (${platform}, ${senderId}, ${senderName}, ${mid}, ${text}, ${ts}, ${rawJson})
            `);
            const [{ id }] = await db.query(sql`SELECT id FROM meta_messages WHERE message_id = ${mid || ''} OR (sender_id = ${senderId} AND received_at = ${ts}) ORDER BY id DESC LIMIT 1`);
            dmRowId = id;
          } catch (dbErr) {
            console.warn('[meta webhook] DB insert failed:', dbErr.message);
          }
        }

        // Post to #social-sol with reply ref
        const preview  = text.length > 300 ? text.slice(0, 300) + '…' : text;
        const refTag   = dmRowId ? ` [ref: dm-${dmRowId}]` : '';
        const slackMsg = `${icon} *New ${platformLabel} DM* from *${senderName}*${refTag}:\n${preview}\n_Reply here with: \`!dm ${dmRowId || '?'} your message\`_`;
        if (SOCIAL_CHANNEL_ID && SLACK_ACCOUNT) {
          try {
            execFileSync(OPENCLAW_BIN, [
              'send', 'slack', SLACK_ACCOUNT,
              '--target', `channel:${SOCIAL_CHANNEL_ID}`,
              slackMsg,
            ], { timeout: 8000, stdio: 'ignore' });
          } catch (e) {
            console.warn('[meta webhook] Slack notify failed:', e.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[meta webhook] Processing error:', err);
  }
});

// ─── Meta DM Reply API ───────────────────────────────────────────────────────
// POST /api/meta-dm/reply  { dm_id: 42, message: "Hello!" }
app.post('/api/meta-dm/reply', express.json(), async (req, res) => {
  const { dm_id, message } = req.body || {};
  const dmId = Number.parseInt(dm_id, 10);
  const replyText = typeof message === 'string' ? message.trim() : '';
  if (!Number.isSafeInteger(dmId) || dmId <= 0 || !replyText) {
    return res.status(400).json({ error: 'valid dm_id and message required' });
  }
  if (replyText.length > 2000) return res.status(400).json({ error: 'message too long' });
  if (!db) return res.status(503).json({ error: 'DB not ready' });

  try {
    const rows = await db.query(sql`SELECT * FROM meta_messages WHERE id = ${dmId} AND platform IN ('instagram', 'page') AND sender_id != 'outbound' LIMIT 1`);
    if (!rows.length) return res.status(404).json({ error: `No inbound DM found with id ${dmId}` });
    const dm = rows[0];

    const secrets    = loadMetaSecrets();
    const sysToken   = secrets.access_token;
    const pageId     = secrets.page_id;
    const G          = 'https://graph.facebook.com/v21.0';

    // Get page-scoped token
    let pageToken = sysToken;
    try {
      const pt = await fetch(`${G}/${encodeURIComponent(pageId)}?fields=access_token`, {
        headers: { Authorization: `Bearer ${sysToken}` },
        signal: AbortSignal.timeout(8000),
      });
      const ptd = await pt.json();
      if (ptd.access_token) pageToken = ptd.access_token;
    } catch {}

    // Send via appropriate endpoint
    let sendUrl, sendBody;
    if (dm.platform === 'instagram') {
      const igId = process.env.META_INSTAGRAM_ID || secrets.instagram_id;
      if (!igId) {
        return res.status(503).json({ error: 'Meta Instagram account ID is not configured' });
      }
      sendUrl  = `${G}/${igId}/messages`;
      sendBody = JSON.stringify({ recipient: { id: dm.sender_id }, message: { text: replyText } });
    } else {
      sendUrl  = `${G}/${pageId}/messages`;
      sendBody = JSON.stringify({ recipient: { id: dm.sender_id }, message: { text: replyText } });
    }

    const resp = await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pageToken}` },
      body: sendBody,
      signal: AbortSignal.timeout(12000),
    });
    const result = await resp.json();

    if (result.error) {
      console.error('[meta-dm/reply] Send failed:', result.error);
      return res.status(502).json({ error: result.error.message, detail: result.error });
    }

    // Log the outbound reply
    const now = new Date().toISOString();
    await db.query(sql`
      INSERT INTO meta_messages (platform, sender_id, sender_name, message_text, received_at, raw_payload)
      VALUES (${dm.platform}, ${'outbound'}, ${'Sol (outbound)'}, ${replyText}, ${now}, ${JSON.stringify({ reply_to_dm_id: dmId, meta_result: result })})
    `);

    console.log(`[meta-dm/reply] Sent to ${dm.sender_name} (${dm.platform}): ${replyText.slice(0, 80)}`);
    res.json({ ok: true, platform: dm.platform, recipient: dm.sender_name, message_id: result.message_id });
  } catch (err) {
    console.error('[meta-dm/reply] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Seed Data ────────────────────────────────────────────────────────────────
async function seedData() {
  console.log('[seed] Inserting sample leads…');
  const leads = [
    { name: 'Sample Guest One', email: 'guest.one@example.com', phone: '+1-202-555-0101', source: 'facebook_ad', campaign_name: 'Example Campaign', status: 'booked', notes: 'Example honeymoon inquiry.', utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'example_campaign', inquiry_message: 'We are planning our honeymoon.', estimated_value: 3800, checkin_date: '2026-04-12', checkout_date: '2026-04-19' },
    { name: 'Sample Guest Two', email: 'guest.two@example.com', phone: '+1-202-555-0102', source: 'instagram_ad', campaign_name: 'Example Campaign', status: 'quote_sent', notes: 'Example family inquiry.', utm_source: 'instagram', utm_medium: 'cpc', utm_campaign: 'example_campaign', inquiry_message: 'What packages are available for families?', estimated_value: 5200, checkin_date: '2026-04-16', checkout_date: '2026-04-23' },
    { name: 'Sample Guest Three', email: 'guest.three@example.com', phone: '+1-202-555-0103', source: 'organic', campaign_name: null, status: 'contacted', notes: 'Example organic inquiry.', utm_source: 'google', utm_medium: 'organic', utm_campaign: null, inquiry_message: 'What dates are available?', estimated_value: 2100, checkin_date: '2026-06-12', checkout_date: '2026-06-16' },
    { name: 'Sample Guest Four', email: 'guest.four@example.com', phone: null, source: 'facebook_ad', campaign_name: 'Example Campaign', status: 'new', notes: null, utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'example_campaign', inquiry_message: 'What is the best time to visit?', estimated_value: 0, checkin_date: null, checkout_date: null },
    { name: 'Sample Guest Five', email: 'guest.five@example.com', phone: '+1-202-555-0105', source: 'referral', campaign_name: null, status: 'booked', notes: 'Example referral inquiry.', utm_source: null, utm_medium: null, utm_campaign: null, inquiry_message: 'A friend recommended your resort.', estimated_value: 3420, checkin_date: '2026-05-01', checkout_date: '2026-05-07' },
    { name: 'Sample Guest Six', email: 'guest.six@example.com', phone: '+1-202-555-0106', source: 'instagram_ad', campaign_name: 'Example Campaign', status: 'lost', notes: 'Example price-sensitive inquiry.', utm_source: 'instagram', utm_medium: 'cpc', utm_campaign: 'example_campaign', inquiry_message: 'What is your entry-level rate?', estimated_value: 0, checkin_date: null, checkout_date: null },
    { name: 'Sample Guest Seven', email: 'guest.seven@example.com', phone: '+1-202-555-0107', source: 'direct', campaign_name: null, status: 'new', notes: 'Example corporate retreat inquiry.', utm_source: null, utm_medium: null, utm_campaign: null, inquiry_message: 'Looking for an executive retreat venue.', estimated_value: 12000, checkin_date: '2026-09-15', checkout_date: '2026-09-19' },
    { name: 'Sample Guest Eight', email: 'guest.eight@example.com', phone: '+1-202-555-0108', source: 'facebook_ad', campaign_name: 'Example Campaign', status: 'quote_sent', notes: 'Example anniversary inquiry.', utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'example_campaign', inquiry_message: 'What anniversary packages do you offer?', estimated_value: 4600, checkin_date: '2026-08-20', checkout_date: '2026-08-27' },
  ];

  for (const l of leads) {
    await db.query(sql`
      INSERT INTO leads (name, email, phone, source, campaign_name, status, notes,
        utm_source, utm_medium, utm_campaign, inquiry_message, estimated_value, checkin_date, checkout_date)
      VALUES (${l.name}, ${l.email}, ${l.phone}, ${l.source}, ${l.campaign_name}, ${l.status}, ${l.notes},
        ${l.utm_source}, ${l.utm_medium}, ${l.utm_campaign}, ${l.inquiry_message},
        ${l.estimated_value}, ${l.checkin_date}, ${l.checkout_date})
    `);
  }

  // Seed funnel events (representative sample)
  const now = Date.now();
  const rand = () => new Date(now - Math.random() * 30 * 86400000).toISOString().replace('T',' ').slice(0,19);

  for (let i = 0; i < 6000; i++) {
    const src = i % 3 === 0 ? 'instagram_ad' : 'facebook_ad';
    const cmp = i % 3 === 0 ? 'Example Seasonal Campaign' : 'Example Evergreen Campaign';
    await db.query(sql`INSERT INTO events (event_type, source, campaign, created_at) VALUES ('impression', ${src}, ${cmp}, ${rand()})`);
  }
  for (let i = 0; i < 500; i++) {
    await db.query(sql`INSERT INTO events (event_type, source, campaign, created_at) VALUES ('contact_click', ${ i%2===0?'facebook_ad':'instagram_ad'}, ${'Example Seasonal Campaign'}, ${rand()})`);
  }
  for (let i = 0; i < 150; i++) {
    await db.query(sql`INSERT INTO events (event_type, source, campaign, created_at) VALUES ('form_view', 'facebook_ad', 'Example Evergreen Campaign', ${rand()})`);
  }

  // Seed campaigns if empty
  const [{ n: campCount }] = await db.query(sql`SELECT COUNT(*) n FROM campaigns`);
  if (campCount === 0) {
    await db.query(sql`INSERT INTO campaigns (name, region, offer, target_audience, budget_daily, spend_actual, status, channel, start_date, end_date, meta_campaign_id, notes)
      VALUES ('Example Evergreen Campaign', 'Example Region', 'Resort stays', 'Example audience', 10, 0, 'paused', 'both', null, null, null, 'Synthetic seed data')`);
    await db.query(sql`INSERT INTO campaigns (name, region, offer, target_audience, budget_daily, spend_actual, status, channel, start_date, end_date, meta_campaign_id, notes)
      VALUES ('Example Seasonal Campaign', 'Example Region', 'Seasonal resort stays', 'Example audience', 10, 0, 'paused', 'both', null, null, null, 'Synthetic seed data')`);
    console.log('[seed] 2 campaigns seeded.');
  }

  console.log('[seed] Done — 8 leads + funnel events inserted.');
}

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   La Puesta del Sol Resort — CRM                     ║
  ║   http://localhost:${PORT}                              ║
  ╚══════════════════════════════════════════════════════╝
    `);
  });
  initChroma();
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
