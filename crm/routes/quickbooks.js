/**
 * QuickBooks OAuth routes — connect, callback, status, test.
 * Single-company, file-based token storage, session-free.
 *
 * Mount: app.use('/api/quickbooks', buildRouter())
 */
const express = require('express');
const { readStore, writeStore, getValidAccessToken, loadDevCreds } = require('../lib/quickbooks-store');
const { createState, verifyState } = require('../lib/quickbooks-state');

// Intuit realm IDs are numeric company identifiers; OAuth authorization codes
// are short single-line VSCHAR strings (RFC 6749 §A.11). Anything else is
// refused before the token exchange, never echoed, and never persisted —
// the callback HTML and the token store are the sinks being protected (F-027).
const REALM_ID_SHAPE = /^\d{1,32}$/;
const AUTH_CODE_SHAPE = /^[\x21-\x7e]{1,512}$/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRouter() {
  const router = express.Router();

  // ─── GET /connect — kick off OAuth flow ──────────────────────────────────────
  router.get('/connect', async (req, res) => {
    try {
      const creds = await loadDevCreds();
      const state = createState();

      const url = new URL('https://appcenter.intuit.com/connect/oauth2');
      url.searchParams.set('client_id', creds.client_id);
      url.searchParams.set('scope', creds.scopes || 'com.intuit.quickbooks.accounting');
      url.searchParams.set('redirect_uri', creds.redirect_uri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);

      res.redirect(url.toString());
    } catch (err) {
      console.error('[quickbooks/connect] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /callback — Intuit redirects here after consent ─────────────────────
  router.get('/callback', async (req, res) => {
    try {
      const { code, realmId, state, error } = req.query;

      if (error) {
        console.error('[quickbooks/callback] OAuth error:', error);
        return res.status(400).json({ error: `OAuth denied: ${error}` });
      }

      // Validate state
      const v = verifyState(state);
      if (!v.ok) {
        return res.status(400).json({ error: `Invalid state: ${v.reason}` });
      }

      if (!code || !realmId) {
        return res.status(400).json({ error: 'Missing code or realmId' });
      }
      if (typeof realmId !== 'string' || !REALM_ID_SHAPE.test(realmId)) {
        return res.status(400).json({ error: 'realmId must be a numeric Intuit realm identifier' });
      }
      if (typeof code !== 'string' || !AUTH_CODE_SHAPE.test(code)) {
        return res.status(400).json({ error: 'authorization code has an unexpected shape' });
      }

      // Exchange code for tokens
      const creds = await loadDevCreds();
      const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
      const auth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');

      const tokenResp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: creds.redirect_uri,
        }),
      });

      const tokenJson = await tokenResp.json();
      if (!tokenResp.ok) {
        console.error('[quickbooks/callback] Token exchange failed:', tokenJson);
        return res.status(500).json({ error: 'Token exchange failed', details: tokenJson });
      }

      const expiresAt = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString();

      await writeStore({
        realmId: String(realmId),
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token,
        expires_at: expiresAt,
        env: creds.env || 'sandbox',
      });

      console.log(`[quickbooks/callback] ✅ Connected! realmId=${realmId}, tokens saved.`);
      res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h1>✅ QuickBooks Connected!</h1>
          <p>Realm ID: <code>${escapeHtml(realmId)}</code></p>
          <p>Tokens saved. You can close this window.</p>
          <p><a href="/api/quickbooks/status">Check status</a> · <a href="/api/quickbooks/test">Run test query</a></p>
        </body></html>
      `);
    } catch (err) {
      console.error('[quickbooks/callback] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /status — check connection state ────────────────────────────────────
  router.get('/status', async (req, res) => {
    try {
      const data = await readStore();
      if (!data) {
        return res.json({
          connected: false,
          message: 'Not connected. Visit /api/quickbooks/connect to authorize.',
        });
      }

      const expiresAt = new Date(data.expires_at);
      const now = new Date();
      const expired = now >= expiresAt;
      const expiresIn = Math.max(0, Math.round((expiresAt - now) / 1000 / 60));

      res.json({
        connected: true,
        realmId: data.realmId,
        env: data.env,
        expires_at: data.expires_at,
        expired,
        expires_in_minutes: expiresIn,
        updated_at: data.updated_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /test — sanity check: fetch company info ────────────────────────────
  router.get('/test', async (req, res) => {
    try {
      const { accessToken, realmId } = await getValidAccessToken();
      const creds = await loadDevCreds();

      // Pick the right base URL for sandbox vs production
      const baseUrl = creds.env === 'production'
        ? 'https://quickbooks.api.intuit.com'
        : 'https://sandbox-quickbooks.api.intuit.com';

      const apiResp = await fetch(
        `${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        }
      );

      const apiJson = await apiResp.json();
      if (!apiResp.ok) {
        return res.status(apiResp.status).json({ error: 'QBO API call failed', details: apiJson });
      }

      res.json({
        success: true,
        company: apiJson.CompanyInfo || apiJson,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
