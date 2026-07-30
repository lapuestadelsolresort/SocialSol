#!/usr/bin/env node
'use strict';
//
// crm/scripts/import-direct-email-contacts.js
//
// One-pass Gmail-thread scanner that finds resort-inquiry conversations in
// Sarah's inbox at sarah@lapuestadelsolresort.com, LLM-classifies survivors,
// and writes each candidate into pending_contacts_staging for human review
// via !staging-approve / !staging-reject (see COMMANDS.md).
//
// Nothing in the live `contacts` table is touched. That happens in the
// companion apply-staging-approvals.js after a human approves a row.
//
// Resumable via --resume (reads the page token from
// a private runtime state file).
//
// Flags:
//   --dry-run                  No DB writes, no Slack post, no LLM calls
//   --resume                   Resume from saved page token
//   --batch-size N             Threads per Gmail page (default 100)
//   --max-llm-calls N          Safety cap on paid classifications (default 200)
//   --max-pages N              Stop after N pages (default: unlimited)
//   --query "<gmail q>"        Override the default Gmail search query
//   --print-survivors          Log each coarse-filter survivor (dry-run aid)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { listThreadsPage, getThreadFull } = require('../lib/gmail-threads');
const { classifyThread } = require('../lib/llm-classify-thread');
const { postToChannel: slackPostToChannel } = require(
  '../../prospector/research/scripts/lib/slack'
);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');
const STATE_PATH = process.env.DIRECT_EMAIL_STATE_PATH
  || path.join(REPO_ROOT, 'memory', 'direct-email-import-state.json');
const PROSPECTOR_CONFIG_PATH = process.env.PROSPECTOR_CONFIG_PATH
  || path.join(REPO_ROOT, 'prospector', 'config.json');

const SARAH_ADDRESS = process.env.GMAIL_IMPERSONATE_USER || '';

// Coarse-filter: senders/local-parts that are never resort inquiries.
const NOISE_DOMAINS = [
  'calendly.com', 'stripe.com', 'squareup.com', 'airbnb.com', 'vrbo.com',
  'booking.com', 'guesty.com', 'ownerrez.com', 'mailchimp.com', 'sendgrid.net',
  'amazonaws.com', 'google.com', 'youtube.com', 'paypal.com', 'venmo.com',
  'usps.com', 'fedex.com', 'ups.com', 'expedia.com', 'tripadvisor.com',
  'instagram.com', 'facebookmail.com', 'linkedin.com', 'github.com',
];
const NOISE_LOCAL_PARTS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'bounces', 'bounce',
  'notifications', 'notification', 'alerts', 'alert',
  'newsletter', 'updates', 'support', 'team', 'hello',
  'billing', 'invoice', 'receipt', 'statement',
];
const TRANSACTIONAL_SUBJECT_RE = /^(re:\s*)?(receipt|invoice|booking confirmation|reservation confirmation|statement|welcome to|your order|order #|payment|refund|tracking|shipped|delivery)/i;

// Default Gmail search query: scope wide, then we filter in code. Excludes
// chats and a few clearly transactional senders to save thread.get calls.
const DEFAULT_Q = [
  '-in:chats',
  '-from:noreply',
  '-from:no-reply',
  '-from:mailer-daemon',
  '-from:notifications@',
  '-from:postmaster',
  '-from:bounces',
  '-from:alerts@',
].join(' ');

function parseFlags(argv) {
  const out = {
    dryRun: false,
    resume: false,
    batchSize: 100,
    maxLlmCalls: 200,
    maxPages: Infinity,
    query: DEFAULT_Q,
    printSurvivors: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--print-survivors') out.printSurvivors = true;
    else if (a === '--batch-size') out.batchSize = Number(argv[++i]) || 100;
    else if (a === '--max-llm-calls') out.maxLlmCalls = Number(argv[++i]) || 0;
    else if (a === '--max-pages') out.maxPages = Number(argv[++i]) || Infinity;
    else if (a === '--query') out.query = argv[++i] || DEFAULT_Q;
  }
  return out;
}

function loadProspectorChannelId() {
  try {
    const cfg = JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
    return cfg.channel_id || null;
  } catch (_) {
    return null;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function newBatchId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `batch_${ts}_${crypto.randomBytes(3).toString('hex')}`;
}

// Coarse filter: structural rules only, no LLM cost. Returns either
// { ok: true, inboundFrom, inboundText, inboundDate } or { ok: false, reason }.
function coarseFilter(thread) {
  if (TRANSACTIONAL_SUBJECT_RE.test(thread.subject || '')) {
    return { ok: false, reason: 'subject_transactional' };
  }
  const inbound = thread.messages.filter(
    (m) => (m.from.address || '').toLowerCase() !== SARAH_ADDRESS
  );
  if (inbound.length === 0) {
    return { ok: false, reason: 'no_inbound' };
  }
  const outbound = thread.messages.filter(
    (m) => (m.from.address || '').toLowerCase() === SARAH_ADDRESS
  );
  if (outbound.length === 0) {
    return { ok: false, reason: 'no_sarah_reply' };
  }
  // Use the latest inbound for extraction (most recent contact info).
  const latestInbound = inbound[inbound.length - 1];
  const addr = (latestInbound.from.address || '').toLowerCase();
  if (!addr || !addr.includes('@')) {
    return { ok: false, reason: 'no_inbound_address' };
  }
  const [local, domain] = addr.split('@');
  if (NOISE_DOMAINS.includes(domain)) {
    return { ok: false, reason: `noise_domain:${domain}` };
  }
  for (const np of NOISE_LOCAL_PARTS) {
    if (local === np || local.startsWith(`${np}+`) || local.startsWith(`${np}-`)) {
      return { ok: false, reason: `noise_local:${local}` };
    }
  }
  return {
    ok: true,
    inboundFrom: latestInbound.from,
    inboundText: latestInbound.text || '',
    inboundDate: latestInbound.date,
  };
}

// Last-line signature heuristic: pick a final 1-2-word title-case line if
// the From display name was empty.
function extractSignatureName(text) {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Walk backward through the last ~10 lines.
  const tail = lines.slice(-10).reverse();
  for (const line of tail) {
    // Skip quoted lines (`>`-prefixed) and obvious signatures URL/email lines.
    if (line.startsWith('>')) continue;
    if (/[@]/.test(line)) continue;
    if (/^https?:/i.test(line)) continue;
    if (line.length > 40) continue;
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}$/.test(line)) {
      return line;
    }
  }
  return null;
}

function snippet(text, len = 300) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, len);
}

async function alreadyStaged(db, threadId) {
  const rows = await db.query(sql`
    SELECT 1 FROM pending_contacts_staging WHERE thread_id = ${threadId} LIMIT 1
  `);
  return rows.length > 0;
}

async function findExistingContact(db, email) {
  const rows = await db.query(sql`
    SELECT id FROM contacts WHERE LOWER(email) = ${email.toLowerCase()} LIMIT 1
  `);
  return rows[0] ? rows[0].id : null;
}

async function insertStagingRow(db, row) {
  await db.query(sql`
    INSERT INTO pending_contacts_staging (
      thread_id, extracted_email, extracted_name, thread_subject,
      thread_snippet, first_message_at, last_message_at, message_count,
      llm_classification, llm_category, llm_confidence, llm_reasoning,
      existing_contact_id, suggested_action, status, batch_id
    ) VALUES (
      ${row.thread_id}, ${row.extracted_email}, ${row.extracted_name}, ${row.thread_subject},
      ${row.thread_snippet}, ${row.first_message_at}, ${row.last_message_at}, ${row.message_count},
      ${row.llm_classification}, ${row.llm_category}, ${row.llm_confidence}, ${row.llm_reasoning},
      ${row.existing_contact_id}, ${row.suggested_action}, ${row.status}, ${row.batch_id}
    )
    ON CONFLICT(thread_id) DO NOTHING
  `);
}

async function postBatchSummary(channelId, batchId, stats, samples) {
  if (!channelId) {
    console.warn('[direct-email-import] no PROSPECTOR_CHANNEL_ID — skipping Slack summary');
    return;
  }
  const lines = [
    `📥 Direct-email contact import — batch \`${batchId}\``,
    `Scanned: ${stats.scanned} · Coarse-filtered: ${stats.coarse_filtered}` +
      ` · LLM-classified: ${stats.classified} · Resort inquiries: ${stats.resort_inquiries}` +
      ` · New leads: ${stats.new_leads} · Already in CRM: ${stats.enrich_candidates}` +
      ` · Skipped/non-inquiry: ${stats.non_inquiries}`,
    '',
  ];
  if (samples.length > 0) {
    lines.push(`Top ${samples.length} pending (full list: \`!staging-list batch:${batchId}\`):`);
    for (const s of samples) {
      const name = s.extracted_name || '(no name)';
      const subj = (s.thread_subject || '').slice(0, 60);
      const tag = s.suggested_action === 'enrich'
        ? `enrich contact #${s.existing_contact_id}`
        : 'new lead';
      lines.push(
        `  #${s.id}  ${name} <${s.extracted_email}>  — ${tag}  · ` +
        `"${subj}"  · conf=${s.llm_confidence?.toFixed?.(2) ?? s.llm_confidence}`
      );
    }
    lines.push('');
  }
  lines.push('Review commands:');
  lines.push(`  \`!staging-list batch:${batchId}\``);
  lines.push(`  \`!staging-approve <id>\`     (or \`!staging-approve batch:${batchId}\`)`);
  lines.push(`  \`!staging-reject <id>\``);
  lines.push('');
  lines.push('Apply after review:  `node crm/scripts/apply-staging-approvals.js`');
  try {
    await slackPostToChannel('channel:' + channelId, lines.join('\n'));
  } catch (e) {
    console.warn('[direct-email-import] Slack post failed:', e.message);
  }
}

async function run() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[direct-email-import] flags:', flags);

  let batchId;
  let pageToken = null;
  const existingState = flags.resume ? readState() : null;
  if (existingState && existingState.batch_id) {
    batchId = existingState.batch_id;
    pageToken = existingState.last_page_token || null;
    console.log(`[direct-email-import] resuming batch=${batchId} from page_token=${pageToken ? '<set>' : '<start>'}`);
  } else {
    batchId = newBatchId();
    console.log(`[direct-email-import] new batch=${batchId}`);
  }

  const db = flags.dryRun ? null : createDB(DB_PATH);
  const channelId = loadProspectorChannelId();

  const stats = {
    scanned: 0,
    coarse_filtered: 0,
    classified: 0,
    resort_inquiries: 0,
    new_leads: 0,
    enrich_candidates: 0,
    non_inquiries: 0,
    already_staged: 0,
    llm_calls: 0,
  };
  const insertedSamples = [];

  let pageNum = 0;
  try {
    while (pageNum < flags.maxPages) {
      pageNum += 1;
      let page;
      try {
        page = await listThreadsPage({
          q: flags.query,
          pageToken,
          maxResults: flags.batchSize,
        });
      } catch (e) {
        console.error('[direct-email-import] threads.list failed:', e.message);
        break;
      }
      stats.scanned += page.threads.length;
      console.log(
        `[direct-email-import] page=${pageNum} threads=${page.threads.length}` +
        ` (cumulative scanned=${stats.scanned})`
      );

      for (const t of page.threads) {
        if (!flags.dryRun && (await alreadyStaged(db, t.id))) {
          stats.already_staged += 1;
          continue;
        }

        let full;
        try {
          full = await getThreadFull(t.id);
        } catch (e) {
          console.warn(`[direct-email-import] threads.get ${t.id} failed: ${e.message}`);
          continue;
        }

        const coarse = coarseFilter(full);
        if (!coarse.ok) {
          if (flags.printSurvivors) {
            console.log(`    drop ${t.id} reason=${coarse.reason} subject="${(full.subject || '').slice(0, 60)}"`);
          }
          continue;
        }
        stats.coarse_filtered += 1;
        if (flags.printSurvivors) {
          console.log(
            `    survivor ${t.id} from=${coarse.inboundFrom.address}` +
            ` subject="${(full.subject || '').slice(0, 60)}"`
          );
        }

        if (flags.dryRun || stats.llm_calls >= flags.maxLlmCalls) {
          continue;
        }

        const llm = await classifyThread(full);
        stats.llm_calls += 1;
        stats.classified += 1;

        const isInquiry = llm.classification === 'resort_inquiry';
        let suggestedAction;
        if (!isInquiry) {
          suggestedAction = 'skip';
          stats.non_inquiries += 1;
        } else {
          stats.resort_inquiries += 1;
          const email = coarse.inboundFrom.address.toLowerCase();
          const existingId = await findExistingContact(db, email);
          if (existingId) {
            suggestedAction = 'enrich';
            stats.enrich_candidates += 1;
          } else {
            suggestedAction = 'create';
            stats.new_leads += 1;
          }
        }

        const extractedName = coarse.inboundFrom.name
          || extractSignatureName(coarse.inboundText)
          || null;
        const existingId = isInquiry
          ? await findExistingContact(db, coarse.inboundFrom.address.toLowerCase())
          : null;

        await insertStagingRow(db, {
          thread_id: t.id,
          extracted_email: coarse.inboundFrom.address.toLowerCase(),
          extracted_name: extractedName,
          thread_subject: full.subject || null,
          thread_snippet: snippet(coarse.inboundText),
          first_message_at: full.firstAt,
          last_message_at: full.lastAt,
          message_count: full.messageCount,
          llm_classification: llm.classification,
          llm_category: llm.category,
          llm_confidence: llm.confidence,
          llm_reasoning: llm.reasoning,
          existing_contact_id: existingId,
          suggested_action: suggestedAction,
          status: 'pending',
          batch_id: batchId,
        });

        if (suggestedAction !== 'skip' && insertedSamples.length < 10) {
          const [row] = await db.query(sql`
            SELECT id, extracted_email, extracted_name, thread_subject,
                   llm_confidence, suggested_action, existing_contact_id
            FROM pending_contacts_staging
            WHERE thread_id = ${t.id}
          `);
          if (row) insertedSamples.push(row);
        }
      }

      writeState({
        batch_id: batchId,
        last_page_token: page.nextPageToken,
        started_at: existingState ? existingState.started_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stats,
      });

      if (!page.nextPageToken) {
        console.log('[direct-email-import] reached end of threads');
        break;
      }
      pageToken = page.nextPageToken;

      if (stats.llm_calls >= flags.maxLlmCalls && !flags.dryRun) {
        console.log(
          `[direct-email-import] hit --max-llm-calls=${flags.maxLlmCalls};` +
          ' stopping early (rerun --resume to continue)'
        );
        break;
      }
    }
  } finally {
    if (db) await db.dispose();
  }

  console.log('[direct-email-import] final stats:', stats);

  if (!flags.dryRun && (stats.new_leads + stats.enrich_candidates) > 0) {
    await postBatchSummary(channelId, batchId, stats, insertedSamples);
  } else if (flags.dryRun) {
    console.log('[direct-email-import] dry-run — Slack post skipped');
  } else {
    console.log('[direct-email-import] no actionable rows — Slack post skipped');
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[direct-email-import] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
