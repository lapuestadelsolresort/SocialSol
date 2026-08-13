#!/usr/bin/env node
'use strict';

require('../../lib/runtime-paths');
const { verifySendScope } = require('../lib/gmail-client');

verifySendScope().then(result => {
  console.log(JSON.stringify({ ok: true, gmailSendScopeAuthorized: true, mailbox: result.emailAddress }));
}).catch(error => {
  console.error(`[verify-gmail-send-scope] ${error.message}`);
  process.exitCode = 1;
});
