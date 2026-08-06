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
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeStore(data) {
  const file = getStorePath();
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(
    { ...data, updated_at: new Date().toISOString() },
    null,
    2
  );
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

  const expiresAt = new Date(store.expires_at).getTime();
  const now = Date.now();
  const BUFFER_MS = 5 * 60 * 1000; // 5 minutes

  if (now < expiresAt - BUFFER_MS) {
    return { accessToken: store.access_token, realmId: store.realmId };
  }

  // Need to refresh
  const devCreds = await loadDevCreds();
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
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

module.exports = { readStore, writeStore, getValidAccessToken, loadDevCreds };
