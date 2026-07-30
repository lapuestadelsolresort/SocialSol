'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { require_env } = require('./env');

// Sonnet 4.6 pricing (USD per million tokens)
const SONNET_46_INPUT_PER_MTOK = 3.00;
const SONNET_46_OUTPUT_PER_MTOK = 15.00;
// Haiku 4.5 pricing — used if config flips to Haiku
const HAIKU_45_INPUT_PER_MTOK = 1.00;
const HAIKU_45_OUTPUT_PER_MTOK = 5.00;
// Opus 4.7 pricing — used if config flips to Opus
const OPUS_47_INPUT_PER_MTOK = 15.00;
const OPUS_47_OUTPUT_PER_MTOK = 75.00;

function ratesFor(model) {
  if (!model) return { input: SONNET_46_INPUT_PER_MTOK, output: SONNET_46_OUTPUT_PER_MTOK };
  const m = model.toLowerCase();
  if (m.includes('haiku')) return { input: HAIKU_45_INPUT_PER_MTOK, output: HAIKU_45_OUTPUT_PER_MTOK };
  if (m.includes('opus')) return { input: OPUS_47_INPUT_PER_MTOK, output: OPUS_47_OUTPUT_PER_MTOK };
  return { input: SONNET_46_INPUT_PER_MTOK, output: SONNET_46_OUTPUT_PER_MTOK };
}

const PROMPT_VERSION = 'v2.1';

const PROMPT_TEMPLATE = `You are a research assistant extracting business contact information from a web
page for La Puesta del Sol, a 12-bedroom boutique beachfront resort in Riviera
Nayarit, Mexico. The resort hosts full-property buyouts: weddings (groups
~50–100), corporate/leadership retreats (groups ~20–60), and multi-generational
private bookings. Typical direct buyout revenue is $25K+ for a multi-night event.

The persona we are researching: {{PERSONA_LABEL}}

A good lead for La Puesta is a real working planner/advisor who:
  (a) actually books destination events outside their home country, AND
  (b) handles groups of roughly 20–100 guests, AND
  (c) works with clients whose budgets support a $25K+ multi-night buyout, AND
  (d) ideally has prior Mexico / Latin America / beachfront destination work.

A bad lead is a directory listing, a blog post about destination weddings, a
photographer or florist, a planner who only books local backyard events, or a
generic "wedding" page with no real person or organization behind it.

EXTRACTION RULES (strict):

1. Extract ONLY information that appears verbatim in the page text. Do not
   infer, guess, or fabricate. If a field is not present in the text, return
   null. For every non-null field, include the exact verbatim quote in
   \`evidence\`. If you cannot quote it, you did not find it — return null.

2. If the page text includes a \`[discovered_contacts]\` section, those emails
   and phones are authoritative (extracted from mailto:/tel: links and HTML
   patterns). The verbatim evidence for these can be
   \`[discovered_contacts] block: <email>\` instead of a body quote.

3. Distinguish named contacts (real person, e.g. "Sarah Chen, Lead Planner")
   from role-based emails (e.g. info@, hello@). A discovered_contacts email
   goes into named_contacts only if you can pair it with a name from the body
   text; otherwise it goes into role_based_emails.

4. First decide \`page_type\`. This gates everything else:
     - real_planner       — an actual planning business with named staff, services, portfolio
     - directory_listing  — theknot, weddingwire, bridebook, wedding.com profile pages, etc.
     - blog_post          — editorial content about destination weddings
     - venue_site         — a resort, hotel, or villa marketing itself
     - vendor_other       — photographer, florist, DJ, officiant, planner-adjacent
     - unclear            — insufficient signal
   If page_type is anything other than \`real_planner\`, set persona_fit="none"
   and quality_score=1 regardless of other signals. Directory listings and
   blog posts are not leads.

5. Then capture buyer-fit signals. Each is a separate field, with evidence:
     - destination_work_evidence:   quotes showing they book events outside
                                    their home country. null if not present.
     - mexico_or_latam_evidence:    quotes specifically referencing Mexico,
                                    Latin America, or Caribbean destinations.
                                    null if not present.
     - group_size_signal:           quote(s) suggesting typical group size
                                    (e.g. "intimate weddings of 30–80"). null
                                    if not stated.
     - budget_signal:               quote(s) suggesting price point or budget
                                    bracket. null if not stated.
     - portfolio_recency_signal:    quote(s) showing recent activity (dated
                                    posts, "now booking 2027", recent
                                    Instagram references). null if not stated.

6. \`persona_fit\` is your judgment, anchored on the four criteria above:
     - strong   = page_type=real_planner AND destination_work_evidence present
                  AND (mexico_or_latam_evidence present OR group_size_signal
                  matches 20–100 OR budget_signal suggests $20K+ events)
     - moderate = page_type=real_planner AND destination_work_evidence present
                  but no Mexico/group/budget anchor
     - weak     = page_type=real_planner but no destination_work_evidence
     - none     = page_type ≠ real_planner, or no usable contact info

7. \`quality_score\` (1–5) reflects usable-lead-ness. A reachable role-based
   inbox at a real business is a valid contact path — many established
   planners route inbounds through info@ or hello@ addresses. Do not penalize
   role-based emails when the business is clearly real (phone number, physical
   address, named team referenced elsewhere on the site, professional
   portfolio):
     5 = strong fit + named contact + direct (non-role-based) email
     4 = strong fit + EITHER (named contact with any email)
                      OR (working role-based email at a clearly real business
                          with phone or physical address evidence)
     3 = moderate fit with any usable contact path,
         OR strong fit with only a contact form / no inbox
     2 = weak fit
     1 = page_type ≠ real_planner, OR no usable contact information,
         OR persona_fit=none
   A real_planner with weak fit caps at 2. A directory listing, blog post,
   venue site, or vendor_other caps at 1 even if it lists a phone number.

8. If page_type ≠ real_planner OR persona_fit=none, populate
   \`rejection_reason\` with one of:
     directory_listing | blog_only | wrong_vendor_type | local_only |
     no_destination_evidence | no_contact_info | duplicate_brand | other
   plus a brief free-text \`notes\` explaining.

Return ONLY a JSON object matching this schema. No prose, no markdown fences.

{
  "page_type": "real_planner" | "directory_listing" | "blog_post" | "venue_site" | "vendor_other" | "unclear",
  "company_name": string | null,
  "named_contacts": [
    {"name": string, "role": string | null, "email": string | null, "phone": string | null}
  ],
  "role_based_emails": [string],
  "general_phone": string | null,
  "location": {"city": string | null, "state_or_region": string | null, "country": string | null},
  "services_offered": [string],
  "destinations_served": [string],
  "destination_work_evidence":  string | null,
  "mexico_or_latam_evidence":   string | null,
  "group_size_signal":          string | null,
  "budget_signal":              string | null,
  "portfolio_recency_signal":   string | null,
  "persona_fit": "strong" | "moderate" | "weak" | "none",
  "quality_score": 1 | 2 | 3 | 4 | 5,
  "rejection_reason": string | null,
  "evidence": {
    "company_name": string | null,
    "named_contacts": [string],
    "emails": [string],
    "persona_fit": string | null,
    "page_type": string | null
  },
  "notes": string | null
}

Page URL: {{URL}}
Page title: {{TITLE}}

Page text:
---
{{TEXT}}
---`;

function buildPrompt({ personaLabel, url, title, text }) {
  return PROMPT_TEMPLATE
    .replace('{{PERSONA_LABEL}}', personaLabel)
    .replace('{{URL}}', url)
    .replace('{{TITLE}}', title || '')
    .replace('{{TEXT}}', text || '');
}

function tryParseJSON(s) {
  if (!s) return null;
  // Tolerate accidental markdown fences
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  // Find the first { ... last } substring
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) return null;
  try {
    return JSON.parse(t.slice(i, j + 1));
  } catch {
    return null;
  }
}

class CostCapExceeded extends Error {
  constructor(running, cap) {
    super(`Cost cap exceeded: $${running.toFixed(4)} ≥ $${cap.toFixed(2)}`);
    this.running = running;
    this.cap = cap;
  }
}

class Extractor {
  constructor({ model, costCapUsd }) {
    this.model = model;
    this.costCapUsd = costCapUsd;
    this.runningCostUsd = 0;
    this.callCount = 0;
    this.rates = ratesFor(model);
    const apiKey = require_env('ANTHROPIC_API_KEY');
    this.client = new Anthropic({ apiKey });
  }

  cost() { return this.runningCostUsd; }
  calls() { return this.callCount; }

  _accountFor(usage) {
    const inTok = (usage && usage.input_tokens) || 0;
    const outTok = (usage && usage.output_tokens) || 0;
    const cost = (inTok / 1_000_000) * this.rates.input + (outTok / 1_000_000) * this.rates.output;
    this.runningCostUsd += cost;
    return cost;
  }

  async extract({ personaLabel, url, title, text }) {
    if (this.runningCostUsd >= this.costCapUsd) {
      throw new CostCapExceeded(this.runningCostUsd, this.costCapUsd);
    }
    const prompt = buildPrompt({ personaLabel, url, title, text });
    let resp;
    try {
      resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (e) {
      this.callCount++;
      return {
        extract_status: 'api_error',
        error: String(e.message || e),
        cost_usd: 0,
        model: this.model,
        extracted_at: new Date().toISOString(),
      };
    }
    this.callCount++;
    const callCost = this._accountFor(resp.usage);
    const textBlock = (resp.content || []).find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text : '';
    const parsed = tryParseJSON(raw);
    if (!parsed) {
      return {
        extract_status: 'parse_error',
        raw,
        cost_usd: Number(callCost.toFixed(6)),
        model: this.model,
        extracted_at: new Date().toISOString(),
      };
    }
    return {
      extract_status: 'ok',
      extracted: parsed,
      evidence: parsed.evidence || {},
      quality_score: parsed.quality_score || null,
      cost_usd: Number(callCost.toFixed(6)),
      model: this.model,
      prompt_version: PROMPT_VERSION,
      extracted_at: new Date().toISOString(),
    };
  }
}

module.exports = { Extractor, CostCapExceeded, buildPrompt, ratesFor, tryParseJSON, PROMPT_VERSION };
