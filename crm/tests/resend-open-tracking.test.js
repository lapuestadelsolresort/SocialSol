'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

test('Resend webhook records the first email.opened event', () => {
  assert.match(SERVER_SOURCE, /case 'email\.opened':/);
  assert.match(
    SERVER_SOURCE,
    /UPDATE outreach_sends SET status = 'opened', opened_at = \$\{now\} WHERE id = \$\{send\.id\}/,
  );
  assert.match(
    SERVER_SOURCE,
    /else if \(!send\.opened_at\)[\s\S]*UPDATE outreach_sends SET opened_at = \$\{now\}/,
  );
});

test('Resend webhook verifies the signed payload before processing send events', () => {
  const verification = SERVER_SOURCE.indexOf("wh.verify(req.rawBody.toString('utf8')");
  const openHandler = SERVER_SOURCE.indexOf("case 'email.opened':");
  assert.ok(verification >= 0, 'signed webhook verification is required');
  assert.ok(openHandler > verification, 'open events must run only after signature verification');
});
