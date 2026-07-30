'use strict';

const CRM_BASE_URL = process.env.CRM_BASE_URL || 'http://localhost:3456';
const BULK_IMPORT_PATH = '/api/contacts/bulk-import';

const VALID_CONTEXT_SOURCES = new Set([
  'website_contact_page', 'business_directory', 'linkedin_business',
  'manual_jason_pv_list', 'referral',
]);

function looksLikeContactOrAboutURL(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    return /\b(contact|about|team|staff|our-team|meet|company)\b/.test(p);
  } catch {
    return false;
  }
}

function splitName(full) {
  if (!full) return { first_name: null, last_name: null };
  const cleaned = String(full).replace(/\s+/g, ' ').trim();
  if (!cleaned) return { first_name: null, last_name: null };
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function joinGeography(loc) {
  if (!loc) return null;
  const parts = [loc.city, loc.state_or_region, loc.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function buildContactRow(candidate, runDate) {
  const persona = candidate.persona;
  const sourceQuery = `${runDate}_${persona}`;
  const ext = candidate.extracted || {};
  const ctxIsContactPage = looksLikeContactOrAboutURL(candidate.url);
  const context_source = ctxIsContactPage ? 'website_contact_page' : 'business_directory';
  if (!VALID_CONTEXT_SOURCES.has(context_source)) {
    throw new Error(`Internal: invalid context_source ${context_source}`);
  }

  const company = ext.company_name || null;
  const email = candidate.email || null;
  const namedRef = candidate.named_contact || null;
  const isRoleBased = !namedRef;

  let name;
  if (namedRef && namedRef.name) {
    name = namedRef.name;
  } else if (company) {
    name = `${company} (role-based)`;
  } else if (email) {
    name = `${email} (role-based)`;
  } else {
    name = '(unknown)';
  }

  const { first_name, last_name } = isRoleBased
    ? { first_name: null, last_name: null }
    : splitName(namedRef.name);

  const evidenceQuotes = (candidate.evidence && Array.isArray(candidate.evidence.emails))
    ? candidate.evidence.emails.filter(q => q && q.toLowerCase().includes((email || '').toLowerCase()))
    : [];
  const personaFitEvidence = candidate.evidence && candidate.evidence.persona_fit ? candidate.evidence.persona_fit : null;

  const noteParts = [];
  if (evidenceQuotes.length > 0) noteParts.push(`Evidence: "${evidenceQuotes[0]}"`);
  else if (candidate.evidence && Array.isArray(candidate.evidence.emails) && candidate.evidence.emails[0]) {
    noteParts.push(`Email evidence: "${candidate.evidence.emails[0]}"`);
  }
  if (personaFitEvidence) noteParts.push(`Fit: "${personaFitEvidence}"`);
  noteParts.push(`Source URL: ${candidate.url}`);
  noteParts.push(`Quality: ${candidate.quality_score || '?'}/5; persona_fit=${candidate.persona_fit || 'unknown'}`);
  if (candidate.personal_email) noteParts.push(`(personal-email-domain)`);

  const row = {
    name,
    email: email ? email.toLowerCase().trim() : null,
    first_name,
    last_name,
    company,
    title: namedRef && namedRef.role ? namedRef.role : null,
    website: candidate.url || null,
    geography: joinGeography(ext.location),
    specialties: Array.isArray(ext.services_offered) && ext.services_offered.length
      ? ext.services_offered.slice(0, 5).join(', ')
      : null,
    notes: noteParts.join(' | '),
    source: 'brave_search',
    source_query: sourceQuery,
    context_source,
    email_status: 'unknown',
    status: 'new',
  };
  return row;
}

async function postBulkImport(rows) {
  const url = CRM_BASE_URL + BULK_IMPORT_PATH;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rows),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      response: body,
      inserted: 0,
      skipped_duplicates: 0,
      errors: [{ index: -1, error: `bulk-import HTTP ${res.status}: ${text.slice(0, 300)}` }],
    };
  }
  return {
    ok: true,
    status: res.status,
    response: body,
    inserted: body.inserted || 0,
    skipped_duplicates: body.skipped_duplicates || 0,
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}

module.exports = { buildContactRow, postBulkImport, splitName, joinGeography, looksLikeContactOrAboutURL };
