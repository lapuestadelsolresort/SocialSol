'use strict';

const crypto = require('node:crypto');
const { sql } = require('@databases/sqlite');
const { addSuppression } = require('../lib/suppressions');
const { classifyReply, normalizeEmail } = require('../lib/email-conversations');
const { sendGmailReply, readSentMessage } = require('../lib/gmail-client');
const { loadPolicy } = require('../lib/channel-policy');

const PROPOSAL_TTL_MS = 15 * 60_000;
const QUALITIES = new Set(['hot', 'not_interested', 'ambiguous']);

function prospectorChannelId(policy = loadPolicy()) {
  return Object.entries(policy.channels || {})
    .find(([, channel]) => channel.name === 'prospector-paulina')?.[0] || null;
}

function replySubject(subject) {
  const value = String(subject || '').trim();
  return /^re\s*:/i.test(value) ? value : `Re: ${value || 'La Puesta del Sol'}`;
}

function validateReplyRequest(input) {
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  const threadTs = typeof input?.threadTs === 'string' ? input.threadTs.trim() : '';
  if (!message || message.length > 10_000) throw new Error('email reply must contain 1–10000 characters');
  if (!threadTs) throw new Error('email reply must be in the original Slack draft thread');
}

function validateConfirmation(input) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input?.proposalId || ''))) {
    throw new Error('valid email reply proposalId is required');
  }
  if (!/^[0-9a-f]{12}$/i.test(String(input?.acceptanceHash || ''))) {
    throw new Error('valid email reply acceptanceHash is required');
  }
  if (!String(input?.threadTs || '').trim()) throw new Error('email confirmation must be in the original Slack thread');
}

function validateClassification(input) {
  const eventId = Number.parseInt(input?.eventId, 10);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('valid email eventId is required');
  if (!QUALITIES.has(input?.quality)) throw new Error('quality must be hot, not_interested, or ambiguous');
  if (!String(input?.threadTs || '').trim()) throw new Error('email classification must be in the original Slack thread');
}

async function clearFalseNegativeSuppression(db, contact, event = null) {
  if (!contact?.email || contact.do_not_contact_reason !== 'negative_reply') return false;
  const rows = await db.query(sql`SELECT id, source, notes FROM suppressions
    WHERE LOWER(email)=${normalizeEmail(contact.email)} AND reason='negative_reply'`);
  // `reply_classify` is the legacy path that classified the full MIME body,
  // including the quoted outreach footer. A suppression created by this
  // classifier is repairable only when the same event is being reclassified;
  // this keeps unrelated explicit negative replies fail-closed.
  const eventNote = event ? `Email event #${event.id} classified not_interested` : null;
  const repairable = rows.filter(row => row.source === 'reply_classify'
    || (event?.classification_source === 'email_conversation_classifier'
      && event.sentiment === 'not_interested'
      && row.source === 'email_conversation_classifier'
      && row.notes === eventNote));
  if (!repairable.length) return false;
  const [{ count: otherNegatives }] = await db.query(sql`SELECT COUNT(*) AS count
    FROM email_threads WHERE contact_id=${contact.id} AND direction='inbound'
      AND sentiment='not_interested' AND id<>${event?.id || 0}`);
  if (Number(otherNegatives) > 0) return false;
  for (const row of repairable) await db.query(sql`DELETE FROM suppressions WHERE id=${row.id}`);
  await db.query(sql`UPDATE contacts SET do_not_contact=0, do_not_contact_reason=NULL,
    status='replied', updated_at=datetime('now') WHERE id=${contact.id}`);
  return true;
}

async function applyClassification(db, event, classification, { actorUserId = null, manual = false } = {}) {
  const now = new Date().toISOString();
  const [contact] = event.contact_id
    ? await db.query(sql`SELECT * FROM contacts WHERE id=${event.contact_id}`)
    : [];
  const source = manual ? `slack:${actorUserId || 'unknown'}` : 'email_conversation_classifier';
  await db.query(sql`UPDATE email_threads SET sentiment=${classification.quality},
    sentiment_notes=${classification.reason || (manual ? 'manual_classification' : null)},
    classification_source=${source}, classified_at=${now}, updated_at=${now}
    WHERE id=${event.id}`);

  if (event.outreach_send_id) {
    await db.query(sql`UPDATE outreach_sends SET
      reply_detected_at=COALESCE(reply_detected_at, ${event.received_at || now}),
      status=CASE WHEN status IN ('bounced','complained','cancelled') THEN status ELSE 'replied' END
      WHERE id=${event.outreach_send_id}`);
  }
  if (!contact) return { suppressionRepaired: false, suppressed: false };

  const suppressionRepaired = classification.quality !== 'not_interested'
    ? await clearFalseNegativeSuppression(db, contact, event)
    : false;

  if (classification.quality === 'hot') {
    await db.query(sql`UPDATE contacts SET status='replied', reply_status='positive',
      lead_quality='hot', updated_at=${now} WHERE id=${contact.id}`);
    return { suppressionRepaired, suppressed: false };
  }
  if (classification.quality === 'not_interested') {
    await addSuppression(db, {
      email: contact.email,
      reason: 'negative_reply',
      source: manual ? 'reply_classify' : 'email_conversation_classifier',
      notes: `Email event #${event.id} classified not_interested`,
      addedBy: manual ? `slack_command:${actorUserId || 'unknown'}` : 'system_classifier',
      cascadeContactId: contact.id,
    });
    await db.query(sql`UPDATE contacts SET reply_status='negative', lead_quality='not_interested',
      updated_at=${now} WHERE id=${contact.id}`);
    return { suppressionRepaired: false, suppressed: true };
  }
  await db.query(sql`UPDATE contacts SET status='replied', reply_status='ambiguous',
    lead_quality='ambiguous', updated_at=${now}
    WHERE id=${contact.id} AND do_not_contact=0
      AND (lead_quality IS NULL OR lead_quality <> 'hot')`);
  return { suppressionRepaired, suppressed: false };
}

function quotedBody(body, limit = 2800) {
  const text = String(body || '').trim().slice(0, limit);
  return text ? `> ${text.split('\n').join('\n> ')}` : '> (empty message)';
}

const observeDefinition = {
  name: 'email.message.observe',
  version: 3,
  capability: 'email.read',
  mutates: false,
  notificationChannelName: 'prospector-paulina',
  steps: [
    {
      key: 'load_event', effectClass: 'read', maxAttempts: 1,
      async run({ db, input }) {
        const eventId = Number.parseInt(input.emailThreadId, 10);
        const [event] = await db.query(sql`SELECT et.*, c.name AS contact_name, c.email AS contact_email,
          os.sent_at AS original_sent_at, os.subject AS original_subject,
          os.slack_channel_id AS send_slack_channel_id, os.slack_message_ts AS send_slack_thread_ts,
          oc.slug AS campaign_slug
          FROM email_threads et
          LEFT JOIN contacts c ON c.id=et.contact_id
          LEFT JOIN outreach_sends os ON os.id=et.outreach_send_id
          LEFT JOIN outreach_campaigns oc ON oc.id=os.campaign_id
          WHERE et.id=${eventId}`);
        if (!event) throw new Error('email conversation event was not found');
        return event;
      },
    },
    {
      key: 'project_event', effectClass: 'local_write', maxAttempts: 3,
      async run({ db, run, state, store, stepKey }) {
        const event = state.load_event;
        let classification = null;
        let projection = { suppressionRepaired: false, suppressed: false };
        if (event.direction === 'inbound' && event.outreach_send_id) {
          const classified = classifyReply(event.body_text || event.raw_body_text || '');
          classification = {
            quality: classified.quality,
            reason: classified.reason,
            confidence: classified.confidence,
          };
          projection = await applyClassification(db, event, classification);
        }
        const classificationChanged = Boolean(classification && event.sentiment
          && (event.sentiment !== classification.quality
            || String(event.sentiment_notes || '') !== String(classification.reason || '')));
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: `email.${event.provider || 'gmail'}`,
          sourceRef: event.provider_message_id || String(event.id),
          observedAt: event.received_at || new Date().toISOString(),
          payload: {
            emailThreadId: event.id,
            direction: event.direction,
            outreachSendId: event.outreach_send_id,
            providerThreadId: event.provider_thread_id,
            bodyHash: store.sha256(event.body_text || ''),
            classification: classification ? {
              quality: classification.quality,
              reason: classification.reason,
              confidence: classification.confidence,
            } : null,
          },
        });
        await db.query(sql`UPDATE email_threads SET workflow_run_id=${run.id},
          processing_status='processed', processing_error=NULL, processed_at=datetime('now'),
          updated_at=datetime('now') WHERE id=${event.id}`);
        return {
          classification,
          classificationChanged,
          previousClassification: event.sentiment || null,
          previousClassificationReason: event.sentiment_notes || null,
          evidenceId: evidence.id,
          ...projection,
        };
      },
    },
    {
      key: 'notify_slack_thread', effectClass: 'internal_notification', maxAttempts: 1,
      async run({ db, run, state, store }) {
        const event = state.load_event;
        const projected = state.project_event;
        const channelId = event.slack_channel_id || event.send_slack_channel_id || prospectorChannelId();
        const threadTs = event.slack_thread_ts || event.send_slack_thread_ts || null;
        if (!channelId) return { queued: false, reason: 'no_channel' };
        const quality = projected.classification?.quality || 'ambiguous';
        let message;
        if (!event.outreach_send_id) {
          message = [
            '⚠️ *Unresolved email reply* — no outreach send could be matched.',
            `From: ${event.from_address || '(unknown)'}`,
            `Subject: ${event.subject || '(none)'}`,
            '',
            quotedBody(event.body_text),
            '',
            `Email event: ${event.id} · Workflow: ${run.id}`,
          ].join('\n');
        } else if (event.direction === 'outbound') {
          message = [
            `📤 *Email response recorded* — ${event.to_address || event.contact_email}`,
            '', quotedBody(event.body_text), '',
            `Sent through ${event.provider === 'gmail' ? 'Sarah’s Gmail' : event.provider}.`,
            `Email event: ${event.id} · Draft #${event.outreach_send_id} · Workflow: ${run.id} · Evidence: ${projected.evidenceId}`,
          ].join('\n');
        } else {
          const heading = projected.classificationChanged
            ? `🔄 *Email classification corrected for ${event.contact_name || event.from_address || event.contact_email}*`
            : `📬 *Reply from ${event.contact_name || ''} <${event.from_address || event.contact_email}>*`;
          message = [
            heading,
            `Original: Draft #${event.outreach_send_id} sent ${event.original_sent_at || '(unknown)'} (${event.campaign_slug || 'unknown campaign'})`,
            '', quotedBody(event.body_text), '',
            projected.classificationChanged
              ? `Previous classification: *${projected.previousClassification}*${projected.previousClassificationReason ? ` (${projected.previousClassificationReason})` : ''}`
              : null,
            `Classification: *${quality}* (${projected.classification?.reason || 'no deterministic signal'})`,
            projected.suppressionRepaired ? 'A prior false-negative suppression was removed.' : null,
            `To answer from this thread: \`!email reply <your message>\``,
            `To correct classification: \`!email classify ${event.id} hot|not_interested|ambiguous\``,
            `Email event: ${event.id} · Workflow: ${run.id} · Evidence: ${projected.evidenceId}`,
          ].filter(Boolean).join('\n');
        }
        const projectionKey = projected.classificationChanged
          ? `email-thread:${event.id}:classification:${quality}:${projected.classification?.reason || 'unspecified'}:v${observeDefinition.version}:slack`
          : `email-thread:${event.id}:slack`;
        await store.enqueueOutbox(db, {
          runId: run.id,
          topic: 'slack.notification',
          idempotencyKey: projectionKey,
          payload: { channelId, threadTs, message, emailThreadId: event.id },
        });
        return { queued: true, channelId, threadTs };
      },
    },
  ],
  output({ state }) {
    return {
      status: 'recorded',
      emailThreadId: state.load_event.id,
      outreachSendId: state.load_event.outreach_send_id,
      direction: state.load_event.direction,
      classification: state.project_event.classification,
      evidenceId: state.project_event.evidenceId,
      slackQueued: state.notify_slack_thread.queued,
    };
  },
};

const proposeDefinition = {
  name: 'email.reply.propose',
  version: 1,
  capability: 'email.send',
  mutates: false,
  allowedTriggers: ['slack_email_reply_command'],
  validate: validateReplyRequest,
  steps: [
    {
      key: 'resolve_thread', effectClass: 'read', maxAttempts: 1,
      async run({ db, run, input }) {
        const threadTs = typeof input.threadTs === 'string' ? input.threadTs.trim() : '';
        const rows = await db.query(sql`SELECT os.*, c.name AS contact_name, c.email AS contact_email
          FROM outreach_sends os JOIN contacts c ON c.id=os.contact_id
          WHERE os.slack_message_ts=${threadTs} ORDER BY os.sent_at DESC LIMIT 1`);
        const send = rows[0];
        if (!send || !send.sent_at) throw new Error('sent outreach message was not found for this Slack thread');
        if (run.channel_id !== send.slack_channel_id) throw new Error('email reply must be proposed from the original outreach channel');
        if (threadTs && threadTs !== send.slack_message_ts) throw new Error('email reply must be proposed in the original draft thread');
        const [inbound] = await db.query(sql`SELECT * FROM email_threads
          WHERE outreach_send_id=${send.id} AND direction='inbound'
          ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1`);
        if (!inbound) throw new Error('no recorded inbound email exists for this outreach thread');
        return {
          sendId: send.id,
          contactId: send.contact_id,
          contactName: send.contact_name,
          toAddress: send.contact_email,
          subject: replySubject(inbound.subject || send.subject),
          slackChannelId: send.slack_channel_id,
          slackThreadTs: send.slack_message_ts,
          inboundEmailThreadId: inbound.id,
          providerThreadId: inbound.provider_thread_id,
          inReplyTo: inbound.rfc_message_id,
          references: [inbound.references_header, inbound.rfc_message_id]
            .filter(Boolean).join(' ').trim(),
        };
      },
    },
    {
      key: 'persist_proposal', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, input, state, store, stepKey }) {
        const target = state.resolve_thread;
        const bodyText = input.message.trim();
        const requestHash = store.sha256({
          sendId: target.sendId, to: target.toAddress, subject: target.subject,
          bodyText, inboundEmailThreadId: target.inboundEmailThreadId,
        });
        const proposalId = crypto.randomUUID();
        const acceptanceHash = store.sha256(`${proposalId}:${requestHash}`).slice(0, 12);
        const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
        await db.query(sql`INSERT INTO email_reply_proposals (
          id, outreach_send_id, contact_id, inbound_email_thread_id, to_address,
          subject, body_text, request_hash, acceptance_hash, proposed_by,
          slack_channel_id, slack_thread_ts, proposal_run_id, expires_at
        ) VALUES (
          ${proposalId}, ${target.sendId}, ${target.contactId}, ${target.inboundEmailThreadId},
          ${target.toAddress}, ${target.subject}, ${bodyText}, ${requestHash},
          ${acceptanceHash}, ${run.actor_user_id}, ${target.slackChannelId},
          ${target.slackThreadTs}, ${run.id}, ${expiresAt}
        )`);
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'human.slack_email_proposal', sourceRef: proposalId,
          expiresAt, payload: { proposalId, sendId: target.sendId, requestHash, to: target.toAddress },
        });
        return {
          proposalId, acceptanceHash, expiresAt, requestHash, bodyText, evidenceId: evidence.id,
          confirmationCommand: `!email confirm ${proposalId} ${acceptanceHash}`,
        };
      },
    },
  ],
  output({ state }) {
    return {
      status: 'awaiting_explicit_confirmation',
      proposalId: state.persist_proposal.proposalId,
      outreachSendId: state.resolve_thread.sendId,
      recipient: state.resolve_thread.contactName || state.resolve_thread.toAddress,
      toAddress: state.resolve_thread.toAddress,
      requestHash: state.persist_proposal.requestHash,
      bodyText: state.persist_proposal.bodyText,
      expiresAt: state.persist_proposal.expiresAt,
      confirmationCommand: state.persist_proposal.confirmationCommand,
      evidenceId: state.persist_proposal.evidenceId,
    };
  },
};

const confirmDefinition = {
  name: 'email.reply.confirm',
  version: 1,
  capability: 'email.send',
  mutates: true,
  serializeMutations: true,
  crashRecovery: 'manual',
  allowedTriggers: ['slack_email_confirm_command'],
  validate: validateConfirmation,
  steps: [
    {
      key: 'accept_proposal', effectClass: 'local_write', maxAttempts: 2,
      async run({ db, run, input }) {
        const [proposal] = await db.query(sql`SELECT erp.*, et.provider_thread_id,
          et.rfc_message_id AS in_reply_to, et.references_header
          FROM email_reply_proposals erp
          JOIN email_threads et ON et.id=erp.inbound_email_thread_id
          WHERE erp.id=${input.proposalId}`);
        if (!proposal) throw new Error('email reply proposal was not found');
        if (proposal.status === 'confirmed' && proposal.confirmation_run_id === run.id) return proposal;
        if (proposal.status !== 'pending') throw new Error(`email reply proposal is ${proposal.status}, not pending`);
        if (new Date(proposal.expires_at).getTime() <= Date.now()) {
          await db.query(sql`UPDATE email_reply_proposals SET status='expired', updated_at=datetime('now') WHERE id=${proposal.id}`);
          throw new Error('email reply proposal expired; create a new proposal');
        }
        if (proposal.proposed_by !== run.actor_user_id) {
          const error = new Error('the same authorized Slack user who proposed the email must confirm it');
          error.code = 'email_confirmer_mismatch';
          throw error;
        }
        if (proposal.slack_channel_id !== run.channel_id) throw new Error('email confirmation came from the wrong Slack channel');
        if (proposal.slack_thread_ts !== String(input.threadTs || '')) throw new Error('email confirmation came from the wrong Slack thread');
        if (proposal.acceptance_hash !== String(input.acceptanceHash).toLowerCase()) throw new Error('email acceptance hash does not match');
        await db.query(sql`UPDATE email_reply_proposals SET status='confirmed', confirmed_by=${run.actor_user_id},
          confirmation_run_id=${run.id}, confirmed_at=datetime('now'), updated_at=datetime('now')
          WHERE id=${proposal.id} AND status='pending'`);
        const [confirmed] = await db.query(sql`SELECT * FROM email_reply_proposals WHERE id=${proposal.id}`);
        if (confirmed.status !== 'confirmed' || confirmed.confirmation_run_id !== run.id) {
          throw new Error('email reply proposal was confirmed concurrently by another workflow');
        }
        return proposal;
      },
    },
    {
      key: 'register_effect', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        const proposal = state.accept_proposal;
        const effect = await store.createEffect(db, {
          runId: run.id, stepKey, effectType: 'message_delivery', provider: 'gmail',
          operation: 'gmail.message.send', idempotencyKey: `${proposal.id}:gmail:send`,
          request: { proposalId: proposal.id, requestHash: proposal.request_hash, bodyHash: store.sha256(proposal.body_text) },
          target: { sendId: proposal.outreach_send_id, contactId: proposal.contact_id, to: proposal.to_address },
        });
        await db.query(sql`UPDATE email_reply_proposals SET workflow_effect_id=${effect.id}, updated_at=datetime('now') WHERE id=${proposal.id}`);
        return { effectId: effect.id };
      },
    },
    {
      key: 'send_via_gmail', effectClass: 'guest_message', maxAttempts: 1,
      async run({ db, state, services, store }) {
        const proposal = state.accept_proposal;
        const effectId = state.register_effect.effectId;
        const [existing] = await db.query(sql`SELECT * FROM workflow_effects WHERE id=${effectId}`);
        if (existing?.provider_ref && existing.status !== 'requested') {
          return { effectId, messageId: existing.provider_ref, threadId: proposal.provider_thread_id, replayed: true };
        }
        const sender = services.sendEmail || sendGmailReply;
        let result;
        try {
          result = await sender({
            to: proposal.to_address, subject: proposal.subject, body: proposal.body_text,
            threadId: proposal.provider_thread_id, inReplyTo: proposal.in_reply_to,
            references: proposal.references_header,
            messageId: `socialsol-${proposal.id}@lapuestadelsolresort.com`,
          });
        } catch (error) {
          if (error.code !== 'ambiguous_external_result') {
            await store.transitionEffect(db, { effectId, status: 'failed', providerStatus: 'request_failed',
              errorCode: error.code || 'gmail_send_failed', errorMessage: error.message });
          }
          await db.query(sql`UPDATE email_reply_proposals SET status=${error.code === 'ambiguous_external_result' ? 'ambiguous' : 'failed'},
            processing_error=${String(error.message).slice(0, 1000)}, updated_at=datetime('now') WHERE id=${proposal.id}`);
          throw error;
        }
        try {
          await store.transitionEffect(db, { effectId, providerRef: result.id,
            status: 'accepted_by_provider', providerStatus: 'accepted',
            response: { messageId: result.id, threadId: result.threadId } });
        } catch (cause) {
          const error = new Error(`Gmail accepted ${result.id}, but acceptance could not be committed: ${cause.message}`);
          error.code = 'ambiguous_external_result';
          error.retryable = false;
          throw error;
        }
        return { effectId, messageId: result.id, threadId: result.threadId, replayed: false };
      },
    },
    {
      key: 'verify_readback', effectClass: 'external_read', maxAttempts: 4,
      async run({ db, run, state, services, store, stepKey }) {
        const proposal = state.accept_proposal;
        const sent = state.send_via_gmail;
        const reader = services.readEmail || readSentMessage;
        let message;
        try {
          message = await reader(sent.messageId);
        } catch (cause) {
          const error = new Error(`Gmail Sent readback failed: ${cause.message}`);
          error.code = 'gmail_readback_unavailable';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        if (!message.labelIds?.includes('SENT')) {
          const error = new Error('Gmail readback did not show the message in Sent');
          error.code = 'gmail_sent_label_not_visible';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        if (normalizeEmail(message.to) !== normalizeEmail(proposal.to_address)) throw new Error('Gmail readback recipient mismatch');
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'gmail.api.readback', sourceRef: sent.messageId,
          payload: { messageId: sent.messageId, threadId: message.threadId,
            rfcMessageId: message.messageId, labelIds: message.labelIds,
            to: normalizeEmail(message.to), bodyHash: store.sha256(proposal.body_text) },
        });
        await store.transitionEffect(db, { effectId: sent.effectId, status: 'verified_by_readback',
          providerStatus: 'sent_label_verified', providerRef: sent.messageId,
          response: { evidenceId: evidence.id, threadId: message.threadId, rfcMessageId: message.messageId } });
        return { evidenceId: evidence.id, message };
      },
    },
    {
      key: 'persist_projection', effectClass: 'local_write', maxAttempts: 4,
      async run({ db, run, state, store, stepKey }) {
        const proposal = state.accept_proposal;
        const sent = state.send_via_gmail;
        const readback = state.verify_readback;
        const now = readback.message.internalDate || new Date().toISOString();
        let event;
        try {
          await db.tx(async tx => {
            const rows = await tx.query(sql`INSERT OR IGNORE INTO email_threads (
                contact_id, outreach_send_id, direction, subject, body_text,
                from_address, to_address, received_at, provider, provider_message_id,
                provider_thread_id, rfc_message_id, in_reply_to, references_header,
                raw_body_text, actor_user_id, processing_status, processed_at,
                slack_channel_id, slack_thread_ts, workflow_run_id, workflow_effect_id
              ) VALUES (
                ${proposal.contact_id}, ${proposal.outreach_send_id}, 'outbound', ${proposal.subject},
                ${proposal.body_text}, ${readback.message.from?.address || null}, ${proposal.to_address},
                ${now}, 'gmail', ${sent.messageId}, ${readback.message.threadId},
                ${readback.message.messageId}, ${readback.message.inReplyTo},
                ${readback.message.references}, ${proposal.body_text}, ${run.actor_user_id},
                'processed', ${now}, ${proposal.slack_channel_id}, ${proposal.slack_thread_ts},
                ${run.id}, ${sent.effectId}
              ) RETURNING *`);
            [event] = rows;
            if (!event) [event] = await tx.query(sql`SELECT * FROM email_threads WHERE provider='gmail' AND provider_message_id=${sent.messageId}`);
            await tx.query(sql`UPDATE email_reply_proposals SET status='completed',
              provider_message_id=${sent.messageId}, provider_thread_id=${readback.message.threadId},
              processing_error=NULL, completed_at=${now}, updated_at=${now} WHERE id=${proposal.id}`);
            await store.recordEvent(tx, { runId: run.id, stepKey, type: 'outbound_email_projection_persisted',
              payload: { emailThreadId: event.id, effectId: sent.effectId, providerRef: sent.messageId } });
          });
        } catch (error) {
          error.code = 'post_acceptance_persistence_failed';
          error.retryable = true;
          error.requiresManualReview = true;
          throw error;
        }
        return { emailThreadId: event.id };
      },
    },
    {
      key: 'notify_slack_thread', effectClass: 'internal_notification', maxAttempts: 1,
      async run({ db, run, state, store }) {
        const proposal = state.accept_proposal;
        const sent = state.send_via_gmail;
        const verified = state.verify_readback;
        const eventId = state.persist_projection.emailThreadId;
        const message = [
          `📤 *Email sent to ${proposal.to_address}*`,
          '', quotedBody(proposal.body_text), '',
          'Gmail acceptance and Sent-folder readback are verified.',
          `Email event: ${eventId} · Workflow: ${run.id} · Effect: ${sent.effectId} · Evidence: ${verified.evidenceId}`,
        ].join('\n');
        await store.enqueueOutbox(db, { runId: run.id, topic: 'slack.notification',
          idempotencyKey: `${proposal.id}:gmail-send:slack`,
          payload: { channelId: proposal.slack_channel_id, threadTs: proposal.slack_thread_ts,
            message, emailThreadId: eventId } });
        return { queued: true };
      },
    },
  ],
  output({ state }) {
    return {
      status: 'verified_by_readback', proposalId: state.accept_proposal.id,
      outreachSendId: state.accept_proposal.outreach_send_id,
      recipient: state.accept_proposal.to_address,
      messageId: state.send_via_gmail.messageId,
      emailThreadId: state.persist_projection.emailThreadId,
      effectId: state.send_via_gmail.effectId,
      evidenceId: state.verify_readback.evidenceId,
      slackQueued: state.notify_slack_thread.queued,
    };
  },
};

const classifyDefinition = {
  name: 'email.message.classify',
  version: 1,
  capability: 'email.send',
  mutates: false,
  allowedTriggers: ['slack_email_classify_command'],
  validate: validateClassification,
  steps: [{
    key: 'apply_classification', effectClass: 'local_write', maxAttempts: 1,
    async run({ db, run, input, store, stepKey }) {
      const [event] = await db.query(sql`SELECT * FROM email_threads WHERE id=${Number(input.eventId)} AND direction='inbound'`);
      if (!event) throw new Error('inbound email event was not found');
      if (event.slack_channel_id && event.slack_channel_id !== run.channel_id) throw new Error('classification came from the wrong Slack channel');
      if (event.slack_thread_ts && event.slack_thread_ts !== String(input.threadTs || '')) throw new Error('classification came from the wrong Slack thread');
      const result = await applyClassification(db, event, {
        quality: input.quality, reason: 'manual_classification', confidence: 1,
      }, { actorUserId: run.actor_user_id, manual: true });
      const evidence = await store.createEvidence(db, { runId: run.id, stepKey,
        source: 'human.slack_email_classification', sourceRef: String(event.id),
        payload: { emailThreadId: event.id, quality: input.quality, actorUserId: run.actor_user_id } });
      return { emailThreadId: event.id, quality: input.quality, evidenceId: evidence.id, ...result };
    },
  }],
  output({ state }) { return { status: 'classified', ...state.apply_classification }; },
};

module.exports = {
  PROPOSAL_TTL_MS,
  QUALITIES,
  applyClassification,
  classifyDefinition,
  confirmDefinition,
  observeDefinition,
  proposeDefinition,
  quotedBody,
  replySubject,
  validateClassification,
  validateConfirmation,
  validateReplyRequest,
};
