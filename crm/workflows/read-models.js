'use strict';

const { sql } = require('@databases/sqlite');
const { nodeCommand } = require('../lib/workflow-command');
const { readBankAccounts, readReport, REPORTS } = require('../lib/quickbooks-api');
const {
  isBlock,
  reservationDisplayName,
  selectPrimaryCalendarEntries,
} = require('../scripts/lib/ownerrez-occupancy');

async function tableExists(db, name) {
  const [row] = await db.query(sql`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=${name}`);
  return Boolean(row);
}

async function queryIfTable(db, name, query, fallback) {
  if (!(await tableExists(db, name))) return fallback;
  return db.query(query);
}

function evidenceReadDefinition({ name, capability, validate = () => {}, collect }) {
  return {
    name,
    version: 1,
    capability,
    mutates: false,
    validate,
    steps: [{
      key: 'read_authority', maxAttempts: 2,
      async run({ db, run, input, services, store, stepKey }) {
        const result = await collect({ db, run, input, services });
        const evidence = await store.createEvidence(db, {
          runId: run.id,
          stepKey,
          source: result.source,
          sourceRef: result.sourceRef || null,
          observedAt: result.observedAt || new Date().toISOString(),
          expiresAt: result.expiresAt || null,
          confidence: result.confidence ?? 1,
          payload: result.payload,
        });
        return { ...result.payload, _evidence: { id: evidence.id, source: result.source, observedAt: evidence.observedAt, payloadHash: evidence.payloadHash } };
      },
    }],
    output({ state }) { return state.read_authority; },
  };
}

const businessSnapshot = evidenceReadDefinition({
  name: 'business.snapshot.read',
  capability: 'business.read',
  async collect({ db }) {
    const generatedAt = new Date().toISOString();
    const [leadRows, outreachRows, whatsappRows, receiptRows, workflowRows, outboxRows, socialRows, squarespaceRuns] = await Promise.all([
      queryIfTable(db, 'leads', sql`SELECT status, COUNT(*) AS count FROM leads GROUP BY status`, []),
      queryIfTable(db, 'outreach_sends', sql`SELECT
        COUNT(*) AS records,
        SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN reply_detected_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
        FROM outreach_sends`, []),
      queryIfTable(db, 'meta_messages', sql`SELECT direction, COALESCE(delivery_status,'unknown') AS delivery_status,
        COUNT(*) AS count FROM meta_messages WHERE platform='whatsapp'
        GROUP BY direction, COALESCE(delivery_status,'unknown')`, []),
      queryIfTable(db, 'accounting_receipts', sql`SELECT status, COUNT(*) AS count
        FROM accounting_receipts GROUP BY status`, []),
      queryIfTable(db, 'workflow_runs', sql`SELECT status, COUNT(*) AS count
        FROM workflow_runs GROUP BY status`, []),
      queryIfTable(db, 'workflow_outbox', sql`SELECT status, COUNT(*) AS count
        FROM workflow_outbox GROUP BY status`, []),
      queryIfTable(db, 'social_content', sql`SELECT status, COUNT(*) AS count
        FROM social_content GROUP BY status`, []),
      queryIfTable(db, 'squarespace_sync_runs', sql`SELECT id, status, started_at, finished_at,
        orders_seen, transactions_seen, contacts_seen, contacts_linked, bookings_linked, error
        FROM squarespace_sync_runs ORDER BY id DESC LIMIT 1`, []),
    ]);

    return {
      source: 'crm.business_read_model',
      observedAt: generatedAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        generatedAt,
        authorityContract: {
          occupancyAvailability: { authority: 'OwnerRez', queried: false, reason: 'requires a date-bounded live OwnerRez occupancy query' },
          directChargesFees: { authority: 'Squarespace', queried: true, freshness: squarespaceRuns[0]?.finished_at || null },
          bankCash: { authority: 'Kapital/QBO', queried: false, reason: 'snapshot never infers live bank cash from CRM data' },
          leadsOutreach: { authority: 'CRM', queried: true, freshness: generatedAt },
          whatsappDelivery: { authority: 'Twilio callbacks', queried: true, freshness: generatedAt },
        },
        leadsByStatus: leadRows,
        outreach: outreachRows[0] || { records: 0, sent: 0, delivered: 0, bounced: 0, replied: 0 },
        whatsappByState: whatsappRows,
        receiptsByStatus: receiptRows,
        socialContentByStatus: socialRows,
        workflowsByStatus: workflowRows,
        outboxByStatus: outboxRows,
        squarespaceLastSync: squarespaceRuns[0] || null,
      },
    };
  },
});

function validateLimit(input) {
  if (input.limit !== undefined) {
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
  }
}

const whatsappStatusRead = evidenceReadDefinition({
  name: 'whatsapp.status.read',
  capability: 'whatsapp.read',
  validate: validateLimit,
  async collect({ db, input }) {
    const limit = Number(input.limit || 25);
    const messageSid = input.messageSid ? String(input.messageSid).slice(0, 100) : null;
    const rows = await queryIfTable(db, 'meta_messages', sql`SELECT
      message_id, sender_name, received_at, slack_thread_ts, direction,
      COALESCE(delivery_status,'unknown') AS delivery_status,
      provider_status_updated_at, delivered_at, read_at, failed_at,
      workflow_run_id, workflow_effect_id
      FROM meta_messages WHERE platform='whatsapp'
        AND (${messageSid} IS NULL OR message_id=${messageSid})
      ORDER BY received_at DESC LIMIT ${limit}`, []);
    return {
      source: 'twilio.callback_ledger',
      sourceRef: messageSid,
      payload: { messages: rows, statusVocabulary: ['requested','accepted_by_provider','queued','sent','delivered','read','verified_by_readback','failed'] },
    };
  },
});

async function collectReceipts({ db, input, run }, forceScoped = false) {
  const limit = Number(input.limit || 50);
  const channelFilter = forceScoped ? run.channel_id : null;
  const rows = await queryIfTable(db, 'accounting_receipts', sql`SELECT
    id, slack_channel_id, slack_message_id, submitted_by, submitted_at,
    status, vendor, transaction_date, currency, amount, transaction_kind, description,
    category_key, category_name, extraction_confidence, review_reason,
    amount_usd, fx_rate, qbo_entity_type, qbo_entity_id, posted_at
    FROM accounting_receipts
    WHERE (${channelFilter} IS NULL OR slack_channel_id=${channelFilter})
    ORDER BY submitted_at DESC LIMIT ${limit}`, []);
  for (const receipt of rows) {
    receipt.items = await queryIfTable(db, 'accounting_receipt_items', sql`SELECT
      item_index, file_ref_id, vendor, transaction_date, currency, amount,
      description, category_key, category_name, extraction_confidence
      FROM accounting_receipt_items WHERE receipt_id=${receipt.id} ORDER BY item_index`, []);
  }
  return { source: 'sqlite.accounting_receipts', sourceRef: channelFilter, payload: { receipts: rows, scopedToChannel: channelFilter } };
}

const receiptsRead = evidenceReadDefinition({
  name: 'receipts.status.read',
  capability: 'receipts.read',
  validate: validateLimit,
  collect: context => collectReceipts(context, false),
});

const receiptsScopedRead = evidenceReadDefinition({
  name: 'receipts.scoped.read',
  capability: 'accounting.read_scoped',
  validate: validateLimit,
  collect: context => collectReceipts(context, true),
});

const socialContentRead = evidenceReadDefinition({
  name: 'social.content.read',
  capability: 'social.read',
  validate: validateLimit,
  async collect({ db, input }) {
    const limit = Number(input.limit || 50);
    const rows = await queryIfTable(db, 'social_content', sql`SELECT id, version, status,
      platform, content_type, caption, media_refs_json, scheduled_for, postiz_post_id,
      created_by, updated_by, created_at, updated_at
      FROM social_content ORDER BY updated_at DESC LIMIT ${limit}`, []);
    return { source: 'sqlite.social_content', payload: { content: rows } };
  },
});

function validateDateRange(input) {
  for (const key of ['start', 'end']) {
    if (input[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(input[key]))) {
      throw new Error(`${key} must be YYYY-MM-DD`);
    }
  }
  if (input.start && input.end && input.end < input.start) throw new Error('end must be on or after start');
  if (input.start && input.end) {
    const days = (new Date(`${input.end}T00:00:00Z`) - new Date(`${input.start}T00:00:00Z`)) / 86400000;
    if (days > 370) throw new Error('date window may not exceed 370 days');
  }
}

const ownerrezOccupancyRead = evidenceReadDefinition({
  name: 'ownerrez.occupancy.read',
  capability: 'ownerrez.read',
  validate: validateDateRange,
  async collect({ input, services }) {
    if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
    const start = input.start || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const end = input.end || (() => {
      const parsed = new Date(`${start}T12:00:00Z`);
      parsed.setUTCDate(parsed.getUTCDate() + 28);
      return parsed.toISOString().slice(0, 10);
    })();
    const args = ['--start', start, '--end', end, '--enriched-json'];
    const result = await services.runCommand(nodeCommand('crm/scripts/ownerrez-full-occupancy.js', args));
    let records;
    try { records = JSON.parse(result.stdout); } catch { records = null; }
    if (!Array.isArray(records)) throw new Error('OwnerRez occupancy query returned no machine-readable records');
    const primaryCalendarEntries = selectPrimaryCalendarEntries(records, { asOf: start })
      .map(record => ({
        ...record,
        calendar_entry_kind: isBlock(record) ? 'manual_calendar_entry' : 'typed_booking',
        display_name: reservationDisplayName(record),
      }));
    const nextCalendarEntry = primaryCalendarEntries[0] || null;
    return {
      source: 'ownerrez.live_occupancy_api',
      sourceRef: `${start}:${end}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        authority: 'OwnerRez',
        window: { start, end },
        activeOccupancyRecords: records.length,
        primaryCalendarEntryCount: primaryCalendarEntries.length,
        primaryCalendarEntries,
        nextCalendarEntry,
        calendarSemantics: {
          primaryEntryRule: 'Earliest active record on or after window.start whose type is not linked_availability.',
          manualBlockRule: 'OwnerRez type=block is a manual calendar encoding and does not prove owner use; titled blocks may be guest stays or events.',
          linkedAvailabilityRule: 'linked_availability records are derived occupancy copies and are not separate arrivals.',
        },
        records,
      },
    };
  },
});

const qboBankBalancesRead = evidenceReadDefinition({
  name: 'qbo.bank_balances.read',
  capability: 'qbo.read',
  async collect() {
    const result = await readBankAccounts();
    return {
      source: 'quickbooks.live_accounts_api',
      sourceRef: result.realmId,
      observedAt: result.observedAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      payload: {
        authority: 'QuickBooks ledger (Kapital bank balance only as fresh as QBO bank sync)',
        accounts: result.accounts,
      },
    };
  },
});

const qboReportRead = evidenceReadDefinition({
  name: 'qbo.report.read',
  capability: 'qbo.read',
  validate(input) {
    validateDateRange(input);
    if (!REPORTS.has(String(input.report || ''))) throw new Error('report must be BalanceSheet, ProfitAndLoss, or CashFlow');
    if (input.accountingMethod && !['Cash', 'Accrual'].includes(input.accountingMethod)) {
      throw new Error('accountingMethod must be Cash or Accrual');
    }
  },
  async collect({ input }) {
    const result = await readReport({
      report: input.report,
      startDate: input.start || null,
      endDate: input.end || null,
      accountingMethod: input.accountingMethod || 'Accrual',
    });
    return {
      source: `quickbooks.live_report.${input.report}`,
      sourceRef: result.realmId,
      observedAt: result.observedAt,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      payload: { authority: 'QuickBooks', report: result.report },
    };
  },
});

const squarespaceSummaryRead = evidenceReadDefinition({
  name: 'squarespace.summary.read',
  capability: 'squarespace.read',
  async collect({ db, input }) {
    validateDateRange(input);
    const start = input.start ? `${input.start}T00:00:00.000Z` : null;
    const end = input.end ? `${input.end}T23:59:59.999Z` : null;
    const orders = await queryIfTable(db, 'squarespace_orders', sql`SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(CAST(grand_total_value AS REAL)),0) AS gross_order_value,
      COALESCE(SUM(CASE WHEN payment_state='PAID' THEN 1 ELSE 0 END),0) AS paid_orders,
      COALESCE(SUM(CASE WHEN payment_state='PARTIALLY_PAID' THEN 1 ELSE 0 END),0) AS partially_paid_orders,
      MIN(currency) AS currency
      FROM squarespace_orders
      WHERE (${start} IS NULL OR created_on>=${start}) AND (${end} IS NULL OR created_on<=${end})`, []);
    const payments = await queryIfTable(db, 'squarespace_payments', sql`SELECT
      COALESCE(SUM(CAST(amount_value AS REAL)),0) AS collected,
      COALESCE(SUM(CAST(net_amount_value AS REAL)),0) AS payment_net
      FROM squarespace_payments
      WHERE (${start} IS NULL OR paid_on>=${start}) AND (${end} IS NULL OR paid_on<=${end})`, []);
    const lastRuns = await queryIfTable(db, 'squarespace_sync_runs', sql`SELECT id, status, started_at,
      finished_at, orders_seen, transactions_seen, error FROM squarespace_sync_runs ORDER BY id DESC LIMIT 1`, []);
    return {
      source: 'squarespace.synced_commerce_ledger',
      sourceRef: lastRuns[0]?.id ? String(lastRuns[0].id) : null,
      observedAt: lastRuns[0]?.finished_at || new Date().toISOString(),
      payload: {
        authority: 'Squarespace Commerce', window: { start: input.start || null, end: input.end || null },
        orders: orders[0] || {}, payments: payments[0] || {}, lastSync: lastRuns[0] || null,
      },
    };
  },
});

const crmPipelineRead = evidenceReadDefinition({
  name: 'crm.pipeline.read',
  capability: 'crm.read',
  async collect({ db }) {
    const leads = await queryIfTable(db, 'leads', sql`SELECT status, source, COUNT(*) AS count,
      COALESCE(SUM(estimated_value),0) AS estimated_value
      FROM leads GROUP BY status, source ORDER BY status, source`, []);
    const campaigns = await queryIfTable(db, 'campaigns', sql`SELECT name, channel, status,
      budget_total, spend_actual, start_date, end_date FROM campaigns ORDER BY created_at DESC LIMIT 100`, []);
    const recentAttribution = await queryIfTable(db, 'attribution_events', sql`SELECT event_type, channel,
      COUNT(*) AS count FROM attribution_events WHERE created_at>=datetime('now','-30 days')
      GROUP BY event_type, channel`, []);
    return {
      source: 'crm.pipeline_read_model',
      payload: { leads, campaigns, recentAttribution, generatedAt: new Date().toISOString() },
    };
  },
});

const paulinaPerformanceRead = evidenceReadDefinition({
  name: 'paulina.performance.read',
  capability: 'paulina.read',
  async collect({ services }) {
    if (typeof services.runCommand !== 'function') throw new Error('workflow command service is unavailable');
    const result = await services.runCommand(nodeCommand('prospector/scripts/performance-status.js', ['--json']));
    let report;
    try { report = JSON.parse(result.stdout); } catch { report = null; }
    if (!report?.generated_at) throw new Error('Paulina performance report was not machine-readable');
    return {
      source: 'crm.paulina_performance_report',
      sourceRef: report.scope?.active_campaign_slug || null,
      observedAt: report.generated_at,
      payload: report,
    };
  },
});

module.exports = {
  businessSnapshot,
  evidenceReadDefinition,
  ownerrezOccupancyRead,
  qboBankBalancesRead,
  qboReportRead,
  crmPipelineRead,
  paulinaPerformanceRead,
  receiptsRead,
  receiptsScopedRead,
  socialContentRead,
  squarespaceSummaryRead,
  whatsappStatusRead,
};
