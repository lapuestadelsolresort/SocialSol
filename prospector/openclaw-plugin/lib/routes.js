/**
 * Action dispatch — parses `paulina:<action>:<id>` action_ids/callback_ids
 * and routes each to the corresponding CRM endpoint built in Step 3.2 Phase A.
 *
 * Pure JS, no Slack SDK dependencies — testable in isolation. The Slack-side
 * wiring lives in ../index.js; this module just translates an action into
 * an HTTP call against the CRM and returns a structured result for the
 * caller to render back into Slack.
 */

'use strict';

import { buildRejectModal, buildEditModal, buildApprovedStatusBlocks, buildRejectedStatusBlocks, buildEditedStatusBlocks } from './slack-update.js';

const ALLOWED_USERS = new Set(
  (process.env.PAULINA_AUTHORIZED_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function isAuthorized(slackUserId) {
  return ALLOWED_USERS.has(slackUserId);
}

function timeHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function postCRM(crmBaseUrl, path, body) {
  const resp = await fetch(`${crmBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}

export async function dispatchAction({ data, payload, crmBaseUrl }) {
  // data starts with `paulina:` and the prefix has already been validated by
  // resolveNamespaceMatch in the runtime. Here we re-parse to get action+id.
  const segments = String(data).split(':');
  // data is the post-namespace remainder (e.g., "approve:487") — see plugin-runtime
  // resolveNamespaceMatch which strips the namespace before invoking us.
  const action = segments[0];
  const id = segments[1];
  const slackUserId = payload?.user?.id || null;
  if (!isAuthorized(slackUserId)) {
    return { kind: 'error', message: '❌ Not authorized.' };
  }

  switch (action) {
    case 'approve': {
      const r = await postCRM(crmBaseUrl, `/api/drafts/${id}/approve`, { by: slackUserId });
      if (!r.ok) return { kind: 'error', message: `❌ Approve failed: ${r.json.error || r.status}` };
      const hint = r.json.message_hint || 'Queued for send.';
      return {
        kind: 'update_message',
        blocks: buildApprovedStatusBlocks({ draftId: id, by: slackUserId, hint }),
        fallback: `✅ Approved by <@${slackUserId}> at ${timeHHMM()}. ${hint}`,
        threadReply: `✅ Approved by <@${slackUserId}> at ${timeHHMM()}. ${hint}`,
      };
    }
    case 'reject_modal': {
      return { kind: 'open_modal', view: buildRejectModal({ draftId: id }) };
    }
    case 'edit_modal': {
      // Caller (index.js) will fetch the current subject/body via GET /api/outreach-sends?id=
      // before opening the modal, then pass them into buildEditModal.
      return { kind: 'open_modal', view: buildEditModal({ draftId: id }) };
    }
    case 'reject_submit': {
      // Submitted via view_submission. The reason came from the modal.
      const reason = payload?.view?.state?.values?.reason_block?.reason_input?.value || '(no reason)';
      const r = await postCRM(crmBaseUrl, `/api/drafts/${id}/reject`, { reason, by: slackUserId });
      if (!r.ok) return { kind: 'error', message: `❌ Reject failed: ${r.json.error || r.status}` };
      return {
        kind: 'update_message',
        blocks: buildRejectedStatusBlocks({ draftId: id, by: slackUserId, reason }),
        fallback: `❌ Rejected by <@${slackUserId}> at ${timeHHMM()}. Reason: ${reason}`,
        threadReply: `❌ Rejected by <@${slackUserId}>. Reason: ${reason}. Draft discarded.`,
      };
    }
    case 'edit_submit': {
      const subject = payload?.view?.state?.values?.subject_block?.subject_input?.value;
      const body = payload?.view?.state?.values?.body_block?.body_input?.value;
      if (!subject || !body) return { kind: 'error', message: '❌ Edit failed: subject and body are required.' };
      const r = await postCRM(crmBaseUrl, `/api/drafts/${id}/edit`, { subject, body, by: slackUserId });
      if (!r.ok) return { kind: 'error', message: `❌ Edit failed: ${r.json.error || r.status}` };
      const gate = r.json.gate || { pass: true, failures: [] };
      const hint = r.json.paused ? '⏸ Approved but paused — will send on !resume.' : 'Queued for send.';
      const warning = !gate.pass
        ? `⚠️ Edited draft #${id} auto-approved by <@${slackUserId}> with compliance gate failure: ${gate.failures.map((f) => f.failed_check).join(', ')}. Logged to compliance_failures for review. ${hint}`
        : null;
      return {
        kind: 'update_message',
        blocks: buildEditedStatusBlocks({ draftId: id, by: slackUserId, gatePass: gate.pass, hint }),
        fallback: warning || `✅ Edited and approved by <@${slackUserId}> at ${timeHHMM()}. ${hint}`,
        threadReply: warning || `📝 Edited and approved by <@${slackUserId}> at ${timeHHMM()}. ${hint}`,
      };
    }
    case 'reply_hot':
    case 'reply_not_interested':
    case 'reply_needs_sarah': {
      const quality = action === 'reply_hot' ? 'hot'
        : action === 'reply_not_interested' ? 'not_interested'
        : 'ambiguous';
      // For reply_needs_sarah, we keep quality=ambiguous on the contact and just thread-reply with @sarah.
      const r = await postCRM(crmBaseUrl, `/api/contacts/${id}/reply-classify`, { quality, by: slackUserId });
      if (!r.ok) return { kind: 'error', message: `❌ Classify failed: ${r.json.error || r.status}` };
      const label = quality === 'hot' ? '🔥 Marked hot' : quality === 'not_interested' ? '🚫 Marked not interested + suppressed' : '👀 Needs Sarah';
      const escalationUserId = process.env.PAULINA_ESCALATION_USER_ID;
      return {
        kind: 'update_message',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${label} by <@${slackUserId}>.` } }],
        fallback: label,
        threadReply: action === 'reply_needs_sarah' && escalationUserId
          ? `<@${escalationUserId}> needs your eyes on this reply.`
          : `${label} by <@${slackUserId}>.`,
      };
    }
    default:
      return { kind: 'error', message: `❌ Unknown action: ${action}` };
  }
}
