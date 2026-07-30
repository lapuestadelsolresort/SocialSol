---
persona_id: <persona-slug>
status: v0
campaigns: []
last_reviewed_by_sarah: not yet
library_status: draft
landing_page_status: not_started
landing_page_url:
landing_page_subdomain: <persona-slug>.lapuestadelsolresort.com
cloudflare_pages_project: lapuestadelsol-<persona-slug>
landing_page_repo_path:
---

# <Persona Name>

This is the structural blueprint for a new persona strategy file. **It is not an email template.** It is the shape for an authoring document that the composer (Step 3.2) reads at email-generation time. Every section below should be filled in for a new persona.

`!new-campaign` (per `slack-interaction.md` §2) scaffolds a new persona at `library/personas/<persona-slug>.md` from this file. After scaffolding, fill in every section. Mark anything Sarah needs to validate with `**Open for Sarah:**` on its own line.

`library_status: draft` — until Sarah has reviewed the persona AND the example emails in `library/examples/<persona-slug>/`, the composer refuses to generate emails for this persona. Sarah review flips this to `sarah-reviewed`.

---

## 1. Who they are

Who is this person? Job title(s), company size or solo/agency split, geography, business model, what their day looks like. ≤6 lines.

## 2. What we want from this email

**Open + click.** That is the entire goal. We are not closing on the first email. A reply is a bonus; the page view on the landing page is the primary conversion event.

(This sentence is invariant across every persona. Do not change it.)

## 3. What they care about

Ranked list. Top item is the one this email most plausibly speaks to.

1.
2.
3.
4.

## 4. Pain points we credibly solve

What problems do they have that *this property and Sarah specifically* address? Tie each pain to a concrete capability or behavior.

- **Pain:** <description>
  - **How we solve it:** <concrete answer>
- **Pain:** ...

## 5. Proof we have

Forward bookings, repeat clients, photos, testimonials, press, comparable groups. The composer reaches for one of these per email. If proof is thin, say so.

-
-

**Composer rule until proof bench fills out:** lead with property capability. No fabrication.

**Open for Sarah:** add or correct proof points.

## 6. The ask (CTA)

- **Primary CTA:**
- **Landing page URL:**
- **Next step after click:**
- **What we are NOT asking for in this email:**

Closer-line voice anchors live in `library/shared/cta-variants.md`.

## 7. Why we're a fit (the elevator-sentence)

> One sentence the composer compresses into the body. Specific enough that swapping it into another persona would be obviously wrong.

**Source:** Sarah, <date>. <verbatim or paraphrase>

## 8. Voice notes

Voice rules come from `voice-spec.md` §4. Persona-specific overrides for this persona:

- <e.g., B2B planners may warrant 0 brochure-vocabulary instead of the global cap of 1>
- <e.g., lead with capability, not feeling>
- <e.g., sign-off rotation preference>
- All other rules: use `voice-spec.md` as-is.

## 9. Hook angles

The composer chooses one based on enrichment data. Mix angles across the example set.

- **Shared region:**
- **Recent work reference:**
- **Soft question:**
- **Direct intro:**
- **Mutual context:**

## 10. Structure (the composer's scaffolding)

1. **Opener:** 1–2 sentences. Pick one hook angle from §9.
2. **Why-contacting disclosure:** 1 sentence. Names how we found them.
3. **Value:** 1–2 sentences. What the resort is, in plain terms. Compress §7 elevator sentence; preserve load-bearing nouns.
4. **CTA:** 1 sentence. Link to landing page with one-line framing.
5. **Sign-off:** rotate per §8.
6. **Compliance footer:** physical address + opt-out line.

Total: 40–150 words, 3–6 sentences. Within `constraints.json` `length`.

## 11. What this persona is NOT

- Not a <related-but-distinct persona> (different reason)
- Not a <other distinct persona> (different reason)

## 12. See examples

Ground-truth examples live in `library/examples/<persona-slug>/`. The composer reads them at generation time when `library_status: sarah-reviewed`.

## 13. Notes & open questions

**Open for Sarah:**
-
-

**Blocked on:**
-
