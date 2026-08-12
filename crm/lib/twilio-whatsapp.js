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
  normalizeTwilioEffectState,
  sendWhatsApp,
  statusCallbackUrl,
};
