/**
 * Unsubscribe artifacts builder for outbound prospect sends.
 *
 * Single token per send, embedded in three places:
 *   1. List-Unsubscribe header URL (machine-readable for Gmail/Yahoo)
 *   2. List-Unsubscribe header mailto (older mail clients + future inbound parser)
 *   3. Body clickable link (per compliance-elements.md spec)
 *
 * The compliance gate's item 4 verifies every URL across the header AND body
 * surfaces signs back to the recipient's contactId — that's the check that
 * catches a composer regression where the wrong contact's token gets
 * templated into the email body.
 *
 * The mailto target `unsubscribe@outreach.lapuestadelsolresort.com` is a
 * dedicated alias (separate from sarah@) so triage of "I want to unsubscribe"
 * vs "I want to talk to Sarah" is possible. Forwards to Sarah + Jason via
 * ImprovMX (manual operator step; documented in Project_Status.md).
 */

const { generateUnsubscribeToken } = require('../../crm/lib/unsubscribe');

const UNSUB_URL_BASE = 'https://webhook.lapuestadelsolresort.com/unsubscribe';
const UNSUB_MAILTO = 'mailto:unsubscribe@outreach.lapuestadelsolresort.com?subject=unsubscribe';

function buildUnsubscribeArtifacts(contactId, campaignName) {
  const token = generateUnsubscribeToken(contactId, campaignName);
  const url = `${UNSUB_URL_BASE}?token=${token}`;
  return {
    token,
    url,
    headers: {
      'List-Unsubscribe': `<${UNSUB_MAILTO}>, <${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

module.exports = { buildUnsubscribeArtifacts, UNSUB_URL_BASE, UNSUB_MAILTO };
