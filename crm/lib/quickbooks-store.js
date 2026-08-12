/**
 * QuickBooks token store — file-based, atomic write, restart-safe.
 * Stores realmId + tokens in secrets/quickbooks.json (single-company).
 */
const fs = require('fs/promises');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');

function getStorePath() {
  return path.join(SECRETS_DIR, 'quickbooks.json');
}

async function readStore() {
  const file = getStorePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    return normalizeStore(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function normalizeStore(data) {
  if (!data || typeof data !== 'object') return null;
  const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
  const obtainedAt = tokens.obtained_at ? new Date(tokens.obtained_at).getTime() : NaN;
  return {
    realmId: data.realmId || data.realm_id || null,
    access_token: data.access_token || tokens.access_token || null,
    refresh_token: data.refresh_token || tokens.refresh_token || null,
    expires_at: data.expires_at || tokens.expires_at
      || (Number.isFinite(obtainedAt) ? new Date(obtainedAt + 55 * 60_000).toISOString() : null),
    env: data.env || (String(data.base_url || '').includes('sandbox') ? 'sandbox' : 'production'),
    updated_at: data.updated_at || tokens.obtained_at || null,
  };
}

async function writeStore(data) {
  const file = getStorePath();
  const tmp = `${file}.tmp`;
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const now = new Date().toISOString();
  let next;
  if (existing.tokens || existing.production || existing.realm_id) {
    next = {
      ...existing,
      realm_id: data.realmId || data.realm_id || existing.realm_id,
      tokens: {
        ...(existing.tokens || {}),
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        obtained_at: now,
      },
      updated_at: now,
    };
  } else {
    next = { ...existing, ...data, updated_at: now };
  }
  const payload = JSON.stringify(next, null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, file); // atomic replace
  await fs.chmod(file, 0o600);
}

/**
 * Returns a valid access_token, refreshing if expired or about to expire (5 min buffer).
 * Throws if no tokens stored or refresh fails.
 */
async function getValidAccessToken() {
  const store = await readStore();
  if (!store || !store.access_token) {
    throw new Error('QuickBooks not connected — no tokens stored. Visit /api/quickbooks/connect');
  }

  const expiresAt = store.expires_at ? new Date(store.expires_at).getTime() : 0;
  const now = Date.now();
  const BUFFER_MS = 5 * 60 * 1000; // 5 minutes

  if (Number.isFinite(expiresAt) && now < expiresAt - BUFFER_MS) {
    return { accessToken: store.access_token, realmId: store.realmId };
  }

  // Need to refresh
  const devCreds = await loadTokenCreds(store);
  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const auth = Buffer.from(`${devCreds.client_id}:${devCreds.client_secret}`).toString('base64');

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: store.refresh_token,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`QuickBooks token refresh failed: ${JSON.stringify(json)}`);
  }

  const newExpiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();

  await writeStore({
    realmId: store.realmId,
    access_token: json.access_token,
    refresh_token: json.refresh_token, // rotation: always save new one
    expires_at: newExpiresAt,
    env: store.env || devCreds.env || 'sandbox',
  });

  return { accessToken: json.access_token, realmId: store.realmId };
}

async function loadDevCreds() {
  const file = path.join(SECRETS_DIR, 'quickbooks-dev.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const raw = JSON.parse(await fs.readFile(getStorePath(), 'utf8'));
    const credentials = raw.production || raw.development;
    if (!credentials?.client_id || !credentials?.client_secret) throw error;
    return { ...credentials, env: raw.production ? 'production' : 'sandbox', redirect_uri: raw.redirect_uri };
  }
}

async function loadTokenCreds(store = null) {
  const normalized = store || await readStore();
  try {
    const raw = JSON.parse(await fs.readFile(getStorePath(), 'utf8'));
    const preferred = normalized?.env === 'sandbox' ? raw.development : raw.production;
    if (preferred?.client_id && preferred?.client_secret) {
      return { ...preferred, env: normalized?.env || (raw.production ? 'production' : 'sandbox') };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return loadDevCreds();
}

module.exports = { getValidAccessToken, loadDevCreds, loadTokenCreds, normalizeStore, readStore, writeStore };
