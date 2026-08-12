'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;
const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_RECEIPT_FILES_DIR = path.join(ROOT, 'runtime', 'receipt-files');

function safeSegment(value, fallback = 'item') {
  const cleaned = String(value || '').normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    .slice(0, 160);
  return cleaned || fallback;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function resolveSlackAccount(config) {
  const accounts = config.channels?.slack?.accounts || {};
  const requested = process.env.OPENCLAW_SLACK_ACCOUNT
    || config.plugins?.entries?.['resort-workflows']?.config?.slackAccountId
    || '';
  if (requested && accounts[requested]) return { id: requested, account: accounts[requested] };
  const entries = Object.entries(accounts);
  if (entries.length === 1) return { id: entries[0][0], account: entries[0][1] };
  throw new Error('OPENCLAW_SLACK_ACCOUNT is required to retrieve receipt files');
}

function loadSlackCredential() {
  const configPath = path.resolve(process.env.OPENCLAW_CONFIG_PATH || DEFAULT_OPENCLAW_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { id, account } = resolveSlackAccount(config);
  if (typeof account.botToken !== 'string' || !account.botToken.startsWith('xoxb-')) {
    throw new Error(`Slack bot token is unavailable for account ${id}`);
  }
  return { accountId: id, token: account.botToken };
}

async function slackApi(method, params, token, fetchImpl = fetch) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    const error = new Error(`Slack ${method} failed: ${payload.error || response.status}`);
    error.code = 'slack_receipt_read_failed';
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return payload;
}

async function downloadSlackFile(file, token, destinationDirectory, fetchImpl = fetch) {
  const expectedSize = Number(file.size || 0);
  if (expectedSize > MAX_FILE_BYTES) throw new Error(`Slack receipt file exceeds ${MAX_FILE_BYTES} bytes`);
  const url = file.url_private_download || file.url_private;
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Slack receipt file has no private download URL');
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname !== 'slack.com' && !hostname.endsWith('.slack.com')) {
    throw new Error('Slack receipt file URL is outside the Slack domain');
  }

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const error = new Error(`Slack receipt download failed: ${response.status}`);
    error.code = 'slack_receipt_download_failed';
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Slack receipt file exceeds ${MAX_FILE_BYTES} bytes`);
  if (expectedSize && expectedSize !== buffer.length) throw new Error('Slack receipt download size mismatch');

  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const name = safeSegment(file.name || file.title || `${file.id || 'receipt'}.${file.filetype || 'bin'}`);
  const destination = path.join(destinationDirectory, `${safeSegment(file.id, 'file')}-${name}`);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, buffer, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
  return {
    id: String(file.id || '').slice(0, 160),
    name: String(file.name || file.title || name).slice(0, 300),
    mimetype: String(file.mimetype || '').slice(0, 160),
    size: buffer.length,
    sha256: sha256(buffer),
    localPath: destination,
  };
}

function isReceiptLikeText(text) {
  const value = String(text || '');
  const hasAmount = /(?:\$\s*)?\d[\d,.]*\s*(?:mxn|usd|pesos?|d[oó]lares?)\b|\$\s*\d[\d,.]*/i.test(value);
  const hasExpenseContext = /\b(?:receipt|invoice|factura|recibo|expense|gasto|paid|pago|payment|vendor|proveedor|reimburse|reembolso|liabilit|due\s+(?:to|from))\b/i.test(value);
  return hasAmount && hasExpenseContext;
}

async function fetchSlackReceiptSource({ channelId, messageId, threadTs = null }, options = {}) {
  if (!/^[A-Z][A-Z0-9]+$/.test(String(channelId || ''))) throw new Error('valid Slack channel id is required');
  if (!/^\d+(?:\.\d+)?$/.test(String(messageId || ''))) throw new Error('valid Slack message timestamp is required');
  const fetchImpl = options.fetchImpl || fetch;
  const credential = options.credential || loadSlackCredential();
  const payload = await slackApi('conversations.replies', {
    channel: channelId,
    ts: threadTs || messageId,
    limit: threadTs ? 100 : 1,
    inclusive: true,
  }, credential.token, fetchImpl);
  const message = (payload.messages || []).find(candidate => String(candidate.ts) === String(messageId));
  if (!message) throw new Error('Slack receipt message was not found by exact timestamp');

  const rawFiles = (Array.isArray(message.files) ? message.files : [])
    .filter(file => file && file.file_access !== 'blocked' && file.mode !== 'tombstone')
    .slice(0, MAX_FILES);
  const baseDirectory = path.resolve(options.receiptFilesDir || process.env.RECEIPT_FILES_DIR || DEFAULT_RECEIPT_FILES_DIR);
  const destinationDirectory = path.join(baseDirectory, safeSegment(channelId), safeSegment(messageId));
  const files = [];
  for (const file of rawFiles) {
    files.push(await downloadSlackFile(file, credential.token, destinationDirectory, fetchImpl));
  }
  const text = String(message.text || '');
  return {
    channelId,
    messageId,
    messageText: text,
    submittedAt: message.ts ? new Date(Number(message.ts) * 1000).toISOString() : null,
    files,
    shouldProcess: files.length > 0 || isReceiptLikeText(text),
  };
}

module.exports = {
  DEFAULT_OPENCLAW_CONFIG_PATH,
  DEFAULT_RECEIPT_FILES_DIR,
  MAX_FILE_BYTES,
  MAX_FILES,
  downloadSlackFile,
  fetchSlackReceiptSource,
  isReceiptLikeText,
  loadSlackCredential,
  resolveSlackAccount,
  safeSegment,
  sha256,
  slackApi,
};
