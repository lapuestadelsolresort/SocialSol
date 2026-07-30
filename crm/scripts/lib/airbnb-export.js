'use strict';
//
// Pure helpers for the Airbnb export ingestion (Phase R, R1).
// Kept side-effect-free so the test suite can exercise every branch
// without touching the DB or the filesystem.
//
// Public API:
//   parseGuestDataMap(mdText) -> { contactsTotal, contactsWithEmail, ... }
//   validateCountsAgainstMap({ map, exportData, tolerance }) -> diff[] or throws
//   resolveHostAccountId(messageThreads, { override }) -> bigint
//   buildContactRow(directoryEntry, contactsByAccountId, mostRecentThreadByAccountId)
//   mapRelationshipType(directoryEntry) -> 'past_guest_stayed' | ...
//   detectLanguage(body) -> 'en' | 'es'
//   extractMessageBody(messageEnvelope) -> { body, contentType }
//   buildVoiceCorpusRow({ thread, message, hostAccountId, contactIdByThreadId })

const SPANISH_TOKENS = [
  // Common closed-class Spanish words; chosen for high precision against
  // English/Spanish mixed boilerplate. Heuristic only — sufficient for v1.
  'hola', 'gracias', 'saludos', 'buenos días', 'buenas tardes', 'buenas noches',
  'por favor', 'fecha', 'fechas', 'noches', 'huéspedes', 'reserva', 'reservación',
  'mañana', 'sábado', 'domingo', 'puedo', 'puede', 'estamos', 'tengo', 'somos',
  'cuántos', 'cuánto', 'cuál', 'qué', 'también', 'más', 'cómo está', 'pueden',
  'necesito', 'mensaje', 'cuarto', 'habitación', 'familia', 'lo siento'
];

const RELATIONSHIP_TYPES = {
  PAST_GUEST_STAYED: 'past_guest_stayed',
  PAST_GUEST_CANCELLED: 'past_guest_cancelled',
  PAST_GUEST_INQUIRED: 'past_guest_inquired'
};

const PROVENANCE = {
  VOLUNTARY_SHARE_MESSAGE: 'voluntary_share_message',
  AIRBNB_THREAD_ONLY: 'airbnb_thread_only',
  MANUAL_ENTRY: 'manual_entry',
  PLANNER_RESEARCH: 'planner_research'
};

// ── Dedup guest_contacts.json by accountId ──────────────────────────────
// guest_contacts.json contains row-per-shared-contact-info, not row-per-guest.
// When one Airbnb account holds messages where multiple peoples' phone/email
// were shared, the raw file has multiple rows with the same accountId.
//
// Without dedup, the contact UPSERT does last-write-wins on email/phone,
// silently mixing identities (e.g. the account holder ends up with another
// person's phone). This routes WhatsApp/email to the wrong person under the
// authority of someone else's Airbnb identity — a real privacy/compliance bug.
//
// Canonical-row selection: directory firstName must match a token in the
// row's `name` field (case-insensitive). The first matching row wins. If no
// row matches the directory firstName (or the directory has no firstName for
// that accountId), the first row in source order wins and the collision is
// logged with reason='no-name-match-fallback' so a human can audit.
//
// Returns { deduped, collisions }. `collisions` lists every accountId that
// had more than one row, with which row was kept and which were dropped.
function dedupGuestContacts(rawContacts, directory) {
  const directoryByAccountId = new Map(
    (directory || []).map(d => [d.accountId, d])
  );

  const groups = new Map();
  for (const row of rawContacts) {
    const arr = groups.get(row.accountId) || [];
    arr.push(row);
    groups.set(row.accountId, arr);
  }

  const deduped = [];
  const collisions = [];
  for (const [accountId, rows] of groups) {
    if (rows.length === 1) {
      deduped.push(rows[0]);
      continue;
    }
    const dirEntry = directoryByAccountId.get(accountId);
    const dirFirst = (dirEntry && dirEntry.firstName) ? dirEntry.firstName.toLowerCase() : null;
    let kept = null;
    let reason = null;
    if (dirFirst) {
      // Pick the first row whose `name` contains the directory firstName as a
      // word-ish token. Use \b (word boundary) instead of plain includes so
      // "Alex" in "Alex Example" matches but "Alex" in "Alexa" wouldn't.
      const re = new RegExp(`\\b${escapeRegExp(dirFirst)}\\b`, 'i');
      kept = rows.find(r => r.name && re.test(r.name)) || null;
      if (kept) reason = `directory-firstName-match: ${dirEntry.firstName}`;
    }
    if (!kept) {
      kept = rows[0];
      reason = dirFirst
        ? `no-name-match-fallback (directory firstName="${dirEntry.firstName}", no row matched)`
        : 'no-directory-firstName-fallback';
    }
    deduped.push(kept);
    collisions.push({
      accountId,
      directoryFirstName: dirEntry ? dirEntry.firstName : null,
      kept: { name: kept.name, email: kept.email || null, phone: kept.phone || null },
      dropped: rows.filter(r => r !== kept).map(r => ({
        name: r.name, email: r.email || null, phone: r.phone || null
      })),
      reason
    });
  }
  return { deduped, collisions };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── GUEST_DATA_MAP.md parser ────────────────────────────────────────────
// The map is human-authored markdown but the executive-summary table is
// stable enough to parse with a few targeted regexes. We only extract the
// counts the ingestion script will validate against.
function parseGuestDataMap(mdText) {
  const claim = (label, fallback) => {
    // Match "| Total unique guests | 218 |" — pipe-bounded table rows.
    const re = new RegExp(
      `\\|\\s*${label}\\s*\\|\\s*(\\d+)`,
      'i'
    );
    const m = mdText.match(re);
    if (!m) return fallback;
    return parseInt(m[1], 10);
  };

  return {
    contactsTotal: claim('Total unique guests', null),
    contactsWithEmail: claim('Guests with email addresses', null),
    contactsWithPhone: claim('Guests with phone numbers', null),
    contactsWithBoth: claim('Guests with both email \\+ phone', null),
    stays: claim('Guests who completed a stay', null),
    cancelled: claim('Guests who cancelled', null),
    inquiryOnly: claim('Guests who only inquired \\(never booked\\)', null),
    threadOnly: claim('Guests from message threads only', null),
    reviewsLeft: claim('Guests who left a review', null),
    repeatGuests: claim('Repeat guests \\(2\\+ bookings\\)', null)
  };
}

// ── Count validation ────────────────────────────────────────────────────
// `exportData`: { directory, contacts, threadCount, messageCount }
// `tolerance`: 0..1 fraction (e.g. 0.05 = 5%)
// Returns array of mismatches; throws if any mismatch exceeds tolerance.
function validateCountsAgainstMap({ map, exportData, tolerance = 0.05 }) {
  // The map's "33" is row count in guest_contacts.json (some Airbnb accounts
  // have multiple shared contacts — e.g. one thread where 3 different
  // peoples' phones were shared). After dedup-by-accountId, the count of
  // *distinct* guests reachable via direct contact is smaller. Both checks
  // matter: row drift would mean the export was re-pulled with different
  // extraction logic; distinct drift would mean different dedup behavior.
  const distinctAccountIds = new Set(exportData.contacts.map(c => c.accountId)).size;
  const checks = [
    ['contactsTotal',           map.contactsTotal,           exportData.directory.length],
    ['contactsRowsRaw',         map.contactsRowsRaw,         exportData.contacts.length],
    ['contactsDistinctAccounts',map.contactsDistinctAccounts,distinctAccountIds],
    ['contactsWithEmail',       map.contactsWithEmail,       exportData.contacts.filter(c => c.email).length],
    ['contactsWithPhone',       map.contactsWithPhone,       exportData.contacts.filter(c => c.phone).length],
    ['contactsWithBoth',        map.contactsWithBoth,        exportData.contacts.filter(c => c.email && c.phone).length],
    ['threadCount',             map.threadCount,             exportData.threadCount],
    ['messageCount',            map.messageCount,            exportData.messageCount]
  ];

  const fails = [];
  const all = [];
  for (const [name, claimed, actual] of checks) {
    if (claimed == null) continue;
    const diff = Math.abs(actual - claimed);
    const pct = claimed === 0 ? (actual === 0 ? 0 : 1) : diff / claimed;
    const row = { name, claimed, actual, diff, pct };
    all.push(row);
    if (pct > tolerance) fails.push(row);
  }

  if (fails.length) {
    const lines = fails.map(r =>
      `  ${r.name}: map=${r.claimed}  actual=${r.actual}  divergence=${(r.pct * 100).toFixed(1)}% > tolerance=${(tolerance * 100).toFixed(1)}%`
    );
    const err = new Error(
      'GUEST_DATA_MAP.md disagrees with export contents:\n' + lines.join('\n') +
      '\nRe-pull or regenerate the map before re-running.'
    );
    err.fails = fails;
    err.all = all;
    throw err;
  }

  return all;
}

// ── Host accountId resolver ─────────────────────────────────────────────
// Picks Sarah's accountId as the most prolific message sender across all
// threads. Earlier intuition was "the account in every thread," but Airbnb
// auto-adds the listing-owner to every thread regardless of who actually
// replies — that was producing the silent-co-host id, not Sarah.
//
// Returns { hostAccountId, candidates } where `candidates` is the top-5
// senders for caller-side logging, so the user can sanity-check.
// Pass `override` to skip resolution entirely.
function resolveHostAccountId(messageThreads, { override = null } = {}) {
  if (!Array.isArray(messageThreads) || messageThreads.length === 0) {
    throw new Error('resolveHostAccountId: no threads provided');
  }

  // Tally messages-sent by accountId, ignoring service messages and null senders.
  const senderCounts = new Map();
  const threadParticipation = new Map();
  for (const thread of messageThreads) {
    const seenInThread = new Set();
    for (const env of (thread.messagesAndContents || [])) {
      const m = env && env.message;
      if (!m) continue;
      if (m.accountType === 'service') continue;
      if (m.accountId == null) continue;
      senderCounts.set(m.accountId, (senderCounts.get(m.accountId) || 0) + 1);
      seenInThread.add(m.accountId);
    }
    for (const acc of seenInThread) {
      threadParticipation.set(acc, (threadParticipation.get(acc) || 0) + 1);
    }
  }

  if (override != null) {
    // Caller-supplied override — return as-is, with candidates context for logs.
    return { hostAccountId: override, candidates: topSenders(senderCounts, threadParticipation) };
  }

  if (senderCounts.size === 0) {
    throw new Error('resolveHostAccountId: no non-service messages found in any thread');
  }

  // Sarah = most prolific sender.
  const ranked = [...senderCounts.entries()].sort((a, b) => b[1] - a[1]);
  const hostAccountId = ranked[0][0];
  return { hostAccountId, candidates: topSenders(senderCounts, threadParticipation) };
}

function topSenders(senderCounts, threadParticipation, n = 5) {
  return [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([accountId, msgs]) => ({
      accountId,
      messages: msgs,
      threadsAsParticipant: threadParticipation.get(accountId) || 0
    }));
}

function toAccountId(p) {
  // Participant entries may be {accountId: 123} or 123 directly.
  if (p && typeof p === 'object') return p.accountId ?? p.id ?? null;
  return p;
}

// ── Relationship type ───────────────────────────────────────────────────
function mapRelationshipType(directoryEntry) {
  const status = (directoryEntry.reservationStatus || '').toLowerCase();
  if (status === 'accepted') return RELATIONSHIP_TYPES.PAST_GUEST_STAYED;
  if (status === 'cancelled' || status === 'timedout') return RELATIONSHIP_TYPES.PAST_GUEST_CANCELLED;
  // 'inquiry', 'unknown' (thread-only with reservationCount=0), or anything else
  // → bucket into past_guest_inquired. They expressed interest but never stayed.
  return RELATIONSHIP_TYPES.PAST_GUEST_INQUIRED;
}

// ── Contact row builder ─────────────────────────────────────────────────
// Single source of truth for contact_provenance: default airbnb_thread_only,
// upgrade to voluntary_share_message if accountId is present in guest_contacts.
// Idempotent — same input → same output, no time-dependent fields here.
function buildContactRow(directoryEntry, contactsByAccountId, mostRecentThreadByAccountId = new Map()) {
  if (!directoryEntry || directoryEntry.accountId == null) {
    throw new Error('buildContactRow: directoryEntry missing accountId');
  }

  const accountId = directoryEntry.accountId;
  const contactRow = contactsByAccountId.get(accountId) || null;

  // Provenance + email/phone: provenance default is airbnb_thread_only.
  // Upgrade *only* if guest_contacts.json actually has us a record (real email/phone).
  // The hasEmail/hasPhone flags on the directory are not sufficient — there are 8
  // accountIds where the directory marks hasPhone=true but guest_contacts.json
  // lacks an actual record (the data was incompletely compiled).
  let provenance = PROVENANCE.AIRBNB_THREAD_ONLY;
  let email = null;
  let phone = null;
  if (contactRow) {
    provenance = PROVENANCE.VOLUNTARY_SHARE_MESSAGE;
    email = contactRow.email || null;
    phone = contactRow.phone || null;
  }

  const firstName = directoryEntry.firstName || null;
  const name = firstName || `Airbnb guest ${accountId}`;

  // dedup_key fallback: if no email, use airbnb-account-prefixed key so it's
  // deterministic and unique per Airbnb identity (separate namespace from
  // Paulina's planner contacts which key on email or name|company|website).
  const dedupKey = email
    ? email.toLowerCase().trim()
    : `airbnb:${accountId}`;

  const threadId = mostRecentThreadByAccountId.get(accountId) || null;
  const reviewRating = directoryEntry.reviewRating || null;
  const lastStayDate = pickLastStayDate(directoryEntry);
  const tripPurpose = directoryEntry.context || null;

  return {
    name,
    first_name: firstName,
    email,
    phone,
    dedup_key: dedupKey,
    relationship_type: mapRelationshipType(directoryEntry),
    contact_provenance: provenance,
    airbnb_account_id: accountId,
    airbnb_thread_id: threadId,
    trip_purpose: tripPurpose,
    last_stay_date: lastStayDate,
    review_rating: reviewRating,
    preferred_channel: null, // Sarah sets later via Slack
    // context_source is required by Paulina's contacts schema (NOT NULL).
    // For Airbnb-derived contacts, the originating context is the platform thread.
    context_source: 'airbnb_message_thread',
    source: 'airbnb_export_2026_05'
  };
}

function pickLastStayDate(directoryEntry) {
  const status = (directoryEntry.reservationStatus || '').toLowerCase();
  if (status !== 'accepted') return null;
  const dates = directoryEntry.reservationDates || [];
  if (!Array.isArray(dates) || dates.length === 0) return null;
  // Take most recent ISO-8601 date string.
  return [...dates].sort().slice(-1)[0];
}

// ── Language heuristic ──────────────────────────────────────────────────
function detectLanguage(body) {
  if (!body || typeof body !== 'string') return 'en';
  const lower = body.toLowerCase();
  let hits = 0;
  for (const tok of SPANISH_TOKENS) {
    if (lower.includes(tok)) {
      hits += 1;
      if (hits >= 2) return 'es'; // require at least 2 distinct hits to call Spanish
    }
  }
  return 'en';
}

// ── Message body extraction ─────────────────────────────────────────────
// Airbnb's text wrapper inconsistently uses `body` (textContent — the common
// case) and `text` (textAndReferenceContent — for messages that reference a
// booking/listing). Accept either. Reference-only messages with no body text
// return ''.
function extractMessageBody(envelope) {
  if (!envelope || !envelope.messageContent) return { body: '', contentType: null };
  const c = envelope.messageContent;
  if (c.textContent) {
    const t = c.textContent.body || c.textContent.text;
    if (typeof t === 'string') return { body: t, contentType: 'TextContent' };
  }
  if (c.textAndReferenceContent) {
    const t = c.textAndReferenceContent.body || c.textAndReferenceContent.text;
    if (typeof t === 'string') return { body: t, contentType: 'TextAndReferenceContent' };
  }
  return { body: '', contentType: 'Unknown' };
}

// ── Voice corpus row builder ────────────────────────────────────────────
// `thread` is a single messageThreads[] entry; `envelope` is one wrapped message.
// `hostAccountIds` is a Set — multiple Sarah-voice accounts may be allowed
// (e.g., 121885415 = primary, 510010203 = older account with same register).
// Returns the row, or null if the message should be skipped.
//
// `source_account_id` is preserved on the row so future audits can ask
// "are drafts modeled on alt-Sarah's messages getting edited more heavily?"
// — a question you can't reconstruct from the source string alone.
function buildVoiceCorpusRow({ thread, envelope, hostAccountIds, contactIdByThreadId }) {
  const m = envelope && envelope.message;
  if (!m) return null;
  if (!hostAccountIds.has(m.accountId)) return null; // inbound or non-host
  const { body, contentType } = extractMessageBody(envelope);
  if (!body || !body.trim()) return null;

  const language = detectLanguage(body);
  const wordCount = body.trim().split(/\s+/).length;
  const contactId = contactIdByThreadId.get(thread.id) || null;

  return {
    source: 'airbnb_messages',
    source_id: String(thread.id),
    message_id: String(m.id),
    source_account_id: m.accountId,
    contact_id: contactId,
    direction: 'outbound',
    sent_at: m.createdAt,
    body,
    intent_tags: null, // R3+ tagging step
    recipient_relationship: null,
    language,
    word_count: wordCount,
    embedding_status: 'pending',
    contentType // not persisted; useful for logging
  };
}

// ── Build thread → contact_id map ───────────────────────────────────────
// For each thread, pick the non-host participant's accountId and look up
// contacts.id WHERE airbnb_account_id = that. Threads with no matching contact
// map to null and are returned in the `unmatched` list.
function buildContactIdByThreadId(messageThreads, hostAccountIds, contactIdByAirbnbAccountId) {
  // Accept either a single accountId (back-compat) or an iterable of host ids.
  const hostSet = (hostAccountIds instanceof Set)
    ? hostAccountIds
    : new Set(Array.isArray(hostAccountIds) ? hostAccountIds : [hostAccountIds]);
  const out = new Map();
  const unmatched = [];
  for (const thread of messageThreads) {
    const participants = (thread.messageThreadParticipants || []).map(toAccountId);
    const others = participants.filter(p => !hostSet.has(p));
    // For 1:1 threads (the common case) `others` has length 1.
    // For group threads, take the first matching contact we find — voice corpus
    // attribution to a single guest is best-effort for those.
    let resolved = null;
    for (const otherId of others) {
      const cid = contactIdByAirbnbAccountId.get(otherId);
      if (cid != null) { resolved = cid; break; }
    }
    if (resolved != null) {
      out.set(thread.id, resolved);
    } else {
      unmatched.push({ threadId: thread.id, participants: others });
    }
  }
  return { contactIdByThreadId: out, unmatched };
}

module.exports = {
  // constants
  RELATIONSHIP_TYPES,
  PROVENANCE,
  // parsers
  parseGuestDataMap,
  validateCountsAgainstMap,
  // dedup
  dedupGuestContacts,
  // resolvers
  resolveHostAccountId,
  buildContactIdByThreadId,
  // row builders
  mapRelationshipType,
  buildContactRow,
  buildVoiceCorpusRow,
  // text helpers
  detectLanguage,
  extractMessageBody
};
