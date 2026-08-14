'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sql } = require('@databases/sqlite');
const { ROOT, DB_PATH } = require('../../lib/runtime-paths');
const { nodeCommand, pythonCommand, resolveRepoFile } = require('../lib/workflow-command');
const { makeDurableJob } = require('./durable-job');
const { listPosts } = require('../lib/postiz');

function safeAccountingCsv(input) {
  const supplied = typeof input.csvPath === 'string' ? input.csvPath.trim() : '';
  if (!supplied) throw new Error('csvPath is required');
  const absolute = path.resolve(ROOT, supplied);
  const relative = path.relative(path.join(ROOT, 'accounting'), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(absolute).toLowerCase() !== '.csv') {
    throw new Error('Kapital CSV must be a .csv file inside the accounting runtime directory');
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error('Kapital CSV does not exist');
  return absolute;
}

function parseRequiredJson(command, label) {
  if (!command?.parsed || typeof command.parsed !== 'object') {
    return { verified: false, reason: `${label} did not emit a machine-readable result` };
  }
  return null;
}

const paulinaDaily = makeDurableJob({
  name: 'paulina.daily',
  version: 3,
  capability: 'paulina.send',
  provider: 'resend',
  operation: 'paulina.orchestrate',
  autonomous: true,
  notifyOnWrite: false,
  requestSummary: () => ({ campaignScope: 'configured_active_campaign', autonomous: true }),
  buildCommand: ({ run, shadowMode }) => nodeCommand('prospector/orchestrator.js', shadowMode ? ['--dry-run'] : [], {
    timeoutMs: 15 * 60_000,
    env: { WORKFLOW_RUN_ID: run.id },
  }),
  async verify({ db, run, services, state }) {
    const reportCommand = await services.runCommand(nodeCommand('prospector/scripts/performance-status.js', ['--json']));
    let report;
    try { report = JSON.parse(reportCommand.stdout); } catch { report = null; }
    if (!report?.generated_at || report?.scope?.owner !== 'paulina') {
      return { verified: false, reason: 'Paulina CRM performance readback was unavailable', retryable: true };
    }
    const match = String(state.execute?.stdout || '').match(/exit ok:\s*(\{[^\n]+\})/);
    let runResult = null;
    try { runResult = match ? JSON.parse(match[1]) : null; } catch {}
    if (runResult?.paused === true && Number.isInteger(runResult.processed)) {
      runResult = { ...runResult, sent: 0, failed: 0 };
    }
    if (!runResult || !Number.isInteger(runResult.processed) || !Number.isInteger(runResult.sent)) {
      return { verified: false, reason: 'Paulina command did not emit a run-scoped result', retryable: false };
    }
    const [runRows] = await db.query(sql`SELECT COUNT(*) AS processed,
      SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN status IN ('failed','send_failed','cancelled') THEN 1 ELSE 0 END) AS failed
      FROM outreach_sends WHERE workflow_run_id=${run.id}`);
    if (Number(runRows?.sent || 0) !== runResult.sent) {
      return { verified: false, reason: 'Paulina command output did not match workflow-attributed CRM rows', retryable: false };
    }
    return {
      verified: true,
      source: 'crm.outreach_sends',
      sourceRef: report.scope.active_campaign_slug || 'paulina',
      providerStatus: 'crm_readback_verified',
      evidence: { run: runResult, attributedRows: runRows, performanceContext: report },
      summary: {
        processed: runResult.processed,
        sent: runResult.sent,
        failed: runResult.failed || 0,
        queueReady: report.active_queue?.verified_ready || 0,
        commandHash: state.execute?.providerRef,
      },
    };
  },
  summarize: ({ verification }) => ({ report: verification.summary }),
});

function validateReginaCampaign(input) {
  const slug = typeof input.campaignSlug === 'string' ? input.campaignSlug.trim() : '';
  if (!/^[a-z0-9_]{1,80}$/.test(slug)) throw new Error('valid campaignSlug is required');
  if (!fs.existsSync(path.join(ROOT, 'regina', 'library', 'campaigns', `${slug}.json`))) {
    throw new Error(`unknown Regina campaign: ${slug}`);
  }
  if (input.count !== undefined) {
    const count = Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be an integer from 1 to 100');
  }
}

function parseWorkflowState(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function addReginaDigestRun(digest, summary, campaignSlug) {
  digest.verifiedRuns += 1;
  digest.created += Number(summary.created || 0);
  digest.sent += Number(summary.sent || 0);
  digest.failed += Number(summary.failed || 0);
  const slug = campaignSlug || summary.campaignSlug || 'unknown';
  digest.campaigns[slug] = (digest.campaigns[slug] || 0) + 1;
}

async function reginaRunDigest(db, run, currentSummary, currentCampaignSlug) {
  const upperBound = run.started_at || new Date().toISOString();
  const [previousSummary] = await db.query(sql`SELECT id, started_at
    FROM workflow_runs
    WHERE workflow_name='regina.daily'
      AND id <> ${run.id}
      AND status='completed'
      AND started_at IS NOT NULL
      AND started_at < ${upperBound}
    ORDER BY started_at DESC LIMIT 1`);
  const fallback = new Date(new Date(upperBound).getTime() - 24 * 60 * 60_000).toISOString();
  const lowerBound = previousSummary?.started_at || fallback;
  const rows = await db.query(sql`SELECT id, workflow_name, status, input_json, state_json, completed_at
    FROM workflow_runs
    WHERE workflow_name IN ('regina.daily', 'regina.campaign')
      AND completed_at IS NOT NULL
      AND completed_at >= ${lowerBound}
      AND completed_at < ${upperBound}
    ORDER BY completed_at, id`);
  const digest = {
    from: lowerBound,
    to: upperBound,
    verifiedRuns: 0,
    workflowFailures: 0,
    created: 0,
    sent: 0,
    failed: 0,
    campaigns: {},
  };
  for (const row of rows) {
    if (row.id === previousSummary?.id) continue;
    if (row.status === 'failed') {
      digest.workflowFailures += 1;
      continue;
    }
    const summary = parseWorkflowState(row.state_json)?.verify_readback?.summary;
    if (row.status !== 'completed' || !summary) continue;
    const input = parseWorkflowState(row.input_json);
    const campaignSlug = summary.campaignSlug
      || input.campaignSlug
      || (row.workflow_name === 'regina.daily' ? 'anniversary' : null);
    addReginaDigestRun(digest, summary, campaignSlug);
  }
  addReginaDigestRun(digest, currentSummary, currentCampaignSlug);
  return digest;
}

function formatReginaDigest(digest) {
  const runs = `${digest.verifiedRuns} CRM-verified run${digest.verifiedRuns === 1 ? '' : 's'}`;
  const campaigns = Object.entries(digest.campaigns)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, count]) => `${slug} ${count}`)
    .join(', ');
  const workflowFailures = digest.workflowFailures > 0
    ? ` ${digest.workflowFailures} additional workflow${digest.workflowFailures === 1 ? '' : 's'} failed before CRM verification.`
    : '';
  return `Send digest: created ${digest.created}, sent ${digest.sent}, failed ${digest.failed} across ${runs}. Campaign runs: ${campaigns || 'none'}.${workflowFailures}`;
}

function reginaVerification(campaignSlug, { includeDigest = false } = {}) {
  return async ({ db, run, state }) => {
    const [row] = await db.query(sql`SELECT
      COUNT(*) AS created,
      SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status IN ('failed','send_failed') THEN 1 ELSE 0 END) AS failed
      FROM outreach_sends WHERE workflow_run_id=${run.id}`);
    if (state.execute.exitCode !== 0) return { verified: false, reason: 'Regina process did not exit cleanly' };
    const summary = {
      campaignSlug,
      created: Number(row?.created || 0),
      sent: Number(row?.sent || 0),
      failed: Number(row?.failed || 0),
    };
    const digest = includeDigest
      ? await reginaRunDigest(db, run, summary, campaignSlug)
      : null;
    return {
      verified: true,
      source: 'crm.outreach_sends',
      sourceRef: campaignSlug,
      providerStatus: 'crm_readback_verified',
      evidence: { campaignSlug, since: run.started_at, ...row, commandOutput: state.execute.stdout },
      summary,
      ...(digest ? { digest } : {}),
    };
  };
}

const reginaDaily = makeDurableJob({
  name: 'regina.daily',
  version: 3,
  capability: 'regina.send',
  provider: 'resend',
  operation: 'regina.anniversary',
  autonomous: true,
  notificationChannelName: 'reengager-regina',
  mentionUsers: false,
  requestSummary: () => ({ campaignSlug: 'anniversary', autonomous: true }),
  buildCommand: ({ run, shadowMode }) => nodeCommand('regina/scripts/anniversary-cron.js', shadowMode ? ['--dry-run'] : [], {
    timeoutMs: 15 * 60_000,
    env: { WORKFLOW_RUN_ID: run.id, REGINA_WORKFLOW_NO_SUMMARY: '1' },
  }),
  verify: reginaVerification('anniversary', { includeDigest: true }),
  buildNotificationMessage: ({ run, state }) => (
    `Regina daily summary. ${formatReginaDigest(state.verify_readback.digest)} Workflow ${run.id}.`
  ),
  summarize: ({ verification }) => ({ report: verification.summary, digest: verification.digest }),
});

const reginaCampaign = makeDurableJob({
  name: 'regina.campaign',
  version: 3,
  capability: 'regina.send',
  provider: 'resend',
  operation: 'regina.batch',
  validate: validateReginaCampaign,
  notifyOnWrite: false,
  requestSummary: input => ({ campaignSlug: input.campaignSlug, count: input.count || null }),
  buildCommand: ({ input, run, shadowMode }) => {
    const args = ['--campaign-slug', input.campaignSlug];
    if (input.count !== undefined) args.push('--n', String(input.count));
    if (shadowMode) args.push('--dry-run');
    return nodeCommand('regina/scripts/batch.js', args, {
      timeoutMs: 20 * 60_000,
      env: { WORKFLOW_RUN_ID: run.id, REGINA_WORKFLOW_NO_SUMMARY: '1' },
    });
  },
  verify: async context => reginaVerification(context.input.campaignSlug)(context),
  summarize: ({ verification }) => ({ report: verification.summary }),
});

const socialPublishRoutine = makeDurableJob({
  name: 'social.publish_routine',
  capability: 'social.publish',
  provider: 'postiz',
  operation: 'instagram.schedule_gtku',
  autonomous: true,
  notificationChannelName: 'social-sol',
  requestSummary: () => ({ series: 'get_to_know_us' }),
  buildCommand: ({ shadowMode }) => ({
    executable: '/bin/bash',
    args: [resolveRepoFile('crm/scripts/gtku-daily.sh')],
    env: shadowMode ? { DRY_RUN: '1' } : {},
    timeoutMs: 20 * 60_000,
  }),
  async verify({ db, input, run, state }) {
    const stdout = state.execute.stdout || '';
    if (/DRY_RUN=1/.test(stdout)) {
      return { verified: true, source: 'postiz.dry_run', providerStatus: 'dry_run_verified', evidence: { stdout } };
    }
    let seriesState = {};
    try { seriesState = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'gtku-state.json'), 'utf8')); } catch {}
    const scheduled = stdout.match(/Posted:\s*([^\s]+)/)?.[1] || null;
    const legitimateNoop = /All videos posted|Marked .* as skipped/.test(stdout);
    if (!legitimateNoop && (!scheduled || String(seriesState.last_postiz_id || '') !== scheduled)) {
      return { verified: false, reason: 'Postiz schedule was not confirmed in the series state', retryable: true };
    }
    let providerPost = null;
    if (scheduled) {
      const center = new Date(`${seriesState.last_posted_date}T17:00:00.000Z`).getTime();
      if (!Number.isFinite(center)) {
        return { verified: false, reason: 'GTKY schedule date was unavailable for Postiz readback', retryable: false };
      }
      const posts = await listPosts({
        startDate: new Date(center - 24 * 60 * 60_000).toISOString(),
        endDate: new Date(center + 48 * 60 * 60_000).toISOString(),
      });
      providerPost = posts.find(post => String(post.id) === String(scheduled)) || null;
      if (!providerPost) {
        return { verified: false, reason: 'scheduled post was not visible in Postiz readback', retryable: true };
      }
    }
    return {
      verified: true,
      source: scheduled ? 'postiz.posts.list' : 'postiz.schedule_state',
      sourceRef: scheduled,
      providerStatus: scheduled ? 'scheduled_readback_verified' : 'no_op_verified',
      evidence: {
        scheduledPostId: scheduled,
        statePostId: seriesState.last_postiz_id || null,
        providerPost: providerPost ? { id: providerPost.id, publishDate: providerPost.publishDate } : null,
        stdout,
      },
      summary: { scheduledPostId: scheduled, noOp: legitimateNoop },
    };
  },
  summarize: ({ verification }) => ({ report: verification.summary || { dryRun: true } }),
});

const crmSync = makeDurableJob({
  name: 'crm.sync',
  capability: 'crm.write',
  provider: 'ownerrez+squarespace',
  operation: 'crm.sync_authoritative_sources',
  autonomous: true,
  notificationChannelName: 'business-intel',
  requestSummary: () => ({ sources: ['ownerrez', 'squarespace'] }),
  buildCommand: () => nodeCommand('crm/scripts/sync-all.js', [], { timeoutMs: 30 * 60_000 }),
  async verify({ state }) {
    const invalid = parseRequiredJson(state.execute, 'CRM sync');
    if (invalid) return invalid;
    const result = state.execute.parsed;
    if (result.ok !== true || !result.sources?.ownerrez || result.sources?.squarespace?.ok !== true) {
      return { verified: false, reason: 'one or more authoritative CRM sources did not verify', retryable: true };
    }
    return {
      verified: true,
      source: 'crm.source_watermarks',
      providerStatus: 'all_sources_verified',
      evidence: result,
      summary: result.sources,
    };
  },
  summarize: ({ verification }) => ({ sources: verification.summary }),
});

const ownerrezCrmSync = makeDurableJob({
  name: 'ownerrez.crm.sync',
  capability: 'crm.write',
  provider: 'ownerrez',
  operation: 'crm.contact_sync',
  autonomous: true,
  notificationChannelName: 'business-intel',
  notifyOnWrite: false,
  requestSummary: () => ({ source: 'ownerrez', authority: 'guest_and_booking_contact_data' }),
  buildCommand: () => nodeCommand('crm/scripts/ownerrez-sync.js', [], {
    env: { WORKFLOW_MANAGED: '1' }, timeoutMs: 25 * 60_000,
  }),
  async verify({ state }) {
    const summary = state.execute.parsed;
    if (!summary || typeof summary.inquiries !== 'number' || typeof summary.bookings !== 'number') {
      return { verified: false, reason: 'OwnerRez contact sync did not emit a verifiable summary', retryable: true };
    }
    return {
      verified: true,
      source: 'ownerrez.api+crm.readback',
      providerStatus: 'contact_sync_verified',
      evidence: summary,
      summary,
    };
  },
  summarize: ({ verification }) => ({ ownerrez: verification.summary }),
});

const squarespaceCrmSync = makeDurableJob({
  name: 'squarespace.crm.sync',
  capability: 'crm.write',
  provider: 'squarespace',
  operation: 'commerce_sync',
  autonomous: true,
  notificationChannelName: 'business-intel',
  notifyOnWrite: false,
  requestSummary: () => ({ source: 'squarespace', authority: 'direct_charges_and_fees' }),
  buildCommand: () => nodeCommand('crm/scripts/squarespace-sync.js', ['--json'], { timeoutMs: 20 * 60_000 }),
  async verify({ state }) {
    const summary = state.execute.parsed;
    if (!summary || summary.ok !== true) {
      return { verified: false, reason: 'Squarespace commerce sync did not emit a verified result', retryable: true };
    }
    return {
      verified: true,
      source: 'squarespace.api+crm.readback',
      providerStatus: 'commerce_sync_verified',
      evidence: summary,
      summary,
    };
  },
  summarize: ({ verification }) => ({ squarespace: verification.summary }),
});

const accountingClassify = makeDurableJob({
  name: 'accounting.classify',
  capability: 'accounting.write',
  effectType: 'classification',
  provider: 'kapital',
  operation: 'classify_statement',
  autonomous: true,
  notifyOnWrite: false,
  validate: input => { safeAccountingCsv(input); },
  requestSummary: input => ({ csv: path.basename(safeAccountingCsv(input)) }),
  buildCommand: ({ input }) => pythonCommand('accounting/run_classify.py', [safeAccountingCsv(input), '--json'], {
    timeoutMs: 20 * 60_000,
  }),
  async verify({ db, input, run, state }) {
    const invalid = parseRequiredJson(state.execute, 'Kapital classifier');
    if (invalid) return invalid;
    const summary = state.execute.parsed.summary;
    if (!summary || summary.total !== summary.auto + summary.guess + summary.unknown) {
      return { verified: false, reason: 'Kapital classification totals failed reconciliation' };
    }
    const sourceFileHash = crypto.createHash('sha256').update(fs.readFileSync(safeAccountingCsv(input))).digest('hex');
    let persisted = 0;
    for (const tier of ['auto', 'guess', 'unknown']) {
      for (const txn of state.execute.parsed.results?.[tier] || []) {
        const sourceKey = require('../lib/workflow-store').sha256({
          provider: 'kapital', date: txn.date, reference: txn.reference || txn.clave,
          description: txn.description, amount: txn.amount, direction: txn.direction,
        });
        await db.query(sql`INSERT INTO accounting_bank_transactions (
            id, source_key, transaction_date, description, reference, direction,
            currency, amount, amount_usd, category_key, category_name,
            classification_tier, classification_reason, source_file_hash,
            workflow_run_id, status
          ) VALUES (
            ${sourceKey}, ${sourceKey}, ${txn.date || null}, ${txn.description || null},
            ${txn.reference || txn.clave || null}, ${txn.direction || null}, 'MXN',
            ${Number(txn.amount || 0)}, ${txn.amount_usd == null ? null : Number(txn.amount_usd)},
            ${txn.category || null}, ${txn.category_name || null}, ${tier},
            ${txn.reason || txn.note || null}, ${sourceFileHash}, ${run.id}, 'classified'
          ) ON CONFLICT(source_key) DO UPDATE SET
            category_key=excluded.category_key,
            category_name=excluded.category_name,
            classification_tier=excluded.classification_tier,
            classification_reason=excluded.classification_reason,
            amount_usd=excluded.amount_usd,
            workflow_run_id=excluded.workflow_run_id,
            updated_at=datetime('now')`);
        persisted += 1;
      }
    }
    return {
      verified: true,
      source: 'kapital.statement_classification',
      providerStatus: 'classification_reconciled',
      evidence: state.execute.parsed,
      summary: { ...summary, persisted },
    };
  },
  summarize: ({ verification }) => ({ classification: verification.summary }),
});

async function projectReceiptQboWrites(db, runId, receiptWrites) {
  if (!receiptWrites.length) return true;
  await db.tx(async tx => {
    for (const write of receiptWrites) {
      await tx.query(sql`UPDATE accounting_receipts SET
        status='posted', qbo_entity_type='Purchase', qbo_entity_id=${String(write.qbo_id)},
        qbo_request_id=${write.request_id || null}, posted_at=datetime('now'),
        workflow_run_id=${runId}, updated_at=datetime('now')
        WHERE id=${String(write.receipt_id)} AND status IN ('matched','posted')`);
      await tx.query(sql`UPDATE accounting_reconciliations SET
        qbo_entity_type='Purchase', qbo_entity_id=${String(write.qbo_id)},
        workflow_run_id=${runId}, updated_at=datetime('now')
        WHERE receipt_id=${String(write.receipt_id)} AND status='matched'`);
    }
  });
  for (const write of receiptWrites) {
    const [receipt] = await db.query(sql`SELECT status, qbo_entity_type, qbo_entity_id
      FROM accounting_receipts WHERE id=${String(write.receipt_id)}`);
    const [reconciliation] = await db.query(sql`SELECT qbo_entity_type, qbo_entity_id
      FROM accounting_reconciliations
      WHERE receipt_id=${String(write.receipt_id)} AND status='matched'`);
    if (receipt?.status !== 'posted' || receipt.qbo_entity_type !== 'Purchase'
        || String(receipt.qbo_entity_id) !== String(write.qbo_id)
        || reconciliation?.qbo_entity_type !== 'Purchase'
        || String(reconciliation.qbo_entity_id) !== String(write.qbo_id)) return false;
  }
  return true;
}

async function projectBankTransactionQboWrites(db, runId, summary) {
  const sourceFileHash = String(summary.source_file_hash || '');
  const rows = [
    ...(Array.isArray(summary.dedup_details) ? summary.dedup_details : []),
    ...(Array.isArray(summary.details) ? summary.details : []),
  ].filter(row => ['EXISTING', 'PUSHED'].includes(row.status));
  if (!sourceFileHash || !rows.length) return rows.length === 0;

  for (const row of rows) {
    const status = row.requires_review ? 'posted_review'
      : row.status === 'EXISTING' ? 'already_recorded' : 'posted';
    const qboEntityType = row.qbo_entity_type
      || (row.record_type === 'deposit' ? 'Deposit'
        : row.record_type === 'transfer' ? 'Transfer' : 'Purchase');
    const reference = row.reference || null;
    // Overlapping Kapital exports reuse the durable transaction row. The
    // classifier updates that row's workflow run but intentionally preserves
    // the hash of the first source file, so an exact bank reference must be
    // resolved across source files. Requiring one exact candidate keeps the
    // projection fail-closed if the upstream identity is ever ambiguous.
    const candidates = reference
      ? await db.query(sql`SELECT id FROM accounting_bank_transactions
          WHERE transaction_date=${String(row.date || '')}
            AND amount=${Number(row.amount || 0)} AND reference=${reference}`)
      : await db.query(sql`SELECT id FROM accounting_bank_transactions
          WHERE source_file_hash=${sourceFileHash} AND transaction_date=${String(row.date || '')}
            AND amount=${Number(row.amount || 0)} AND reference IS NULL`);
    if (candidates.length !== 1) return false;
    await db.query(sql`UPDATE accounting_bank_transactions SET
      qbo_workflow_run_id=${runId}, qbo_entity_type=${qboEntityType},
      qbo_entity_id=${row.qbo_id || null}, qbo_request_id=${row.request_id || null},
      qbo_category_key=${row.category_key || null}, qbo_category_name=${row.category || null},
      qbo_recorded_at=datetime('now'), review_required=${row.requires_review ? 1 : 0},
      status=${status}, updated_at=datetime('now') WHERE id=${candidates[0].id}`);
    const [readback] = await db.query(sql`SELECT status, qbo_workflow_run_id,
      qbo_entity_type, qbo_entity_id, qbo_category_key, review_required
      FROM accounting_bank_transactions WHERE id=${candidates[0].id}`);
    if (readback?.status !== status || readback.qbo_workflow_run_id !== runId
        || readback.qbo_entity_type !== qboEntityType
        || String(readback.qbo_entity_id || '') !== String(row.qbo_id || '')
        || String(readback.qbo_category_key || '') !== String(row.category_key || '')
        || Number(readback.review_required || 0) !== (row.requires_review ? 1 : 0)) return false;
  }
  return true;
}

function buildQboNotificationMessage({ run, state }) {
  const summary = state.verify_readback?.summary || {};
  const reviewDetails = Array.isArray(summary.reviewDetails) ? summary.reviewDetails : [];
  const heldDetails = Array.isArray(summary.heldDetails) ? summary.heldDetails : [];
  const principalRecorded = Number(summary.principalRecorded || 0);
  const principalTotal = Number(summary.principalTotal || 0);
  const feeRecordsRecorded = Number(summary.feeRecordsRecorded || 0);
  const feeRecordsExpected = Number(summary.feeRecordsExpected || 0);
  const lines = [
    `${summary.complete ? '✅' : '⚠️'} Kapital statement reconciliation completed with QBO provider readback. Workflow ${run.id}.`,
    `• Principal transactions recorded: ${principalRecorded}/${principalTotal}`,
    `• Principal transactions written in this run: ${summary.principalWritten || 0}`,
    `• Principal transactions already present: ${summary.dedupSkipped || 0}`,
    `• SPEI fee lines recorded: ${feeRecordsRecorded}/${feeRecordsExpected} (${summary.feeRecordsWritten || 0} written now)`,
    `• Recorded to Uncategorized Expense for categorization review: ${summary.reviewRequired || 0}`,
    `• Not recorded: ${summary.held || 0}`,
  ];
  if (reviewDetails.length) {
    lines.push('Recorded, category review required:');
    for (const detail of reviewDetails.slice(0, 10)) {
      const amount = Number(detail.amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      lines.push(`• ${detail.date || 'unknown date'} ${detail.currency || 'MXN'} ${amount} — QBO ${detail.qbo_id || 'pending'} — ${detail.review_reason || 'category review required'}`);
    }
    if (reviewDetails.length > 10) lines.push(`• ${reviewDetails.length - 10} additional categorization review(s)`);
  }
  if (heldDetails.length) {
    lines.push('Not recorded:');
    for (const detail of heldDetails.slice(0, 10)) {
      const amount = Number(detail.amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      lines.push(`• ${detail.date || 'unknown date'} ${detail.currency || 'MXN'} ${amount} — ${detail.review_reason || 'posting review required'}`);
    }
    if (heldDetails.length > 10) lines.push(`• ${heldDetails.length - 10} additional unrecorded transaction(s)`);
  }
  return lines.join('\n');
}

const qboWrite = makeDurableJob({
  name: 'qbo.write',
  capability: 'qbo.write',
  provider: 'quickbooks',
  operation: 'kapital_transactions.write',
  autonomous: true,
  notificationChannelName: 'accounting',
  mentionUsers: false,
  buildNotificationMessage: buildQboNotificationMessage,
  validate: input => { safeAccountingCsv(input); },
  requestSummary: input => ({ csv: path.basename(safeAccountingCsv(input)), classificationTier: 'auto_only' }),
  buildCommand: ({ input, shadowMode }) => pythonCommand(
    'accounting/qbo_push.py',
    [safeAccountingCsv(input), '--receipt-db', DB_PATH, '--record-unresolved', ...(shadowMode ? [] : ['--live']), '--json'],
    { timeoutMs: 30 * 60_000 },
  ),
  async verify({ db, run, state }) {
    const invalid = parseRequiredJson(state.execute, 'QBO writer');
    if (invalid) return invalid;
    const summary = state.execute.parsed;
    const written = (summary.expenses_pushed || 0) + (summary.income_pushed || 0) + (summary.transfers_pushed || 0);
    const principalWritten = (summary.details || []).filter(row => row.status === 'PUSHED').length;
    const unverified = (summary.details || []).filter(row => row.status === 'PUSHED' && row.verified_by_readback !== true);
    if ((summary.errors || []).length || unverified.length) {
      return { verified: false, reason: 'one or more QBO writes failed provider readback' };
    }
    const receiptWrites = (summary.details || []).filter(row =>
      row.status === 'PUSHED' && row.receipt_id && row.qbo_id && row.record_type === 'expense');
    if (!await projectReceiptQboWrites(db, run.id, receiptWrites)) {
      return { verified: false, reason: 'receipt QBO projection failed readback', retryable: true };
    }
    if (!await projectBankTransactionQboWrites(db, run.id, summary)) {
      return { verified: false, reason: 'bank-transaction QBO projection failed readback', retryable: true };
    }
    return {
      verified: true,
      source: 'quickbooks.entity_readback',
      providerStatus: written ? 'entities_readback_verified' : 'no_new_entities_verified',
      evidence: summary,
      summary: {
        written,
        principalWritten: summary.principal_written ?? principalWritten,
        principalRecorded: summary.principal_recorded || 0,
        principalTotal: summary.statement?.principal_count || 0,
        feeRecordsWritten: summary.fee_records_pushed || 0,
        feeRecordsExisting: summary.fee_records_existing || 0,
        feeRecordsRecorded: summary.fee_records_recorded || 0,
        feeRecordsExpected: summary.fee_records_expected || 0,
        feeDedupSkipped: summary.fee_dedup_skipped || 0,
        dedupSkipped: summary.dedup_skipped || 0,
        skipped: summary.skipped || 0,
        receiptsPosted: receiptWrites.length,
        reviewRequired: summary.review_required || 0,
        reviewDetails: summary.review_details || [],
        held: summary.held || 0,
        heldDetails: summary.held_details || [],
        categoryTotals: summary.category_totals || [],
        principalDetails: summary.principal_details || [],
        statement: summary.statement || {},
        sourceFileHash: summary.source_file_hash || null,
        complete: summary.complete === true,
      },
    };
  },
  summarize: ({ verification }) => ({ qbo: verification.summary }),
});

module.exports = {
  accountingClassify,
  buildQboNotificationMessage,
  crmSync,
  ownerrezCrmSync,
  paulinaDaily,
  projectReceiptQboWrites,
  projectBankTransactionQboWrites,
  qboWrite,
  reginaCampaign,
  reginaDaily,
  safeAccountingCsv,
  socialPublishRoutine,
  squarespaceCrmSync,
};
