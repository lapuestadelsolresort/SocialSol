/**
 * Prospector Paulina — Composer (Step 3.2)
 *
 * Generates one cold-outbound draft per call. Reads the persona library,
 * runs a pre-check compliance gate, calls Claude, runs a content-only
 * post-check, INSERTs an outreach_sends row at pending_approval, and posts
 * a draft message to #prospector-paulina via OpenClaw.
 *
 * Public API:
 *   compose({ persona_id, contact_id, campaign_id, options })
 *     → { ok: true,  draft_id, slack_message_ts, hook_angle }
 *     → { ok: false, reason, details }
 *
 * CLI:
 *   node composer.js compose --persona <id> --contact <id> --campaign <id> [--dry-run]
 *   node composer.js compose-batch <campaign_slug> [N]
 *
 * Hard boundary with Step 3.3:
 *   - Composer writes status='pending_approval'. It does NOT call send.sh.
 *   - Composer reads recent-sends.jsonl. It does NOT write to it (3.3 does on send).
 *   - Composer's body_full is the LLM body — the unsubscribe footer is added
 *     by send.sh at send time (preserves single-source-of-truth for the token).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const Anthropic = require('@anthropic-ai/sdk');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { execFile } = require('child_process');

const { evaluateCompliance, loadDisclosurePatterns } = require('./lib/compliance');
const { loadBannedPhrases, findBannedPhrase } = require('./lib/banned-phrases');
const { loadSection4: loadVoiceSpecSection4 } = require('./lib/voice-spec-section');
const {
  DB_PATH,
  OPENCLAW_BIN: OPENCLAW,
} = require('../lib/runtime-paths');

const PROSPECTOR_DIR = __dirname;
const LIBRARY_DIR = path.join(PROSPECTOR_DIR, 'library');
const RECENT_SENDS_PATH = path.join(LIBRARY_DIR, 'recent-sends.jsonl');
const CONFIG_PATH = path.join(PROSPECTOR_DIR, 'config.json');
const VOICE_SPEC_PATH = path.join(PROSPECTOR_DIR, 'voice-spec.md');
const PROMPT_TEMPLATE_PATH = path.join(PROSPECTOR_DIR, 'composer-prompt.md');

const SUBJECT_MIN = 15;
const SUBJECT_MAX = 60;
const MAX_RECOMPOSE_ATTEMPTS = 1;

// ─── Loaders ────────────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Parse YAML-ish frontmatter (between `---` lines) plus body. We only need
// the front-matter keys library_status and landing_page_url + a few others;
// a full YAML parser would be overkill.
function parseFrontMatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { frontMatter: {}, body: raw };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][\w\-]*)\s*:\s*(.*)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { frontMatter: fm, body: m[2] };
}

function loadPersona(personaId) {
  const p = path.join(LIBRARY_DIR, 'personas', `${personaId}.md`);
  if (!fs.existsSync(p)) throw new Error(`Persona file not found: ${p}`);
  const raw = fs.readFileSync(p, 'utf8');
  return { path: p, raw, ...parseFrontMatter(raw) };
}

function loadExamples(personaId) {
  const dir = path.join(LIBRARY_DIR, 'examples', personaId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

function loadConstraints() {
  return JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'shared', 'constraints.json'), 'utf8'));
}

function loadVoiceConstraintsBlock() {
  // §4 contract: everything between "## 4." and "## 5." in voice-spec.md.
  // The regex itself lives in ./lib/voice-spec-section so the R3 Voice
  // Service (crm/lib/voice-draft.js) can import the exact same pattern
  // — see crm/test/voice-draft.test.js for the byte-equality assertion.
  // The structural guard ("§5 must immediately follow §4 with no
  // intervening H2") also lives in that test file; if a future
  // voice-spec rebuild moves §5 or inserts a new H2 between them, the
  // guard test fails and Paulina's prompt assembly silently drops §4.
  // Fix the spec template; do not loosen this contract.
  return loadVoiceSpecSection4(VOICE_SPEC_PATH);
}

function tailRecentSends(n) {
  if (!fs.existsSync(RECENT_SENDS_PATH)) return [];
  const lines = fs.readFileSync(RECENT_SENDS_PATH, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function loadContact(db, contactId) {
  const [c] = await db.query(sql`SELECT * FROM contacts WHERE id = ${contactId}`);
  return c || null;
}

async function loadCampaign(db, campaignId) {
  const [c] = await db.query(sql`SELECT * FROM outreach_campaigns WHERE id = ${campaignId}`);
  return c || null;
}

// ─── Pre-check (items 1, 2, 3, 5) — no LLM call ─────────────────────────────
//
// Strategy: invoke evaluateCompliance with a synthetic body that passes the
// content-dependent items (4, 6, 7) so we can isolate the queries for items
// 1, 2, 3, 5. This avoids re-implementing the calendar-week math and the
// suppression query.
async function preCheckCompliance(db, config, { contact, campaign }) {
  const fakeToken = 'PRECHECK_PLACEHOLDER';
  // Build a synthetic body with all the elements present so items 4-7 don't
  // taint the result. We only inspect items 1, 2, 3, 5.
  const fakeUrl = `https://webhook.lapuestadelsolresort.com/unsubscribe?token=${fakeToken}`;
  const syntheticBody = [
    'I came across your work and wanted to say hello.',
    'reach out',
    config.physical_address || '',
    fakeUrl,
  ].join('\n');
  const fakeHeaders = {
    'List-Unsubscribe': `<mailto:unsubscribe@outreach.lapuestadelsolresort.com>, <${fakeUrl}>`,
  };
  const result = await evaluateCompliance(db, config, {
    email: contact.email || `contact-${contact.id}@unknown.local`,
    contactId: contact.id,
    campaignId: campaign.id,
    campaignName: campaign.slug || campaign.name,
    subject: 'precheck',
    body: syntheticBody,
    headers: fakeHeaders,
    whyContactingPresent: true,
  });
  // Return the items we care about for the pre-check.
  const failedPre = [];
  if (result.items[1] === false) failedPre.push('item_1_in_suppressions');
  if (result.items[2] === false) failedPre.push('item_2_do_not_contact');
  if (result.items[3] === false) failedPre.push(result.failures.find((f) => f.startsWith('item_3_')) || 'item_3_failed');
  if (result.items[5] === false) failedPre.push('item_5_no_canonical_address_configured');
  return { pass: failedPre.length === 0, failures: failedPre };
}

// ─── Post-check (items 6, 7) — on the LLM body ──────────────────────────────
//
// Item 4 (token signing) is not checkable at compose time — the token is
// generated by send.sh. send.sh's gate enforces it on every send. Items 1-5
// were already pre-checked. Items 6 (disclosure pattern) and 7 (banned phrase)
// are the LLM-content risk surface.
function postCheckContent(subject, body) {
  const failures = [];
  const text = `${subject || ''} ${body || ''}`;
  const phrases = loadBannedPhrases();
  const hit = findBannedPhrase(text, phrases);
  if (hit) failures.push({ failed_check: 'item_7_banned_phrase', details: hit.phrase });
  const patterns = loadDisclosurePatterns();
  const haystack = (body || '').toLowerCase();
  const matched = patterns.some((p) => haystack.includes(p));
  if (!matched) failures.push({ failed_check: 'item_6_no_disclosure_pattern', details: null });
  return { pass: failures.length === 0, failures };
}

// ─── Prompt building ────────────────────────────────────────────────────────

function buildPrompt({ persona, examples, constraints, voiceConstraints, recentSends, contact, campaign, retryHint }) {
  const tpl = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
  const personaBriefBody = persona.body.trim();
  const examplesBlock = examples.map((e, i) => `### Example ${i + 1}\n\n${e}`).join('\n\n---\n\n');
  const recentBlock = recentSends.length === 0
    ? '(no prior sends — write something fresh and distinct)'
    : recentSends.map((r) => `- ${r.persona} | ${r.hook_angle} | ${r.opener_first_sentence}`).join('\n');
  const bannedLines = loadBannedPhrases().slice(0, 60).join(', ');
  const disclosurePatterns = loadDisclosurePatterns().map((p) => `\`${p}\``).join(', ');
  const landingUrl = persona.frontMatter.landing_page_url || campaign.landing_page_url || '';
  const contactBlock = [
    `Name: ${contact.name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim()}`,
    `Email: ${contact.email || '(unknown — use "Hi there,")'}`,
    contact.first_name ? `First name: ${contact.first_name}` : null,
    contact.company ? `Company: ${contact.company}` : null,
    contact.title ? `Title: ${contact.title}` : null,
    contact.geography ? `Geography: ${contact.geography}` : null,
    contact.specialties ? `Specialties: ${contact.specialties}` : null,
    contact.recent_work ? `Recent work: ${contact.recent_work}` : null,
    contact.notes ? `Notes: ${contact.notes}` : null,
    contact.context_source ? `Source: ${contact.context_source}` : null,
  ].filter(Boolean).join('\n');

  let body = tpl
    .replace('{{VOICE_CONSTRAINTS}}', voiceConstraints)
    .replace('{{PERSONA_BRIEF}}', personaBriefBody)
    .replace('{{EXAMPLES}}', examplesBlock)
    .replace('{{LENGTH_MIN}}', String(constraints.length.min_words))
    .replace('{{LENGTH_MAX}}', String(constraints.length.max_words))
    .replace('{{SENTENCES_MIN}}', String(constraints.length.min_sentences))
    .replace('{{SENTENCES_MAX}}', String(constraints.length.max_sentences))
    .replace('{{SUBJECT_MIN}}', String(constraints.subject.min_chars))
    .replace('{{SUBJECT_MAX}}', String(constraints.subject.max_chars))
    .replace('{{DISCLOSURE_PATTERNS}}', disclosurePatterns)
    .replace('{{LANDING_PAGE_URL}}', landingUrl)
    .replace('{{BANNED_PHRASES}}', bannedLines)
    .replace('{{RECENT_COUNT}}', String(recentSends.length))
    .replace('{{RECENT_SENDS}}', recentBlock)
    .replace('{{CONTACT_BLOCK}}', contactBlock);

  if (retryHint) body += `\n\n## Retry hint\n\n${retryHint}\n`;

  // Inject daily A/B test hint from iteration-state.json (set by engagement-analysis.js)
  try {
    const iterState = JSON.parse(fs.readFileSync(path.join(PROSPECTOR_DIR, 'scripts', 'iteration-state.json'), 'utf8'));
    const hint = iterState?.current_hypothesis?.composer_hint;
    if (hint) body += `\n\n## Today's A/B test instruction (from daily analysis)\n\n${hint}\n`;
  } catch { /* no iteration state yet — skip */ }

  return body;
}

// ─── LLM call ──────────────────────────────────────────────────────────────

async function callLLM({ prompt, model }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
  return {
    text,
    inputTokens: resp.usage?.input_tokens ?? null,
    outputTokens: resp.usage?.output_tokens ?? null,
  };
}

function parseJsonResponse(text) {
  // Tolerate ```json fences and surrounding prose.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text.trim();
  // Find the first { ... } block
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`No JSON object found in LLM response: ${text.slice(0, 200)}…`);
  const jsonText = candidate.slice(start, end + 1);
  const obj = JSON.parse(jsonText);
  if (!obj.subject || !obj.body || !obj.hook_angle) {
    throw new Error(`LLM response missing required keys (subject/body/hook_angle): ${jsonText.slice(0, 200)}…`);
  }
  return obj;
}

// ─── Slack post (Pathway B for v0 — text command pathway) ────────────────────
//
// Pathway A (interactive Block Kit buttons via the OpenClaw plugin) is
// implemented in Phase D and posts to the same channel via the plugin's
// HTTP route. For v0, the composer ships with Pathway B: a text-formatted
// post per slack-interaction.md §5.1 with `!approve <id>` / `!reject <id>
// <reason>` / `!edit <id>` instructions in the footer. The Slack message_ts
// returned here is what the plugin uses for chat.update on click in Phase D.
function buildDraftMessage({ draftId, contact, campaign, persona, hookAngle, subject, body }) {
  const personaPath = path.relative(path.resolve(PROSPECTOR_DIR, '..'), persona.path);
  const reviewedDate = persona.frontMatter.last_reviewed_by_sarah || 'not yet';
  return [
    `📝 Draft #${draftId} — ready for review`,
    '',
    `Contact:    ${contact.name}${contact.email ? ` <${contact.email}>` : ''}`,
    `            ${contact.company || '(no company)'}${contact.context_source ? ` • ${contact.context_source}` : ''}`,
    `Campaign:   ${campaign.slug || campaign.name}`,
    `Persona:    ${personaPath} (${persona.frontMatter.status || 'v0'} — Sarah-reviewed: ${reviewedDate})`,
    `Subject:    ${subject}`,
    `Hook:       ${hookAngle}`,
    '',
    '──────────────────────────────────────',
    body,
    '──────────────────────────────────────',
    '',
    `Approve:  \`!approve ${draftId}\``,
    `Reject:   \`!reject ${draftId} <reason>\``,
    `Edit:     \`!edit ${draftId}\``,
    '',
    `(Block Kit buttons are Phase D polish; for v0, use the text commands above.)`,
  ].join('\n');
}

function postToSlack(channelId, message) {
  const slackAccount = process.env.OPENCLAW_SLACK_ACCOUNT;
  if (!slackAccount) {
    return Promise.resolve({ ok: false, error: 'OPENCLAW_SLACK_ACCOUNT is not configured' });
  }
  return new Promise((resolve) => {
    execFile(OPENCLAW, [
      'message', 'send',
      '--channel', 'slack',
      '--account', slackAccount,
      '--target', channelId,
      '--message', message,
      '--json',
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message, stderr: String(stderr || '') });
      try {
        const out = JSON.parse(stdout);
        const messageId = out?.payload?.result?.messageId || null;
        const channelIdResolved = out?.payload?.result?.channelId || channelId;
        resolve({ ok: Boolean(messageId), messageId, channelId: channelIdResolved, raw: out });
      } catch (e) {
        resolve({ ok: false, error: 'parse_error', stdout: String(stdout || '') });
      }
    });
  });
}

// ─── Main entry point ──────────────────────────────────────────────────────

async function compose({ persona_id, contact_id, campaign_id, options = {} } = {}) {
  const dryRun = Boolean(options.dry_run);
  const verbose = Boolean(options.verbose);
  const workflowRunId = typeof options.workflow_run_id === 'string'
    && /^[0-9a-f-]{36}$/i.test(options.workflow_run_id)
    ? options.workflow_run_id
    : null;
  const config = loadConfig();
  const constraints = loadConstraints();
  const voiceConstraints = loadVoiceConstraintsBlock();
  const recentSends = tailRecentSends(constraints.diversity?.recent_sends_window || 25);
  const persona = loadPersona(persona_id);
  if ((persona.frontMatter.library_status || '').toLowerCase() === 'draft') {
    return { ok: false, reason: 'persona_draft', details: { persona_id } };
  }
  const examples = loadExamples(persona_id);

  const db = createDB(DB_PATH);
  try {
    const contact = await loadContact(db, contact_id);
    if (!contact) return { ok: false, reason: 'contact_not_found', details: { contact_id } };
    const campaign = await loadCampaign(db, campaign_id);
    if (!campaign) return { ok: false, reason: 'campaign_not_found', details: { campaign_id } };
    if (config.email_verification?.required_before_compose !== false && contact.email_status !== 'verified') {
      return {
        ok: false,
        reason: 'email_not_preverified',
        details: { contact_id, email_status: contact.email_status || 'unknown' },
      };
    }

    const pre = await preCheckCompliance(db, config, { contact, campaign });
    if (!pre.pass) {
      return { ok: false, reason: 'pre_check_failed', details: { failed_items: pre.failures } };
    }
    if (verbose) console.error(`[composer] pre-check passed for contact ${contact_id} on campaign ${campaign_id}`);

    const model = config.composer?.model || 'claude-sonnet-4-6';
    let attempt = 1;
    let result, retryHint = null;
    while (true) {
      const prompt = buildPrompt({ persona, examples, constraints, voiceConstraints, recentSends, contact, campaign, retryHint });
      let llm;
      try {
        llm = await callLLM({ prompt, model });
      } catch (e) {
        return { ok: false, reason: 'llm_call_failed', details: { error: e.message, attempt } };
      }
      let parsed;
      try {
        parsed = parseJsonResponse(llm.text);
      } catch (e) {
        if (attempt < MAX_RECOMPOSE_ATTEMPTS + 1) {
          attempt++;
          retryHint = 'Your previous response was not valid JSON. Return ONLY a JSON object with keys subject, body, hook_angle.';
          continue;
        }
        return { ok: false, reason: 'llm_response_unparseable', details: { error: e.message, attempt } };
      }

      const post = postCheckContent(parsed.subject, parsed.body);
      result = { llm, parsed, gate: post, attempt };
      if (post.pass) break;
      if (attempt > MAX_RECOMPOSE_ATTEMPTS) break;
      const failedItems = post.failures.map((f) => f.failed_check);
      attempt++;
      const hints = [];
      if (failedItems.includes('item_7_banned_phrase')) {
        const phrase = post.failures.find((f) => f.failed_check === 'item_7_banned_phrase').details;
        hints.push(`Your previous response used a banned phrase ("${phrase}"). Rewrite without using any of the banned substrings.`);
      }
      if (failedItems.includes('item_6_no_disclosure_pattern')) {
        hints.push(`Your previous response did not include a why-contacting disclosure pattern. The body MUST contain one of: ${loadDisclosurePatterns().map((p) => `"${p}"`).join(', ')}.`);
      }
      retryHint = hints.join('\n');
    }

    // Post-check final result
    if (!result.gate.pass) {
      return {
        ok: false,
        reason: 'post_check_failed',
        details: { failed_items: result.gate.failures, attempt: result.attempt, llm_subject: result.parsed.subject, llm_body: result.parsed.body },
      };
    }

    // Subject length check (soft constraint — not in compliance gate)
    if (result.parsed.subject.length < SUBJECT_MIN || result.parsed.subject.length > SUBJECT_MAX) {
      return { ok: false, reason: 'subject_length_out_of_range', details: { length: result.parsed.subject.length, min: SUBJECT_MIN, max: SUBJECT_MAX, subject: result.parsed.subject } };
    }

    if (dryRun) {
      return {
        ok: true, dry_run: true, draft_id: null, slack_message_ts: null,
        hook_angle: result.parsed.hook_angle, attempt: result.attempt,
        subject: result.parsed.subject, body: result.parsed.body,
      };
    }

    // ── INSERT outreach_sends row at pending_approval ──
    const composerInputs = {
      persona_id,
      recent_sends_count: recentSends.length,
      model,
      prompt_tokens: result.llm.inputTokens,
      completion_tokens: result.llm.outputTokens,
      attempt: result.attempt,
    };
    const bodyPreview = result.parsed.body.substring(0, 200);
    await db.query(sql`
      INSERT INTO outreach_sends (contact_id, campaign_id, sequence_step,
                                   subject, body_full, body_preview,
                                   hook_angle, composer_inputs, status, created_at,
                                   workflow_run_id)
      VALUES (${contact_id}, ${campaign_id}, 1,
              ${result.parsed.subject}, ${result.parsed.body}, ${bodyPreview},
              ${result.parsed.hook_angle}, ${JSON.stringify(composerInputs)},
              'pending_approval', ${new Date().toISOString()}, ${workflowRunId})
    `);
    const [created] = await db.query(sql`SELECT * FROM outreach_sends WHERE contact_id = ${contact_id} AND campaign_id = ${campaign_id} ORDER BY id DESC LIMIT 1`);
    const draftId = created.id;

    // ── Post draft to Slack ──
    const channelId = config.channel_id;
    const message = buildDraftMessage({
      draftId, contact, campaign, persona,
      hookAngle: result.parsed.hook_angle,
      subject: result.parsed.subject,
      body: result.parsed.body,
    });
    const slack = await postToSlack(channelId, message);
    const postedAt = new Date().toISOString();
    if (slack.ok) {
      await db.query(sql`
        UPDATE outreach_sends
        SET slack_message_ts = ${slack.messageId}, slack_channel_id = ${slack.channelId}, posted_at = ${postedAt}
        WHERE id = ${draftId}
      `);
    } else {
      // Couldn't post; mark posted_at so the row isn't lost from view, but
      // surface the slack error.
      await db.query(sql`UPDATE outreach_sends SET error = ${'slack_post_failed:' + (slack.error || 'unknown')} WHERE id = ${draftId}`);
      console.warn(`[composer] Draft #${draftId} written but Slack post failed: ${slack.error}`);
    }

    // ── Auto-approve if config flag is set (standing order: skip manual review) ──
    let autoApproved = false;
    if (config.composer?.auto_approve) {
      try {
        const http = require('http');
        const approveResult = await new Promise((resolve, reject) => {
          const postData = JSON.stringify({ by: 'auto_approve:composer' });
          const crmBaseUrl = new URL(process.env.CRM_BASE_URL || 'http://127.0.0.1:3456');
          const req = http.request({
            hostname: crmBaseUrl.hostname,
            port: crmBaseUrl.port || undefined,
            path: `${crmBaseUrl.pathname.replace(/\/$/, '')}/api/drafts/${draftId}/approve`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
              try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
              catch { resolve({ status: res.statusCode, body }); }
            });
          });
          req.on('error', reject);
          req.write(postData);
          req.end();
        });
        if (approveResult.status === 200) {
          autoApproved = true;
          // stdout is reserved for the CLI's final JSON object. The daily job
          // captures and parses it; operational messages must stay on stderr.
          console.error(`[composer] Draft #${draftId} auto-approved → scheduled_at=${approveResult.body?.scheduled_at || '?'}`);
        } else {
          console.warn(`[composer] Draft #${draftId} auto-approve failed (HTTP ${approveResult.status}): ${JSON.stringify(approveResult.body)}`);
        }
      } catch (err) {
        console.warn(`[composer] Draft #${draftId} auto-approve error: ${err.message}`);
      }
    }

    return {
      ok: true,
      draft_id: draftId,
      auto_approved: autoApproved,
      slack_message_ts: slack.messageId || null,
      slack_channel_id: slack.channelId || null,
      hook_angle: result.parsed.hook_angle,
      attempt: result.attempt,
    };
  } finally {
    await db.dispose();
  }
}

// ─── Compose-batch (used by !compose-batch Slack command) ──────────────────

function remainingBatchSize(requested, alreadyComposed) {
  return Math.max(0, Number(requested || 0) - Number(alreadyComposed || 0));
}

async function composeBatch({ campaign_slug, n, options = {} }) {
  const config = loadConfig();
  const maxN = config.composer?.compose_batch_max_n || 5;
  const requested = Math.max(1, Math.min(n || 1, maxN));
  const workflowRunId = typeof options.workflow_run_id === 'string'
    && /^[0-9a-f-]{36}$/i.test(options.workflow_run_id)
    ? options.workflow_run_id
    : null;
  const db = createDB(DB_PATH);
  try {
    const [campaign] = await db.query(sql`SELECT * FROM outreach_campaigns WHERE slug = ${campaign_slug}`);
    if (!campaign) return { ok: false, reason: 'campaign_not_found', details: { campaign_slug } };
    const personaId = campaign.persona ? campaign.persona.replace(/_/g, '-') : null;
    if (!personaId) return { ok: false, reason: 'campaign_has_no_persona', details: { campaign_slug } };

    // Eligibility: contacts attached to this campaign with no outreach_sends
    // row in any non-cancelled status. In production, queue verification is a
    // hard prerequisite so Claude time and sender reputation are spent only
    // on named, deliverable mailboxes.
    const requireVerified = config.email_verification?.required_before_compose !== false;
    const [attributed] = workflowRunId
      ? await db.query(sql`SELECT COUNT(*) AS count FROM outreach_sends
          WHERE campaign_id=${campaign.id} AND workflow_run_id=${workflowRunId}`)
      : [{ count: 0 }];
    const alreadyComposed = Number(attributed?.count || 0);
    const remainingRequested = remainingBatchSize(requested, alreadyComposed);
    const eligible = await db.query(sql`
      SELECT cc.contact_id
      FROM campaign_contacts cc
      JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.campaign_id = ${campaign.id}
        AND (${requireVerified ? 1 : 0} = 0 OR c.email_status = 'verified')
        AND NOT EXISTS (
          SELECT 1 FROM outreach_sends os
          WHERE os.contact_id = cc.contact_id
            AND os.campaign_id = cc.campaign_id
            AND os.status != 'cancelled'
        )
      ORDER BY cc.attached_at ASC, cc.id ASC
      LIMIT ${remainingRequested}
    `);

    const composed = [];
    const failed = [];
    for (const row of eligible) {
      const r = await compose({
        persona_id: personaId,
        contact_id: row.contact_id,
        campaign_id: campaign.id,
        options: {
          dry_run: Boolean(options.dry_run),
          workflow_run_id: workflowRunId,
        },
      });
      if (r.ok) composed.push({
        contact_id: row.contact_id,
        draft_id: r.draft_id,
        hook_angle: r.hook_angle,
        auto_approved: Boolean(r.auto_approved),
      });
      else failed.push({ contact_id: row.contact_id, reason: r.reason, details: r.details });
    }
    return {
      ok: true,
      requested,
      already_composed: alreadyComposed,
      remaining_requested: remainingRequested,
      eligible_count: eligible.length,
      composed,
      failed,
    };
  } finally {
    await db.dispose();
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name) => {
    const idx = argv.findIndex((a) => a === `--${name}`);
    return idx >= 0 ? argv[idx + 1] : null;
  };
  const has = (name) => argv.includes(`--${name}`);

  if (cmd === 'compose') {
    const persona_id = flag('persona');
    const contact_id = flag('contact') ? parseInt(flag('contact')) : null;
    const campaign_id = flag('campaign') ? parseInt(flag('campaign')) : null;
    const options = { dry_run: has('dry-run'), verbose: has('verbose') };
    if (!persona_id || !contact_id || !campaign_id) {
      console.error('Usage: composer.js compose --persona <id> --contact <id> --campaign <id> [--dry-run] [--verbose]');
      process.exit(2);
    }
    compose({ persona_id, contact_id, campaign_id, options })
      .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
      .catch((e) => { console.error('FATAL:', e); process.exit(3); });
  } else if (cmd === 'compose-batch') {
    const campaign_slug = argv[1];
    const n = argv[2] ? parseInt(argv[2]) : 1;
    if (!campaign_slug) {
      console.error('Usage: composer.js compose-batch <campaign_slug> [N]');
      process.exit(2);
    }
    composeBatch({
      campaign_slug,
      n,
      options: {
        dry_run: has('dry-run'),
        workflow_run_id: process.env.WORKFLOW_RUN_ID || null,
      },
    })
      .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
      .catch((e) => { console.error('FATAL:', e); process.exit(3); });
  } else {
    console.error('Usage: composer.js <compose|compose-batch> ...');
    process.exit(2);
  }
}

module.exports = {
  buildPrompt,
  compose,
  composeBatch,
  loadVoiceConstraintsBlock,
  remainingBatchSize,
};
