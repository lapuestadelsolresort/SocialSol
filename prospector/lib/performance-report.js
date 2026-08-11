'use strict';

const DEFAULT_REPORTING = Object.freeze({
  active_campaign_slug: 'planner_partner_program_v1',
  legacy_campaign_slugs: ['planner_outreach_v1'],
  window_days: 14,
  open_tracking_enabled: false,
  open_tracking_enabled_at: null,
  open_tracking_subdomain: null,
  click_tracking_enabled: false,
  test_contact_names: [],
  test_contact_name_prefixes: ['Smoke Test'],
});

function reportingConfig(config = {}) {
  const configured = config.reporting || {};
  return {
    ...DEFAULT_REPORTING,
    ...configured,
    legacy_campaign_slugs: configured.legacy_campaign_slugs
      || DEFAULT_REPORTING.legacy_campaign_slugs,
    test_contact_names: configured.test_contact_names
      || DEFAULT_REPORTING.test_contact_names,
    test_contact_name_prefixes: configured.test_contact_name_prefixes
      || DEFAULT_REPORTING.test_contact_name_prefixes,
  };
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDatabaseTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const hasZone = /(?:z|[+-]\d\d:\d\d)$/i.test(raw);
  const parsed = new Date(hasZone ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOnOrAfter(value, threshold) {
  const parsed = parseDatabaseTimestamp(value);
  return parsed ? parsed >= threshold : false;
}

function isTestContact(contact, config) {
  const name = normalized(contact?.name || contact?.contact_name);
  const exactNames = new Set(config.test_contact_names.map(normalized));
  if (exactNames.has(name)) return true;
  return config.test_contact_name_prefixes
    .map(normalized)
    .filter(Boolean)
    .some((prefix) => name.startsWith(prefix));
}

function percentage(numerator, denominator) {
  if (!denominator) return null;
  return Number(((Number(numerator) / Number(denominator)) * 100).toFixed(1));
}

function countBy(rows, field) {
  return rows.reduce((counts, row) => {
    const key = row[field] || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function engagementMetrics(sends, config) {
  const actual = sends.filter((send) => Boolean(send.sent_at));
  const tests = actual.filter((send) => isTestContact(send, config));
  const production = actual.filter((send) => !isTestContact(send, config));
  const delivered = actual.filter((send) => Boolean(send.delivered_at));
  const productionDelivered = production.filter((send) => Boolean(send.delivered_at));
  const bounced = actual.filter((send) => Boolean(send.bounced_at) || send.send_status === 'bounced');
  const complained = actual.filter((send) => Boolean(send.complained_at) || send.send_status === 'complained');
  const replies = actual.filter((send) => Boolean(send.reply_detected_at));
  const testReplies = replies.filter((send) => isTestContact(send, config));
  const externalReplies = replies.filter((send) => !isTestContact(send, config));
  const positiveReplies = externalReplies.filter((send) => send.reply_status === 'positive');
  const openTrackingStart = parseDatabaseTimestamp(config.open_tracking_enabled_at);
  const opensAvailable = config.open_tracking_enabled === true && Boolean(openTrackingStart);
  const openEligible = opensAvailable
    ? actual.filter((send) => isOnOrAfter(send.sent_at, openTrackingStart))
    : [];
  const openEligibleDelivered = openEligible.filter((send) => Boolean(send.delivered_at));
  const recordedOpens = openEligibleDelivered.filter((send) => Boolean(send.opened_at));

  return {
    actual_sent: actual.length,
    production_sent: production.length,
    test_sent: tests.length,
    delivered: delivered.length,
    production_delivered: productionDelivered.length,
    bounced: bounced.length,
    complained: complained.length,
    replies_recorded: replies.length,
    test_replies: testReplies.length,
    external_replies: externalReplies.length,
    positive_replies: positiveReplies.length,
    production_reply_rate_percent: percentage(externalReplies.length, productionDelivered.length),
    opens: opensAvailable ? recordedOpens.length : null,
    open_rate_percent: opensAvailable
      ? percentage(recordedOpens.length, openEligibleDelivered.length)
      : null,
    open_tracking_eligible_sent: opensAvailable ? openEligible.length : null,
    open_tracking_eligible_delivered: opensAvailable ? openEligibleDelivered.length : null,
    clicks: config.click_tracking_enabled
      ? actual.filter((send) => Boolean(send.clicked_at)).length
      : null,
    click_rate_percent: config.click_tracking_enabled
      ? percentage(actual.filter((send) => Boolean(send.clicked_at)).length, delivered.length)
      : null,
    external_reply_details: externalReplies.map((send) => ({
      name: send.contact_name,
      company: send.company,
      disposition: send.reply_status === 'positive'
        ? 'positive'
        : (send.do_not_contact ? 'suppressed' : (send.reply_status || 'unclassified')),
      replied_at: send.reply_detected_at,
    })),
  };
}

/**
 * Produce the one canonical data model for Paulina performance questions.
 * A send exists only when outreach_sends.sent_at is non-null. Draft records,
 * scheduled rows, rejected rows, and cancelled rows are never counted as sent.
 */
async function buildPerformanceReport(db, sql, config = {}, now = new Date()) {
  const reportConfig = reportingConfig(config);
  const openTrackingStart = parseDatabaseTimestamp(reportConfig.open_tracking_enabled_at);
  const opensAvailable = reportConfig.open_tracking_enabled === true && Boolean(openTrackingStart);
  const windowDays = Math.max(1, Number(reportConfig.window_days) || 14);
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const campaigns = await db.query(sql`
    SELECT id, slug, name, status, owning_agent
    FROM outreach_campaigns
    ORDER BY id
  `);
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const legacySlugs = new Set(reportConfig.legacy_campaign_slugs);
  const scopedCampaigns = campaigns.filter((campaign) => (
    campaign.owning_agent === 'paulina'
    || legacySlugs.has(campaign.slug)
    || campaign.slug === reportConfig.active_campaign_slug
  ));
  const scopedCampaignIds = new Set(scopedCampaigns.map((campaign) => campaign.id));

  const sends = await db.query(sql`
    SELECT
      os.id,
      os.contact_id,
      os.campaign_id,
      os.created_at,
      os.status AS send_status,
      os.sent_at,
      os.delivered_at,
      os.opened_at,
      os.clicked_at,
      os.bounced_at,
      os.complained_at,
      os.reply_detected_at,
      os.cancelled_at,
      os.error,
      os.rejected_reason,
      c.name AS contact_name,
      c.company,
      c.status AS contact_status,
      c.reply_status,
      c.do_not_contact,
      c.do_not_contact_reason
    FROM outreach_sends os
    JOIN contacts c ON c.id = os.contact_id
    ORDER BY os.id
  `);

  const contacts = await db.query(sql`
    SELECT id, name, status, email_status, do_not_contact, source,
           airbnb_account_id
    FROM contacts
  `);
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const attachments = await db.query(sql`
    SELECT campaign_id, contact_id
    FROM campaign_contacts
  `);

  const scopedSends = sends.filter((send) => scopedCampaignIds.has(send.campaign_id));
  const recentScopedSends = scopedSends.filter((send) => isOnOrAfter(send.sent_at, windowStart));
  const recentScopedRows = scopedSends.filter((send) => isOnOrAfter(send.created_at, windowStart));
  const activeCampaign = campaigns.find((campaign) => campaign.slug === reportConfig.active_campaign_slug);

  let activeQueue = null;
  if (activeCampaign) {
    const activeAttachments = attachments.filter((row) => row.campaign_id === activeCampaign.id);
    const activeSendContactIds = new Set(sends
      .filter((send) => send.campaign_id === activeCampaign.id && send.send_status !== 'cancelled')
      .map((send) => send.contact_id));
    const remaining = activeAttachments.filter((row) => !activeSendContactIds.has(row.contact_id));
    const remainingContacts = remaining
      .map((row) => contactById.get(row.contact_id))
      .filter(Boolean);
    activeQueue = {
      campaign_slug: activeCampaign.slug,
      campaign_status: activeCampaign.status,
      attached_contacts: activeAttachments.length,
      remaining_contacts: remainingContacts.length,
      verified_ready: remainingContacts.filter((contact) => (
        contact.email_status === 'verified' && !contact.do_not_contact
      )).length,
      verification_buffer_target: Number(config.email_verification?.queue_target_verified || 0),
      remaining_by_email_status: countBy(remainingContacts, 'email_status'),
      remaining_by_contact_status: countBy(remainingContacts, 'status'),
    };
    activeQueue.verification_buffer_status = activeQueue.verification_buffer_target > 0
      && activeQueue.verified_ready >= activeQueue.verification_buffer_target
      ? 'target_met'
      : 'below_target';
  }

  const globalNew = contacts.filter((contact) => contact.status === 'new');
  const globalAirbnbNew = globalNew.filter((contact) => (
    contact.airbnb_account_id != null || normalized(contact.source).startsWith('airbnb')
  ));
  const actualSends = sends.filter((send) => Boolean(send.sent_at));
  const otherActualSends = actualSends.filter((send) => !scopedCampaignIds.has(send.campaign_id));
  const otherByCampaign = otherActualSends.reduce((counts, send) => {
    const campaign = campaignById.get(send.campaign_id);
    const key = campaign?.slug || 'no_campaign';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const recentCancellationReasons = recentScopedRows
    .filter((send) => send.send_status === 'cancelled' || Boolean(send.cancelled_at))
    .reduce((counts, send) => {
      const reason = send.error || send.rejected_reason || 'reason_not_recorded';
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});

  return {
    generated_at: now.toISOString(),
    scope: {
      owner: 'paulina',
      campaign_slugs: scopedCampaigns.map((campaign) => campaign.slug),
      active_campaign_slug: reportConfig.active_campaign_slug,
    },
    all_time: engagementMetrics(scopedSends, reportConfig),
    recent: {
      window_days: windowDays,
      starts_at: windowStart.toISOString(),
      ...engagementMetrics(recentScopedSends, reportConfig),
      records_created: recentScopedRows.length,
      records_cancelled: recentScopedRows.filter((send) => (
        send.send_status === 'cancelled' || Boolean(send.cancelled_at)
      )).length,
      cancellation_reasons: recentCancellationReasons,
    },
    active_queue: activeQueue,
    crm_context: {
      all_outreach_records: sends.length,
      all_actual_sends: actualSends.length,
      other_campaign_actual_sends: otherActualSends.length,
      other_actual_sends_by_campaign: otherByCampaign,
      global_new_contacts: globalNew.length,
      global_new_airbnb_contacts: globalAirbnbNew.length,
    },
    tracking: {
      opens_available: opensAvailable,
      opens_enabled_at: openTrackingStart ? openTrackingStart.toISOString() : null,
      opens_subdomain: reportConfig.open_tracking_subdomain || null,
      clicks_available: Boolean(reportConfig.click_tracking_enabled),
      opens_note: opensAvailable
        ? `Open tracking applies only to messages sent on or after ${openTrackingStart.toISOString()}; historical opens cannot be backfilled. Opens are an approximate diagnostic because privacy features, image blocking, and automated scanners can undercount or overcount them.`
        : (reportConfig.open_tracking_enabled
          ? 'Unavailable: open tracking is enabled but open_tracking_enabled_at is missing or invalid, so there is no trustworthy denominator.'
          : 'Unavailable: Resend open tracking is not configured. Zero recorded opens must not be interpreted as a 0% open rate or as evidence of spam placement.'),
      delivery_note: 'Delivered means the receiving mail server accepted the message. It does not prove inbox placement, sender reputation, warmup health, or absence from spam folders.',
      sample_note: 'Report the observed reply fraction without calling it healthy, strong, weak, or poor unless an approved benchmark and adequate sample size are supplied.',
    },
    definitions: {
      sent: 'outreach_sends.sent_at IS NOT NULL',
      production: 'Actual sends excluding configured internal/smoke-test contacts',
      reply_rate: 'External recipient replies divided by production messages with a delivered_at timestamp',
      remaining: 'Campaign contacts with no non-cancelled outreach record for the active campaign',
      contact_status: 'A lifecycle label; new does not mean unverified and does not mean outside the campaign queue',
    },
  };
}

function openMetricLine(metrics, tracking) {
  if (!tracking.opens_available) {
    return `Opens: unavailable. ${tracking.opens_note}`;
  }
  const rate = metrics.open_rate_percent == null
    ? 'rate unavailable until at least one tracking-eligible message is delivered'
    : `${metrics.open_rate_percent}% of tracking-eligible delivered messages`;
  return `Opens: ${metrics.opens} across ${metrics.open_tracking_eligible_delivered} delivered messages sent since ${tracking.opens_enabled_at} (${rate}). ${tracking.opens_note}`;
}

function formatPerformanceReport(report) {
  const all = report.all_time;
  const recent = report.recent;
  const queue = report.active_queue;
  const replyRate = all.production_reply_rate_percent == null
    ? 'unavailable'
    : `${all.production_reply_rate_percent}%`;
  const lines = [
    `Prospector Paulina performance — ${report.generated_at}`,
    `Scope: ${report.scope.campaign_slugs.join(', ') || 'no Paulina campaigns found'}`,
    '',
    'All time',
    `• ${all.actual_sent} actual sends (${all.production_sent} production recipients, ${all.test_sent} internal/test).`,
    `• ${all.delivered} delivered, ${all.bounced} bounced, ${all.complained} complaints.`,
    `• ${all.replies_recorded} reply records: ${all.external_replies} external recipient replies and ${all.test_replies} test replies; ${all.positive_replies} external reply is positive.`,
    `• Production reply rate: ${replyRate} (${all.external_replies}/${all.production_delivered} delivered production messages).`,
    `• ${openMetricLine(all, report.tracking)}`,
    '',
    `Last ${recent.window_days} days`,
    `• ${recent.actual_sent} actual sends (${recent.production_sent} production, ${recent.test_sent} test); ${recent.delivered} delivered, ${recent.bounced} bounced, ${recent.external_replies} external replies.`,
    `• ${openMetricLine(recent, report.tracking)}`,
    `• ${recent.records_created} outreach records were created; ${recent.records_cancelled} were cancelled. Created or cancelled records are not sends unless sent_at is populated.`,
    `• Recorded cancellation reasons: ${JSON.stringify(recent.cancellation_reasons)}.`,
  ];

  if (queue) {
    lines.push(
      '',
      `Active campaign — ${queue.campaign_slug} (${queue.campaign_status})`,
      `• ${queue.attached_contacts} attached contacts; ${queue.remaining_contacts} remaining; ${queue.verified_ready} verified and ready.`,
      `• Verification buffer: ${queue.verification_buffer_status}; target ${queue.verification_buffer_target}. Remaining email statuses: ${JSON.stringify(queue.remaining_by_email_status)}.`,
      '• Contact lifecycle status is separate from email verification: a contact marked new is already attached to the campaign and may be verified.',
    );
  }

  lines.push(
    '',
    'CRM context (do not mix this into Paulina totals)',
    `• The database contains ${report.crm_context.all_outreach_records} outreach records but only ${report.crm_context.all_actual_sends} actual sends across every campaign.`,
    `• ${report.crm_context.other_campaign_actual_sends} actual sends belong to other/non-Paulina campaigns: ${JSON.stringify(report.crm_context.other_actual_sends_by_campaign)}.`,
    `• ${report.crm_context.global_new_contacts} contacts are globally marked new; ${report.crm_context.global_new_airbnb_contacts} of them are Airbnb-origin records, not Paulina's planner queue.`,
    '',
    `Interpretation guardrail: ${report.tracking.delivery_note}`,
    `Interpretation guardrail: ${report.tracking.sample_note}`,
  );

  return lines.join('\n');
}

module.exports = {
  buildPerformanceReport,
  formatPerformanceReport,
  isTestContact,
  parseDatabaseTimestamp,
  reportingConfig,
};
