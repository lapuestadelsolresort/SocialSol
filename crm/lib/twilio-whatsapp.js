'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRETS_PATH = path.join(SECRETS_DIR, 'twilio.json');
// Twilio Programmable Messaging rejects a Body longer than 1,600 characters.
// Enforce the provider boundary locally so an explicit Slack command cannot
// create a known-to-fail external request.
const MAX_MESSAGE_LENGTH = 1600;

function loadTwilioSecrets(file = SECRETS_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function statusCallbackUrl(secrets = {}) {
  if (secrets.twilio_status_callback_url) return secrets.twilio_status_callback_url;
  if (process.env.TWILIO_STATUS_CALLBACK_URL) return process.env.TWILIO_STATUS_CALLBACK_URL;
  const origin = String(process.env.PUBLIC_CRM_ORIGIN || 'https://webhook.lapuestadelsolresort.com').replace(/\/+$/, '');
  return `${origin}/webhook/twilio-whatsapp/status`;
}

function normalizeTwilioEffectState(providerStatus) {
  const status = String(providerStatus || '').toLowerCase();
  if (status === 'accepted') return 'accepted_by_provider';
  if (status === 'scheduled' || status === 'queued') return 'queued';
  if (status === 'sending') return 'accepted_by_provider';
  if (status === 'sent') return 'sent';
  if (status === 'delivered') return 'delivered';
  if (status === 'read') return 'read';
  if (status === 'failed' || status === 'undelivered' || status === 'canceled') return 'failed';
  return 'accepted_by_provider';
}

function monotonicTwilioStatus(current, next) {
  const rank = new Map([
    ['requested', -1],
    ['accepted_by_provider', 0],
    ['queued', 1],
    ['sent', 2],
    ['delivered', 3],
    ['read', 4],
  ]);
  if (!current) return next;
  if (current === 'failed' || current === 'read') return current;
  if (next === 'failed') return ['delivered', 'read'].includes(current) ? current : 'failed';
  return (rank.get(next) ?? 0) >= (rank.get(current) ?? 0) ? next : current;
}

function isoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

async function readWhatsAppMessageStatus({
  messageSid,
  secrets = loadTwilioSecrets(),
  fetchImpl = fetch,
}) {
  const sid = String(messageSid || '').trim();
  if (!/^SM[a-zA-Z0-9]{32}$/.test(sid)) throw new Error('invalid Twilio message SID');
  if (!secrets.account_sid || !secrets.api_key_sid || !secrets.api_key_secret) {
    throw new Error('Twilio read credentials not configured');
  }
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${secrets.account_sid}/Messages/${sid}.json`;
  const authHeader = `Basic ${Buffer.from(`${secrets.api_key_sid}:${secrets.api_key_secret}`).toString('base64')}`;
  let response;
  try {
    response = await fetchImpl(twilioUrl, {
      method: 'GET',
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (cause) {
    const error = new Error(`Twilio message status lookup failed for ${sid}`);
    error.code = 'twilio_status_lookup_unavailable';
    error.retryable = true;
    error.cause = cause;
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code) {
    const error = new Error(result.message || `Twilio message status lookup returned ${response.status}`);
    error.code = result.code ? `twilio_${result.code}` : `twilio_http_${response.status}`;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  const providerStatus = String(result.status || '').toLowerCase();
  if (!providerStatus) throw new Error(`Twilio returned no message status for ${sid}`);
  return {
    messageSid: String(result.sid || sid),
    status: normalizeTwilioEffectState(providerStatus),
    providerStatus,
    sentAt: isoTimestamp(result.date_sent || result.date_created),
    statusUpdatedAt: isoTimestamp(result.date_updated || result.date_sent || result.date_created),
    errorCode: result.error_code === null || result.error_code === undefined
      ? null : String(result.error_code),
    errorMessage: result.error_message ? String(result.error_message).slice(0, 500) : null,
  };
}

async function sendWhatsApp({
  toPhone,
  message,
  secrets = loadTwilioSecrets(),
  fetchImpl = fetch,
  callbackUrl = statusCallbackUrl(secrets),
}) {
  const replyText = typeof message === 'string' ? message.trim() : '';
  if (!/^\+\d{7,15}$/.test(String(toPhone || ''))) throw new Error('invalid WhatsApp destination');
  if (!replyText) throw new Error('WhatsApp message is required');
  if (replyText.length > MAX_MESSAGE_LENGTH) throw new Error('WhatsApp message is too long');
  if (!secrets.account_sid || !secrets.api_key_sid || !secrets.api_key_secret || !secrets.whatsapp_number) {
    throw new Error('Twilio credentials not configured');
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${secrets.account_sid}/Messages.json`;
  const authHeader = `Basic ${Buffer.from(`${secrets.api_key_sid}:${secrets.api_key_secret}`).toString('base64')}`;
  const fields = {
    From: `whatsapp:${secrets.whatsapp_number}`,
    To: `whatsapp:${toPhone}`,
    Body: replyText,
  };
  if (callbackUrl) fields.StatusCallback = callbackUrl;

  let response;
  try {
    response = await fetchImpl(twilioUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    error.code = 'ambiguous_external_result';
    error.retryable = false;
    error.ambiguous = true;
    error.requestDispatched = true;
    throw error;
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code || !result.sid) {
    const error = new Error(result.message || `Twilio send failed (${response.status})`);
    error.code = result.code ? `twilio_${result.code}` : `twilio_http_${response.status}`;
    error.retryable = false;
    error.requestDispatched = true;
    if (response.status === 429 || response.status >= 500 || response.ok) {
      error.code = 'ambiguous_external_result';
      error.ambiguous = true;
    }
    throw error;
  }
  return result;
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  SECRETS_PATH,
  loadTwilioSecrets,
  monotonicTwilioStatus,
  normalizeTwilioEffectState,
  readWhatsAppMessageStatus,
  sendWhatsApp,
  statusCallbackUrl,
};
