'use strict';
//
// voice-intents.js — single source of truth for the Voice Service intent enum.
//
// Imported by both:
//   - crm/routes/voice-draft.js  (request validation)
//   - regina/lib/campaign-loader.js  (strategy-file validation)
//
// Adding a new intent = one edit here. Do NOT hand-copy this list elsewhere.

const INTENT_VALUES = Object.freeze([
  'reactivation_anniversary',
  'reactivation_winback',
  'reactivation_referral',
  'reactivation_conversion',
  'reactivation_vip',
  'reactivation_feedback_closure',
  'inbound_inquiry_response',
  'cold_outbound_planner',
  'ad_hoc',
]);

const INTENT_SET = new Set(INTENT_VALUES);

function isValidIntent(intent) {
  return typeof intent === 'string' && INTENT_SET.has(intent);
}

module.exports = { INTENT_VALUES, INTENT_SET, isValidIntent };
