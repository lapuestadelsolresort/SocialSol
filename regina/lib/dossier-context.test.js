'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSendMethod } = require('./dossier-context');

test('email remains manual unless auto-send is explicitly enabled', () => {
  const contact = { preferred_channel: 'email', contact_provenance: 'direct' };
  assert.equal(resolveSendMethod(contact), 'manual_email');
  assert.equal(resolveSendMethod(contact, { autoSendEnabled: false }), 'manual_email');
  assert.equal(resolveSendMethod(contact, { autoSendEnabled: true }), 'resend');
});

test('Airbnb-only provenance can never become an automated email', () => {
  const contact = {
    preferred_channel: 'email',
    contact_provenance: 'airbnb_thread_only',
  };
  assert.equal(
    resolveSendMethod(contact, { autoSendEnabled: true }),
    'manual_airbnb_thread',
  );
});

test('WhatsApp and Airbnb preferred channels remain manual', () => {
  assert.equal(
    resolveSendMethod(
      { preferred_channel: 'whatsapp', contact_provenance: 'direct' },
      { autoSendEnabled: true },
    ),
    'manual_whatsapp',
  );
  assert.equal(
    resolveSendMethod(
      { preferred_channel: 'airbnb_thread', contact_provenance: 'direct' },
      { autoSendEnabled: true },
    ),
    'manual_airbnb_thread',
  );
});
