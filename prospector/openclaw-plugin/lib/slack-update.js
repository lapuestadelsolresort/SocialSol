/**
 * Slack Block Kit builders for status-line updates and modals.
 *
 * After Approve/Reject/Edit, the original draft post is mutated via
 * chat.update — the buttons are replaced with a one-line status block
 * that records who actioned the draft and when. The modal builders are
 * used for views.open on Reject (reason input) and Edit (subject + body).
 */

'use strict';

function timeHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function buildApprovedStatusBlocks({ draftId, by, hint }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft #${draftId}*  ✅ Approved by <@${by}> at ${timeHHMM()}. ${hint}`,
      },
    },
  ];
}

export function buildRejectedStatusBlocks({ draftId, by, reason }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft #${draftId}*  ❌ Rejected by <@${by}> at ${timeHHMM()}.\n_Reason:_ ${reason}`,
      },
    },
  ];
}

export function buildEditedStatusBlocks({ draftId, by, gatePass, hint }) {
  const headline = gatePass
    ? `*Draft #${draftId}*  ✅ Edited and approved by <@${by}> at ${timeHHMM()}. ${hint}`
    : `*Draft #${draftId}*  ⚠️ Edited and approved by <@${by}> at ${timeHHMM()} _with compliance gate failure_ — logged to compliance_failures. ${hint}`;
  return [{ type: 'section', text: { type: 'mrkdwn', text: headline } }];
}

export function buildRejectModal({ draftId }) {
  return {
    type: 'modal',
    callback_id: `paulina:reject_submit:${draftId}`,
    title: { type: 'plain_text', text: `Reject Draft #${draftId}` },
    submit: { type: 'plain_text', text: 'Reject' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reason_block',
        label: { type: 'plain_text', text: 'Reason for rejection?' },
        element: {
          type: 'plain_text_input',
          action_id: 'reason_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'e.g., opener too pushy; mismatched hook angle; etc.' },
        },
      },
    ],
  };
}

export function buildEditModal({ draftId, currentSubject = '', currentBody = '' }) {
  return {
    type: 'modal',
    callback_id: `paulina:edit_submit:${draftId}`,
    title: { type: 'plain_text', text: `Edit Draft #${draftId}` },
    submit: { type: 'plain_text', text: 'Save and approve' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'subject_block',
        label: { type: 'plain_text', text: 'Subject' },
        element: {
          type: 'plain_text_input',
          action_id: 'subject_input',
          initial_value: currentSubject,
        },
      },
      {
        type: 'input',
        block_id: 'body_block',
        label: { type: 'plain_text', text: 'Body' },
        element: {
          type: 'plain_text_input',
          action_id: 'body_input',
          multiline: true,
          initial_value: currentBody,
        },
      },
    ],
  };
}

export function buildDraftBlocks({ draftId, contact, campaign, persona, hookAngle, subject, body }) {
  // Used by the (future) Pathway A draft-post path. Includes three buttons.
  const personaLabel = persona?.path
    ? `${persona.path.replace(/^.*[\\/]prospector[\\/]/, 'prospector/')} (Sarah-reviewed: ${persona.frontMatter?.last_reviewed_by_sarah || 'not yet'})`
    : '(persona unavailable)';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📝 *Draft #${draftId}* — ready for review`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Contact:*\n${contact.name}${contact.email ? ` <${contact.email}>` : ''}` },
        { type: 'mrkdwn', text: `*Company:*\n${contact.company || '(none)'}` },
        { type: 'mrkdwn', text: `*Campaign:*\n${campaign.slug || campaign.name}` },
        { type: 'mrkdwn', text: `*Hook:*\n${hookAngle}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Subject:* ${subject}\n*Persona:* ${personaLabel}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '```\n' + body + '\n```' },
    },
    { type: 'divider' },
    {
      type: 'actions',
      block_id: `paulina_draft_actions_${draftId}`,
      elements: [
        {
          type: 'button',
          action_id: `paulina:approve:${draftId}`,
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
        },
        {
          type: 'button',
          action_id: `paulina:reject_modal:${draftId}`,
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
        },
        {
          type: 'button',
          action_id: `paulina:edit_modal:${draftId}`,
          text: { type: 'plain_text', text: 'Edit' },
        },
      ],
    },
  ];
}
