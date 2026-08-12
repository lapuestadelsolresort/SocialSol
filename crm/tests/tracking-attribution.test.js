'use strict';

/**
 * tracking-attribution.test.js — Unit + integration tests for the LP tracking,
 * WhatsApp attribution, and campaign lead reporting pipeline.
 *
 * Created 2026-08-06 after a systemic failure where:
 *   - tracker.js was blocked by ad blockers (renamed to px.js)
 *   - DNT suppressed wa_click + cta_view (conversion events)
 *   - data-cta attributes were missing from WhatsApp buttons
 *   - WhatsApp CRM leads were not counted in campaign metrics
 *   - Attribution session-id-prefix fallback was missing
 *
 * These tests guard against regression on ALL of those issues.
 */

const assert = require('node:assert/strict');
const { describe, it, before, after, beforeEach } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LP_ROOT = path.resolve(ROOT, '..', 'landing');

// ─────────────────────────────────────────────────────────────────────────────
// 1. CLIENT-SIDE TRACKER (px.js) — Static analysis
// ─────────────────────────────────────────────────────────────────────────────

describe('px.js client-side tracker', () => {
  let pxSource;

  before(() => {
    pxSource = fs.readFileSync(path.join(ROOT, 'public', 'lp', 'px.js'), 'utf-8');
  });

  it('file exists and is named px.js (not tracker.js)', () => {
    assert.ok(pxSource.length > 500, 'px.js should be a substantial script');
    assert.ok(
      pxSource.includes('px.js'),
      'px.js should reference itself (not tracker.js) in header'
    );
  });

  it('tracker.js stub exists and redirects to px.js', () => {
    const stub = fs.readFileSync(path.join(ROOT, 'public', 'lp', 'tracker.js'), 'utf-8');
    assert.ok(stub.includes('px.js'), 'tracker.js stub must redirect to px.js');
    assert.ok(stub.length < 500, 'tracker.js should be a tiny redirect stub, not the full tracker');
  });

  it('wa_click handler is registered BEFORE the DNT bailout', () => {
    const waClickPos = pxSource.indexOf("send('wa_click'");
    const dntBailoutPos = pxSource.indexOf('if (dnt)');
    assert.ok(waClickPos > 0, 'wa_click send call must exist');
    assert.ok(dntBailoutPos > 0, 'DNT bailout must exist');
    assert.ok(
      waClickPos < dntBailoutPos,
      'wa_click handler must be registered BEFORE the DNT bailout so it fires for all users'
    );
  });

  it('cta_view IntersectionObserver is registered BEFORE the DNT bailout', () => {
    const ctaViewPos = pxSource.indexOf("send('cta_view'");
    const dntBailoutPos = pxSource.indexOf('if (dnt)');
    assert.ok(ctaViewPos > 0, 'cta_view send call must exist');
    assert.ok(
      ctaViewPos < dntBailoutPos,
      'cta_view observer must be registered BEFORE the DNT bailout so it fires for all users'
    );
  });

  it('IntersectionObserver watches .wa-cta elements (not just [data-cta])', () => {
    assert.ok(
      pxSource.includes(".wa-cta"),
      'Observer must also watch .wa-cta class elements for pages that lack data-cta'
    );
  });

  it('cta_view reads data-cta OR data-event attribute', () => {
    // The cta_view target should fall back to data-event if data-cta is missing
    assert.ok(
      pxSource.includes("getAttribute('data-event')"),
      'cta_view must fall back to data-event attribute when data-cta is absent'
    );
  });

  it('DNT override still allows wa_click and cta_view through', () => {
    // After DNT bailout, the overridden LPDS_TRACK should pass through wa_click and cta_view
    const dntSection = pxSource.slice(pxSource.indexOf('if (dnt)'));
    assert.ok(
      dntSection.includes("kind === 'wa_click'") || dntSection.includes("'wa_click'"),
      'DNT override must whitelist wa_click'
    );
    assert.ok(
      dntSection.includes("kind === 'cta_view'") || dntSection.includes("'cta_view'"),
      'DNT override must whitelist cta_view'
    );
  });

  it('sends wa_ref in pageview meta for attribution', () => {
    assert.ok(
      pxSource.includes('wa_ref'),
      'Pageview meta must include wa_ref for session-to-WhatsApp attribution'
    );
  });

  it('appends LPDS ref to WhatsApp links', () => {
    assert.ok(
      pxSource.includes('LPDS-'),
      'Must append LPDS-<ref> to WhatsApp link text for attribution'
    );
  });
});

describe('Squarespace tracker conversion intent under DNT', () => {
  it('registers WhatsApp capture tracking before the DNT bailout', () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'lp', 'sq-tracker.js'), 'utf-8');
    const waPos = source.indexOf("send('wa_click'");
    const dntPos = source.indexOf('if (dnt)');
    assert.ok(waPos > 0 && dntPos > 0 && waPos < dntPos);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LANDING PAGE MARKUP — data-cta attributes + script src
// ─────────────────────────────────────────────────────────────────────────────

describe('Landing page markup', () => {
  const pages = ['weddings', 'retreats', 'summer-sale', 'fitness', 'planners'];

  for (const page of pages) {
    describe(page, () => {
      let source;

      before(() => {
        const srcPath = path.join(LP_ROOT, 'apps', page, 'src', 'pages', 'index.astro');
        if (!fs.existsSync(srcPath)) {
          // Fall back to dist if source doesn't exist
          const distPath = path.join(LP_ROOT, 'apps', page, 'dist', 'index.html');
          source = fs.readFileSync(distPath, 'utf-8');
        } else {
          source = fs.readFileSync(srcPath, 'utf-8');
        }
      });

      it('loads px.js (not tracker.js)', () => {
        assert.ok(
          source.includes('/lp/px.js'),
          `${page} must load px.js, not tracker.js`
        );
      });

      it('WhatsApp CTA buttons have data-cta attributes', () => {
        // Every wa-cta element should have a data-cta attribute
        const waCTAs = source.match(/class="wa-cta[^"]*"/g) || [];
        assert.ok(waCTAs.length > 0, `${page} must have at least one .wa-cta element`);

        // Check that data-cta exists near each wa-cta (within the same element)
        const dataCTAs = source.match(/data-cta="/g) || [];
        assert.ok(
          dataCTAs.length >= waCTAs.length,
          `${page}: every .wa-cta must have a data-cta attribute (found ${dataCTAs.length} data-cta vs ${waCTAs.length} wa-cta)`
        );
      });

      it('does not reference tracker.js as a script src', () => {
        // The inline comments may reference tracker.js — that's OK.
        // But the actual <script src="..."> must not.
        const scriptSrcs = source.match(/src="[^"]*tracker\.js[^"]*"/g) || [];
        assert.equal(
          scriptSrcs.length, 0,
          `${page} must not load tracker.js directly (ad blockers will kill it)`
        );
      });
    });
  }

  it('planners page has data-cta (baseline reference)', () => {
    const src = fs.readFileSync(
      path.join(LP_ROOT, 'apps', 'planners', 'src', 'pages', 'index.astro'),
      'utf-8'
    );
    const dataCTAs = src.match(/data-cta="/g) || [];
    assert.ok(dataCTAs.length >= 2, 'planners page must have data-cta attributes (baseline)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SERVER-SIDE TRACK.JS — Event processing
// ─────────────────────────────────────────────────────────────────────────────

describe('Server-side track.js event processing', () => {
  let trackSource;

  before(() => {
    trackSource = fs.readFileSync(path.join(ROOT, 'routes', 'track.js'), 'utf-8');
  });

  it('wa_click records intent but does not claim a verified conversion', () => {
    assert.ok(trackSource.includes("e.kind === 'wa_click'"), 'Must handle wa_click events');
    const waBlock = trackSource.slice(trackSource.indexOf("e.kind === 'wa_click'"), trackSource.indexOf("e.kind === 'cta_view'"));
    assert.ok(waBlock.includes('cta_clicked = 1'), 'wa_click must record the tap');
    assert.ok(!waBlock.includes('converted = 1'), 'wa_click must not be treated as a verified conversion');
  });

  it('cta_view sets reached_cta = 1', () => {
    assert.ok(trackSource.includes("e.kind === 'cta_view'"), 'Must handle cta_view events');
    assert.ok(
      trackSource.includes('reached_cta = 1'),
      'cta_view must set reached_cta to 1'
    );
  });

  it('stores whatsapp_ref from pageview meta', () => {
    assert.ok(
      trackSource.includes('whatsapp_ref') && trackSource.includes('wa_ref'),
      'Must extract and store whatsapp_ref from pageview meta'
    );
  });

  it('validates whatsapp_ref matches session UUID prefix', () => {
    // The ref should be validated against the session ID to prevent spoofing
    assert.ok(
      trackSource.includes('expectedRef') || trackSource.includes('SID'),
      'whatsapp_ref should be validated against session ID'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WHATSAPP ATTRIBUTION (durable ingress + processing graph)
// ─────────────────────────────────────────────────────────────────────────────

describe('WhatsApp attribution (durable ingress + processing graph)', () => {
  let waSource;

  before(() => {
    waSource = [
      fs.readFileSync(path.join(ROOT, 'routes', 'whatsapp.js'), 'utf-8'),
      fs.readFileSync(path.join(ROOT, 'workflows', 'whatsapp-inbound.js'), 'utf-8'),
    ].join('\n');
  });

  it('extracts LPDS ref from message text', () => {
    assert.ok(
      waSource.includes('LPDS-') && waSource.includes('refMatch'),
      'Must extract LPDS-XXXX ref from WhatsApp message body'
    );
  });

  it('has session-id-prefix fallback for ref matching', () => {
    assert.ok(
      waSource.includes('session-id-prefix'),
      'Must have session-id-prefix fallback when whatsapp_ref column is empty'
    );
  });

  it('reconstructs UUID from hex ref for prefix matching', () => {
    // The ref is the first 16 hex chars of the UUID, formatted as 8-4-4
    assert.ok(
      /slice\(0,\s*8\)/.test(waSource) && /slice\(8,\s*12\)/.test(waSource),
      'Must reconstruct UUID prefix (8-4-4 format) from hex ref'
    );
  });

  it('never guesses attribution from an unrelated time-window session', () => {
    assert.ok(!waSource.includes("datetime('now', '-60 minutes')"));
    assert.ok(!waSource.includes("datetime('now', '-24 hours')"));
    assert.ok(!waSource.includes('time-window-cta'));
    assert.ok(!waSource.includes('time-window-wa-click'));
  });

  it('sets source to meta_ad when session has utm_source=meta', () => {
    assert.ok(
      waSource.includes("'meta_ad'") || waSource.includes('"meta_ad"'),
      'Must set source to meta_ad when session originated from Meta paid traffic'
    );
  });

  it('creates attribution_events record on successful attribution', () => {
    assert.ok(
      waSource.includes('attribution_events'),
      'Must write an attribution_events row for traceable leads'
    );
  });

  it('auto-creates CRM lead from first WhatsApp contact', () => {
    assert.ok(
      waSource.includes('INSERT INTO leads'),
      'Must auto-create a CRM lead row on first WhatsApp contact'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CAMPAIGN LEAD REPORTING (wa_campaign_leads.py)
// ─────────────────────────────────────────────────────────────────────────────

describe('Campaign lead reporting', () => {
  it('wa_campaign_leads.py exists and is executable', () => {
    const scriptPath = path.join(ROOT, '..', 'automation', 'wa_campaign_leads.py');
    assert.ok(fs.existsSync(scriptPath), 'wa_campaign_leads.py must exist');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('whatsapp'), 'Must query WhatsApp leads');
    assert.ok(content.includes('attribution_events'), 'Must use the deterministic attribution ledger');
    assert.ok(content.includes('utm_campaign'), 'Must group leads by utm_campaign');
  });

  it('committed reporting distinguishes pixel taps from verified WhatsApp leads', () => {
    const content = fs.readFileSync(
      path.join(ROOT, '..', 'automation', 'daily_consolidated_report.py'),
      'utf-8'
    );
    assert.ok(
      content.includes('WhatsApp taps') && content.includes('verified inbound WhatsApp leads'),
      'The committed report must show taps and verified WhatsApp leads separately'
    );
    assert.ok(
      content.includes('performance decisions are blocked'),
      'The committed report must block performance decisions when tracking integrity fails'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. INTEGRATION: Database schema supports attribution pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('Database schema supports attribution', () => {
  const DB_PATH = path.join(ROOT, 'data', 'crm.db');
  let db;

  before(async () => {
    // Only run if DB exists (CI might not have it)
    if (!fs.existsSync(DB_PATH)) return;
    const sqlite = require('@databases/sqlite');
    db = sqlite(DB_PATH, { readOnly: true });
  });

  after(async () => {
    if (db) await db.dispose();
  });

  it('page_sessions has whatsapp_ref column', async () => {
    if (!db) return; // skip if no DB
    const { sql } = require('@databases/sqlite');
    const cols = await db.query(sql`PRAGMA table_info(page_sessions)`);
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('whatsapp_ref'), 'page_sessions must have whatsapp_ref column');
    assert.ok(colNames.includes('reached_cta'), 'page_sessions must have reached_cta column');
    assert.ok(colNames.includes('cta_clicked'), 'page_sessions must have cta_clicked column');
    assert.ok(colNames.includes('converted'), 'page_sessions must have converted column');
    assert.ok(colNames.includes('utm_campaign'), 'page_sessions must have utm_campaign column');
  });

  it('leads table has utm_campaign for attribution', async () => {
    if (!db) return;
    const { sql } = require('@databases/sqlite');
    const cols = await db.query(sql`PRAGMA table_info(leads)`);
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('utm_campaign'), 'leads must have utm_campaign column');
    assert.ok(colNames.includes('utm_source'), 'leads must have utm_source column');
    assert.ok(colNames.includes('source'), 'leads must have source column');
  });

  it('attribution_events table exists', async () => {
    if (!db) return;
    const { sql } = require('@databases/sqlite');
    const cols = await db.query(sql`PRAGMA table_info(attribution_events)`);
    assert.ok(cols.length > 0, 'attribution_events table must exist');
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('utm_campaign'), 'attribution_events must have utm_campaign');
    assert.ok(colNames.includes('lead_id'), 'attribution_events must have lead_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. INTEGRATION: Full funnel regression guards
// ─────────────────────────────────────────────────────────────────────────────

describe('Full funnel regression guards', () => {
  const DB_PATH = path.join(ROOT, 'data', 'crm.db');

  it('no WhatsApp leads should be missing source field', async () => {
    if (!fs.existsSync(DB_PATH)) return;
    const sqlite = require('@databases/sqlite');
    const { sql } = require('@databases/sqlite');
    const db = sqlite(DB_PATH, { readOnly: true });
    try {
      const [{ n }] = await db.query(sql`
        SELECT COUNT(*) as n FROM leads
        WHERE phone LIKE '+%' AND (source IS NULL OR source = '')
      `);
      assert.equal(n, 0, 'All leads with phone numbers must have a source field set');
    } finally {
      await db.dispose();
    }
  });

  it('deterministic WhatsApp attribution never duplicates one session reference', async () => {
    if (!fs.existsSync(DB_PATH)) return;
    const sqlite = require('@databases/sqlite');
    const { sql } = require('@databases/sqlite');
    const db = sqlite(DB_PATH, { readOnly: true });
    try {
      const [{ n }] = await db.query(sql`
        SELECT COUNT(*) n FROM (
          SELECT whatsapp_ref FROM page_sessions
          WHERE whatsapp_ref IS NOT NULL
          GROUP BY whatsapp_ref HAVING COUNT(*) > 1
        )
      `);
      assert.equal(n, 0, 'whatsapp_ref must identify at most one session');
    } finally {
      await db.dispose();
    }
  });

  it('CORS allows LP subdomains', () => {
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
    assert.ok(
      serverSource.includes('lapuestadelsolresort') && serverSource.includes('Access-Control-Allow-Origin'),
      'CORS must allow lapuestadelsolresort.com subdomains'
    );
    assert.ok(
      serverSource.includes('Access-Control-Allow-Origin'),
      'Must set Access-Control-Allow-Origin header'
    );
    assert.ok(
      serverSource.includes('Access-Control-Allow-Credentials') && serverSource.includes("'true'"),
      'Credentialed LP requests require Access-Control-Allow-Credentials: true'
    );
    assert.ok(
      serverSource.includes('Content-Type'),
      'Must allow Content-Type header for JSON beacons'
    );
  });

  it('campaign guardrails cannot pause Meta from private memory or pixel data', () => {
    const guardrails = fs.readFileSync(
      path.join(ROOT, '..', 'automation', 'guardrails.py'),
      'utf-8'
    );
    assert.ok(
      guardrails.toLowerCase().includes('guardrails never edit meta campaign state'),
      'The committed guardrail must keep Meta mutations out of this optimizer path'
    );
    assert.ok(
      !guardrails.includes('graph.facebook.com') && !guardrails.includes('/campaigns'),
      'The campaign guardrail must not contain a Meta mutation endpoint'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. SCALE GUARDS — Ensure new campaigns get proper tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('Scale guards for new campaigns', () => {
  it('track.js ALLOWED_KINDS includes all conversion events', () => {
    const trackSource = fs.readFileSync(path.join(ROOT, 'routes', 'track.js'), 'utf-8');
    const kinds = ['pageview', 'wa_click', 'cta_view', 'cta_click', 'scroll', 'heartbeat'];
    for (const kind of kinds) {
      assert.ok(
        trackSource.includes(`'${kind}'`),
        `ALLOWED_KINDS must include '${kind}'`
      );
    }
  });

  it('lp.js PAGE_SLUGS includes all active LP pages', () => {
    const lpSource = fs.readFileSync(path.join(ROOT, 'routes', 'lp.js'), 'utf-8');
    const expectedPages = ['weddings', 'fitness', 'retreats', 'summer-sale', 'planners'];
    for (const page of expectedPages) {
      assert.ok(
        lpSource.includes(`'${page}'`),
        `PAGE_SLUGS must include '${page}'`
      );
    }
  });

  it('all LP apps have corresponding LP page slugs', () => {
    const lpSource = fs.readFileSync(path.join(ROOT, 'routes', 'lp.js'), 'utf-8');
    const lpApps = fs.readdirSync(path.join(LP_ROOT, 'apps'));
    for (const app of lpApps) {
      const appDir = path.join(LP_ROOT, 'apps', app);
      if (!fs.statSync(appDir).isDirectory()) continue;
      if (!fs.existsSync(path.join(appDir, 'src', 'pages', 'index.astro')) &&
          !fs.existsSync(path.join(appDir, 'dist', 'index.html'))) continue;
      assert.ok(
        lpSource.includes(`'${app}'`),
        `LP page slug '${app}' must be registered in lp.js PAGE_SLUGS. ` +
        `New campaigns need their slug added here or tracking will silently fail.`
      );
    }
  });

  it('wa_campaign_leads.py queries verified WhatsApp attribution events', () => {
    const script = fs.readFileSync(
      path.join(ROOT, '..', 'automation', 'wa_campaign_leads.py'), 'utf-8'
    );
    assert.ok(script.includes('attribution_events'), 'Must query the attribution ledger');
    assert.ok(script.includes("event_type='whatsapp_lead'"), 'Must query verified inbound leads');
  });

  it('WhatsApp attribution permits only deterministic methods', () => {
    const waSource = [
      fs.readFileSync(path.join(ROOT, 'routes', 'whatsapp.js'), 'utf-8'),
      fs.readFileSync(path.join(ROOT, 'workflows', 'whatsapp-inbound.js'), 'utf-8'),
    ].join('\n');
    const methods = ['ref', 'session-id-prefix', 'unattributed'];
    for (const method of methods) {
      assert.ok(
        waSource.includes(method),
        `Attribution must include '${method}' method`
      );
    }
    assert.ok(!waSource.includes('time-window-cta'));
    assert.ok(!waSource.includes('time-window-wa-click'));
  });
});
