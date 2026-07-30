'use strict';
//
// voice-service.js — re-export shim. The real client lives at
// crm/lib/voice-service.js (promoted in R7 so sarah-coach and future
// Voice Service callers can share it without reaching across agents).
//
// This shim keeps existing regina imports (regina/scripts/batch.js,
// anniversary-cron.js, gmail-reconcile.js, et al.) working unchanged.
// Pattern mirrors the R5 promotion of slack-post.js.

module.exports = require('../../crm/lib/voice-service');
