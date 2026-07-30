---
persona_id: travel-advisor
status: v0
campaigns: []
last_reviewed_by_sarah: not yet
library_status: draft
landing_page_status: not_started
landing_page_url:
landing_page_subdomain: advisors.lapuestadelsolresort.com
cloudflare_pages_project: lapuestadelsol-advisors
landing_page_repo_path:
---

# Travel Advisor

This file is **MVP-optional** per the Step 2.2 spec. Most sections are placeholders pending Sarah's review and a deeper read on whether this persona is worth campaign investment vs. wedding-planner and corporate-retreat.

`library_status: draft`. **No example emails in `library/examples/travel-advisor/`** — examples wait until Sarah signs off on the strategy below.

The composer (Step 3.2) refuses to generate emails for this persona while `library_status: draft`. Examples in `library/examples/<persona>/` are also gated on `sarah-reviewed` per the Step 2.2 spec.

---

## 1. Who they are

**Open for Sarah.** Working assumption: independent or small-agency travel advisors (Virtuoso / Signature / independent IATAs / luxury / destination specialists) who book full-service trips for wealthy clients and are looking for hand-picked off-the-beaten-path properties to recommend.

Geography: skews North American, with subset focused on Mexico / Latin America. Books a few high-touch trips a month; values a single point of contact at the property.

**Open for Sarah:** Confirm this is the right archetype, or whether the target is a different slice (e.g., DMC operators in Mexico vs. North-America-based advisors).

## 2. What we want from this email

**Open + click.** That is the entire goal. We are not closing on the first email.

(Identical across all personas. Invariant.)

## 3. What they care about

**Open for Sarah.** Best-guess scaffold:

1. **Does this property reflect well on me when I recommend it?** Advisor-to-client trust is everything; a bad property burns the relationship.
2. **Can I get my client a real experience here, not the sanitized resort version?** Authenticity, location, food, sense of place.
3. **Is the property easy for me to work with?** Direct contact, fast confirmation, commission paid reliably.
4. **Commission economics.** Always present in the background.

## 4. Pain points we credibly solve

**Open for Sarah.** Best-guess scaffold:

- **Pain: cookie-cutter recommendations bore the client.** Advisors need properties with a sense of place.
  - **How we solve it:** Genuinely private oceanfront resort in Riviera Nayarit; not part of a chain; owner-operated.
- **Pain: full-buyout matchmaking is hard at small group sizes.** Most properties either won't sell-out a buyout under 50 people or charge a premium that breaks the math.
  - **How we solve it:** Buyouts at 8–35 guests are routine here, not exceptional.
- **Pain: commission reliability with small properties.** Advisors avoid recommending properties that haggle on commission or pay slowly.
  - **How we solve it:** *Open for Sarah — what's the commission policy for travel-advisor bookings?*

## 5. Proof we have

**Open for Sarah.** Working assumption: forward bookings (Oct 2026, Jan 2027) on the wedding side are not on-point for this persona — those signal demand to weddings buyers, not to luxury-leisure buyers. What proof exists for the leisure-travel use case?

Composer rule until proof bench fills out: lead with **property capability**, not testimonials. Do not fabricate.

## 6. The ask (CTA)

- **Primary CTA:** Click the landing page link.
- **Landing page URL:** *not yet provisioned* — `!provision-landing travel-advisor` is the unblock.
- **Next step after click:** *to be defined when landing page is built.*
- **What we are NOT asking for in this email:** Not asking for a commission negotiation, not asking for a quote, not asking for a meeting. Just the click.

**Open for Sarah:** confirm whether this persona is worth the campaign investment, or whether it gets deprioritized in favor of wedding-planner volume + corporate-retreat.

## 7. Why we're a fit (the elevator-sentence)

**Open for Sarah.** No working draft until §1, §3, §4 are validated.

## 8. Voice notes

Voice rules come from `voice-spec.md` §4. Persona-specific overrides: TBD pending Sarah's view on the right register for advisor outreach (likely B2B, capability-leading, but the brochure-vocabulary cap may be 1 rather than 0 — advisors want a sense of the property).

## 9. Hook angles

**Open for Sarah.** Working scaffold:

- **Shared region:** advisor focuses on Mexico / Latin America in their published itineraries.
- **Recent client work:** advisor mentioned a recent destination wedding or buyout in their newsletter / blog.
- **Direct intro:** clear who-we-are + why-them + link.
- **Mutual context:** shared advisor network, conference, or referral path.

## 10. Structure (the composer's scaffolding)

Same shape as wedding-planner / corporate-retreat — see `library/personas/wedding-planner.md` §10. Within `constraints.json` `length`.

## 11. What this persona is NOT

- Not a wedding planner (different message, different proof bench).
- Not a corporate-retreat organizer (different use case).
- Not a leisure traveler (we're going B2B; the consumer / direct-booker gets a different message via a different campaign).
- Not a DMC / inbound operator in Mexico (those are a separate slice — confirm with Sarah whether they're worth a fourth persona).

## 12. See examples

**No examples yet.** `library/examples/travel-advisor/` is intentionally empty pending Sarah's sign-off on §1, §3, §4, §7.

## 13. Notes & open questions

**Open for Sarah:**
- Is this persona worth campaign investment vs. doubling down on wedding-planner?
- §1 archetype confirmation.
- §3, §4 ranking + pain points.
- §5 proof — what exists for leisure-travel use cases?
- §6 commission policy.
- §7 elevator sentence in your voice.
- §8 brochure-vocabulary cap (1 vs. 0).
- §11: is "DMC / inbound operator in Mexico" actually a fourth persona we should plan for?

**Blocked on:**
- Sarah validation of the questions above before any examples are drafted.
- Landing-page provisioning for `advisors.lapuestadelsolresort.com`.
