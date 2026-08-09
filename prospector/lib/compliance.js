/**
 * Compliance gate (Phase D Step 3.1b) — runs before every outbound prospect send.
 *
 * Two entry points:
 *
 *   evaluateCompliance(db, config, input)
 *     Side-effect-free at the gate layer (no writes, no Slack pings, no
 *     state.json mutations) but reads from the DB to evaluate items 1, 2, 3.
 *     Returns a result struct describing pass/fail per item. Composer
 *     (Step 3.2) calls this at draft-review time without burning compliance_failures
 *     rows on every regeneration. Orchestrator (Step 3.3) calls it again at
 *     send-time — the world may have changed between approval and send.
 *
 *   recordComplianceFailure(db, config, ctx, evaluation)
 *     The side-effecting wrapper. Writes one compliance_failures row per
 *     failed item, posts a Slack summary to #prospector-paulina, and (when
 *     evaluation.pauseCampaign is true) flips state.json to paused.
 *     The orchestrator (Step 3.3, replaces send.sh) calls this on hard fail.
 *     ctx.source defaults to 'send_time' per the spec §6 enum; orchestrator
 *     overrides to 'send_time_override' on the edit-override carve-out path
 *     (per step_3.3_spec.md §2.4 — gate fails on rows that already had an
 *     edit_override compliance_failures row are advisory, NOT pause-triggering).
 *
 * The 7 items, mapped to their pause-on-fail semantics:
 *
 *   Items 1, 2, 3, 4, 5, 6-pattern → hard fail, abort send + log row + AUTO-PAUSE
 *   Item 6-manual                  → no row at gate time; logged later if human rejects
 *   Item 7 (banned phrase)         → hard fail, abort send + log row, NO PAUSE
 *
 * ─── Calendar-week-throughout cap windowing ─────────────────────────────────
 *
 * Item 3 enforces the per-campaign weekly send cap. Both the count window
 * AND the cap-index selection use calendar weeks (Mon 00:00 PT → Sun 23:59 PT)
 * — NOT a rolling 7 days from first_send_at. Tradeoff: a campaign that first
 * sends mid-week gets a fast cap progression at the next Monday boundary
 * (e.g. first send Wed → cap 5 for ~5 days → cap 10 the following Mon). This
 * is deliberate: simpler to reason about than mixing calendar count windows
 * with rolling-7-day cap selection, and easier for Sarah to mentally check
 * ("we're in week 2, cap is 10"). Don't reinstate the more complex hybrid
 * model unless ramp behavior at scale demands it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sql } = require('@databases/sqlite');
const { verifyUnsubscribeToken } = require('../../crm/lib/unsubscribe');
const { loadBannedPhrases, findBannedPhrase } = require('./banned-phrases');
const { UNSUB_URL_BASE } = require('./headers');

const DEFAULT_COMPLIANCE_ELEMENTS_PATH = path.join(
  __dirname,
  '..',
  'library',
  'shared',
  'compliance-elements.md'
);

// ─── Pattern loaders ───────────────────────────────────────────────────────

/**
 * Parse the "## Why-contacting disclosure patterns" section out of
 * compliance-elements.md. Bullet items in backticks become the pattern list.
 * Returns lowercase strings for case-insensitive substring match.
 */
function loadDisclosurePatterns(filePath = DEFAULT_COMPLIANCE_ELEMENTS_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const headerRe = /^##\s+Why-contacting disclosure patterns[^\n]*$/im;
  const m = raw.match(headerRe);
  if (!m) {
    throw new Error(
      `loadDisclosurePatterns: '## Why-contacting disclosure patterns' header ` +
        `not found in ${filePath}; gate cannot enforce item 6 pattern check.`
    );
  }
  const sectionStart = m.index + m[0].length;
  const after = raw.slice(sectionStart);
  const nextHeaderIdx = after.search(/\n##\s+/);
  const section = nextHeaderIdx >= 0 ? after.slice(0, nextHeaderIdx) : after;

  const patterns = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^-\s+`([^`]+)`/);
    if (bullet) patterns.push(bullet[1].toLowerCase());
  }
  return patterns;
}

// ─── Calendar-week math (PT) ───────────────────────────────────────────────

/**
 * Returns the ISO 8601 instant (UTC) corresponding to "Monday 00:00 PT" of
 * the calendar week containing `now`. Used as the lower bound of item 3's
 * count window. SQLite comparisons should normalize via datetime() to handle
 * mixed `YYYY-MM-DD HH:MM:SS` and ISO formats consistently.
 */
function startOfCurrentCalendarWeekPT(now = new Date()) {
  // Extract PT date components.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const daysSinceMonday = dayMap[parts.weekday];
  if (daysSinceMonday === undefined) {
    throw new Error(`startOfCurrentCalendarWeekPT: unexpected weekday ${parts.weekday}`);
  }

  // Walk back to Monday's date in PT.
  const anchor = new Date(Date.UTC(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day)));
  anchor.setUTCDate(anchor.getUTCDate() - daysSinceMonday);
  const mondayY = anchor.getUTCFullYear();
  const mondayM = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const mondayD = String(anchor.getUTCDate()).padStart(2, '0');

  // Determine the PT offset for that Monday (PDT = -7, PST = -8). DST rules
  // shift the offset; ask Intl.
  const offsetFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  });
  const offsetParts = offsetFmt.formatToParts(new Date(`${mondayY}-${mondayM}-${mondayD}T12:00:00Z`));
  const tzPart = offsetParts.find((p) => p.type === 'timeZoneName').value; // "GMT-7" or "GMT-8"
  const offsetHours = parseInt(tzPart.replace('GMT', ''), 10);
  const offSign = offsetHours >= 0 ? '+' : '-';
  const offAbs = String(Math.abs(offsetHours)).padStart(2, '0');

  // Express "Monday 00:00 PT" as an ISO string with the offset, then convert
  // to UTC ISO via Date.toISOString().
  const ptIso = `${mondayY}-${mondayM}-${mondayD}T00:00:00${offSign}${offAbs}:00`;
  return new Date(ptIso).toISOString();
}

/**
 * How many calendar-week boundaries (Mondays at 00:00 PT) have crossed
 * between firstSendAt and now. Returns 0 if firstSendAt is null.
 */
function calendarWeeksSinceFirstSend(firstSendAt, now = new Date()) {
  if (!firstSendAt) return 0;
  const firstSendDate = new Date(firstSendAt);
  if (Number.isNaN(firstSendDate.getTime())) return 0;
  const firstWeekStart = startOfCurrentCalendarWeekPT(firstSendDate);
  const currentWeekStart = startOfCurrentCalendarWeekPT(now);
  const diffMs = new Date(currentWeekStart).getTime() - new Date(firstWeekStart).getTime();
  if (diffMs <= 0) return 0;
  return Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
}

function capForWeek(config, capIndex) {
  const caps = config.weekly_send_caps || {};
  const exact = caps[`week_${capIndex}`];
  if (typeof exact === 'number') return exact;

  // Support an arbitrary final ramp tier (for example week_5_plus) while
  // preserving the legacy week_4_plus configuration. Pick the highest
  // matching floor so adding a later tier never changes earlier weeks.
  const plusTiers = Object.entries(caps)
    .map(([key, value]) => {
      const match = key.match(/^week_(\d+)_plus$/);
      return match && typeof value === 'number'
        ? { week: Number(match[1]), value }
        : null;
    })
    .filter((tier) => tier && capIndex >= tier.week)
    .sort((a, b) => b.week - a.week);

  return plusTiers[0]?.value;
}

// ─── URL extraction (item 4) ───────────────────────────────────────────────

const URL_RE = new RegExp(`${UNSUB_URL_BASE.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\?token=([^\\s<>"')]+)`, 'g');

function extractUnsubscribeUrls(text) {
  if (!text) return [];
  const matches = [];
  let m;
  // Reset regex (it's global)
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    matches.push({ url: m[0], token: m[1] });
  }
  return matches;
}

// ─── HTML strip (cheap; gate substring checks tolerate it) ─────────────────

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

// ─── Main gate ─────────────────────────────────────────────────────────────

async function evaluateCompliance(db, config, input) {
  const {
    email,
    contactId,
    campaignId,
    campaignName,
    subject,
    body,
    headers,
    whyContactingPresent,
    requiresWhyContactingDisclosure = true,
    // whyContactingSource — unused at gate layer; surfaced in Slack draft-review post by composer
  } = input;

  const items = {};
  const failures = [];

  // ── Item 1: not in suppressions ─────────────────────────────────────
  const suppRows = await db.query(
    sql`SELECT id FROM suppressions WHERE email = ${String(email).toLowerCase().trim()}`
  );
  items[1] = suppRows.length === 0;
  if (!items[1]) failures.push('item_1_in_suppressions');

  // ── Item 2: contact.do_not_contact = 0 ──────────────────────────────
  const contactRows = await db.query(
    sql`SELECT do_not_contact FROM contacts WHERE id = ${contactId}`
  );
  if (contactRows.length === 0) {
    items[2] = false;
    failures.push('item_2_contact_not_found');
  } else {
    items[2] = contactRows[0].do_not_contact === 0 || contactRows[0].do_not_contact === false;
    if (!items[2]) failures.push('item_2_do_not_contact');
  }

  // ── Item 3: weekly send cap ─────────────────────────────────────────
  const campaignRows = await db.query(
    sql`SELECT first_send_at FROM outreach_campaigns WHERE id = ${campaignId}`
  );
  const firstSendAt = campaignRows.length > 0 ? campaignRows[0].first_send_at : null;
  const capIndex = calendarWeeksSinceFirstSend(firstSendAt) + 1;
  const cap = capForWeek(config, capIndex);
  const weekStart = startOfCurrentCalendarWeekPT();
  const countRows = await db.query(sql`
    SELECT COUNT(*) AS n FROM outreach_sends
    WHERE campaign_id = ${campaignId}
      AND sent_at IS NOT NULL
      AND datetime(sent_at) >= datetime(${weekStart})
  `);
  const sentThisWeek = countRows[0].n;
  if (typeof cap !== 'number') {
    items[3] = false;
    failures.push(`item_3_cap_undefined:capIndex=${capIndex}`);
  } else {
    items[3] = sentThisWeek < cap;
    if (!items[3]) {
      failures.push(`item_3_weekly_cap:count=${sentThisWeek}/cap=${cap}/week=${capIndex}`);
    }
  }

  // ── Item 4: token signs to contact (header AND body) ────────────────
  const headerStr = (headers && headers['List-Unsubscribe']) || '';
  const headerUrls = extractUnsubscribeUrls(headerStr);
  const bodyUrls = extractUnsubscribeUrls(body || '');

  let item4Pass = true;
  if (headerUrls.length === 0) {
    item4Pass = false;
    failures.push('item_4_no_token_in_header');
  }
  if (bodyUrls.length === 0) {
    item4Pass = false;
    failures.push('item_4_no_token_in_body');
  }
  for (const { token } of headerUrls) {
    const v = verifyUnsubscribeToken(token);
    if (!v.valid) {
      item4Pass = false;
      failures.push('item_4_token_invalid:header');
    } else if (v.contactId !== contactId) {
      item4Pass = false;
      failures.push(`item_4_token_mismatch:header:signs_to=${v.contactId}`);
    }
  }
  for (const { token } of bodyUrls) {
    const v = verifyUnsubscribeToken(token);
    if (!v.valid) {
      item4Pass = false;
      failures.push('item_4_token_invalid:body');
    } else if (v.contactId !== contactId) {
      item4Pass = false;
      failures.push(`item_4_token_mismatch:body:signs_to=${v.contactId}`);
    }
  }
  items[4] = item4Pass;

  // ── Item 5: postal address present ──────────────────────────────────
  const stripped = stripHtml(body);
  const physicalAddress = config.physical_address;
  if (!physicalAddress) {
    items[5] = false;
    failures.push('item_5_no_canonical_address_configured');
  } else {
    items[5] = stripped.includes(physicalAddress);
    if (!items[5]) failures.push('item_5_postal_address_missing');
  }

  // ── Item 6: why-contacting (pattern check + manual flag) ────────────
  if (!requiresWhyContactingDisclosure) {
    items[6] = true;
  } else if (whyContactingPresent === false) {
    items[6] = false;
    failures.push('item_6_no_disclosure_pattern');
  } else {
    const patterns = loadDisclosurePatterns();
    const haystack = stripped.toLowerCase();
    const matched = patterns.some((p) => haystack.includes(p));
    if (matched) {
      items[6] = 'manual'; // pattern present; defer semantic correctness to human review
    } else {
      items[6] = false;
      failures.push('item_6_no_disclosure_pattern');
    }
  }

  // ── Item 7: banned phrases ──────────────────────────────────────────
  const phrases = loadBannedPhrases();
  const text = `${subject || ''} ${stripped}`;
  const hit = findBannedPhrase(text, phrases);
  items[7] = hit === null;
  if (!items[7]) failures.push(`item_7_banned_phrase:${hit.phrase}`);

  // ── Aggregate ───────────────────────────────────────────────────────
  // pass = every item is true OR 'manual' (item 6 only).
  const pass = Object.values(items).every((v) => v === true || v === 'manual');

  // pauseCampaign = any of items 1-5 or item 6 (pattern-fail) failed.
  // Item 7 fails alone do NOT pause (content-quality only).
  const itemsThatPause = [1, 2, 3, 4, 5, 6];
  const pauseCampaign = itemsThatPause.some((i) => items[i] === false);

  return { pass, failures, items, pauseCampaign };
}

// ─── Failure recording (side-effecting) ────────────────────────────────────

const STATE_PATH = path.join(__dirname, '..', 'state.json');
let _slackPostFn = null;
let _channelIdResolver = null;

/**
 * Allow tests to inject a Slack stub. Production resolves these lazily from
 * the modules they live in.
 */
function _setSlackForTesting(slackPostToChannel, channelIdResolver) {
  _slackPostFn = slackPostToChannel;
  _channelIdResolver = channelIdResolver;
}

function _getSlackPost() {
  if (_slackPostFn) return _slackPostFn;
  // eslint-disable-next-line global-require
  return require('../research/scripts/lib/slack').postToChannel;
}

function _getChannelId() {
  if (_channelIdResolver) return _channelIdResolver();
  // eslint-disable-next-line global-require
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  return cfg.channel_id || null;
}

function _writePauseState(reason) {
  let state = { paused: false };
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    // tolerate missing — fresh state.json
  }
  state.paused = true;
  state.paused_by = 'compliance_gate';
  state.paused_at = new Date().toISOString();
  state.pause_reason = reason;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function recordComplianceFailure(db, config, ctx, evaluation) {
  const { contactId, outreachSendId, contactEmail, campaignName } = ctx;
  // source defaults to 'send_time' (Step 3.3 enum, spec §6). Callers that need
  // a different value pass ctx.source explicitly:
  //   - orchestrator.js's edit-override carve-out path → 'send_time_override'
  //   - the (future) composer-time hard-fail path     → 'compose'
  // The CRM /api/drafts/:id/edit handler writes 'edit_override' via a direct
  // INSERT (doesn't route through this function).
  const source = ctx.source || 'send_time';

  // One row per failed check.
  for (const failure of evaluation.failures) {
    // failure looks like 'item_3_weekly_cap:count=5/cap=5/week=1'
    const colonIdx = failure.indexOf(':');
    const failedCheck = colonIdx >= 0 ? failure.slice(0, colonIdx) : failure;
    const details = colonIdx >= 0 ? failure.slice(colonIdx + 1) : null;
    await db.query(sql`
      INSERT INTO compliance_failures (contact_id, outreach_send_id, failed_check, details, source)
      VALUES (${contactId}, ${outreachSendId || null}, ${failedCheck}, ${details}, ${source})
    `);
  }

  // Slack ping summary.
  const channelId = _getChannelId();
  if (channelId) {
    const lines = [
      `🛑 Compliance gate FAIL — ${contactEmail || `contact #${contactId}`} on \`${campaignName || 'unknown'}\``,
      `Failures: ${evaluation.failures.join(', ')}`,
      evaluation.pauseCampaign ? `Campaign auto-paused. Use \`!resume\` to clear.` : `(item 7 only — campaign NOT paused.)`,
    ];
    const post = _getSlackPost();
    try {
      await post('channel:' + channelId, lines.join('\n'));
    } catch (e) {
      console.warn('[compliance] slack post failed:', e.message);
    }
  }

  // Auto-pause if any of items 1-6-pattern failed.
  if (evaluation.pauseCampaign) {
    _writePauseState(evaluation.failures.join(', '));
  }
}

module.exports = {
  evaluateCompliance,
  recordComplianceFailure,
  // Exported for tests:
  loadDisclosurePatterns,
  startOfCurrentCalendarWeekPT,
  calendarWeeksSinceFirstSend,
  capForWeek,
  extractUnsubscribeUrls,
  _setSlackForTesting,
};
