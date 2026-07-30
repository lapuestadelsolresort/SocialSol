---
persona_id: wedding-planner
status: v0
campaigns: [wedding_planners_v1]
last_reviewed_by_sarah: 2026-05-04
library_status: sarah-reviewed
landing_page_status: live
landing_page_url: https://weddings.lapuestadelsolresort.com/
landing_page_subdomain: weddings.lapuestadelsolresort.com
cloudflare_pages_project: lapuestadelsol-weddings
landing_page_repo_path: landing/apps/weddings/
---

# Wedding Planner

This file is the composer's primary input for the wedding-planner persona. It absorbs both the persona brief (who they are, what they care about, what proof we have) and the Step 2.2 strategy scaffolding (hook angles, structure, what this persona is NOT).

`library_status: sarah-reviewed` (May 4, 2026) — Sarah has reviewed the 5 example emails in `library/examples/wedding-planner/`. The composer (Step 3.2) is cleared to generate fresh emails for this persona.

---

## 1. Who they are

Independent or small-team wedding planners — typically solo or 1–2 person operations, not large agencies. Books a few destination weddings a year and owns the client relationship from inquiry to send-off. The PV list (`pv-list.csv`, n=142) skews North American (CA, TX, NY/NJ metro, MX-adjacent) and is mainly small businesses confirmed by Sarah on 2026-05-04. A boutique-agency archetype may emerge in later imports; the same voice rules apply if it does.

These planners design destination weddings for couples in their 30s, with guest counts in our range (20–100) and budgets that support full-resort buyouts of small properties. A bad venue recommendation costs them the client relationship, not just the booking — so reliability is reputational, not transactional.

## 2. What we want from this email

**Open + click.** That is the entire goal. We are not closing on the first email. A reply is a bonus; the page view on the landing page is the primary conversion event. The CTA is a link, not a meeting and not a quote — see §6.

(This sentence is invariant across every persona. The content of each persona changes; the goal does not.)

## 3. What they care about

Ranked. The top item is the one this email most plausibly speaks to. Items 2–4 are useful for varying the hook angle (§9) but should not all appear in a single email.

1. **Will this venue actually deliver?** Reliability is the #1 concern — a bad recommendation costs them the client.
2. **Is the property easy to work with?** Responsive, flexible, doesn't surprise them with day-of friction. Single point of contact preferred.
3. **Does it fit the wedding the planner is trying to design?** Capacity, ceremony space, reception space, bridal-party housing, photography moments.
4. **Economics — planner commission or collaboration arrangement?** Not always the lead concern but always present in the background.

## 4. Pain points we credibly solve

Each pain ties to a concrete property capability or Sarah behavior. The composer reaches for one of these per email — never more than one.

- **Pain: capacity uncertainty for 20–35 guest weddings.** Planners often hear "we host weddings" from properties that can do a ceremony but can't actually house the wedding party — guests scatter to nearby hotels and the property loses its sense of buyout.
  - **How we solve it:** Full-resort buyout, six villas, sleeps up to 26 in beds + 7 rollaways available. Wedding party stays on-property end-to-end.
- **Pain: vendor coordination chaos.** A property that doesn't include meals/bar means coordinating outside catering, outside bar, outside cleaning — each a failure point.
  - **How we solve it:** All-inclusive logistics. Chef Daniel and team handle three meals/day, bar service available at $35/hr per bartender, BYO alcohol welcome, daily housekeeping included.
- **Pain: privacy and exclusivity.** Many "private" properties are still shared with other guests, retail traffic, or staff overflow. Disrupts the buyout feeling.
  - **How we solve it:** Genuinely private oceanfront resort; full buyout means full buyout. Staffing reduces to essential personnel only on request.
- **Pain: visual / "will it photograph" question.** Planners need the venue to deliver hero shots — ceremony backdrop, reception, golden-hour moments.
  - **How we solve it:** Oceanfront dining terrace seats up to ~70 with sunset light; open-air covered space hosts 100+; multiple custom-architected villa interiors for bridal-party photography.

## 5. Proof we have

(Filled by Sarah, 2026-05-04. Composer reaches for one piece of proof per body — pick from the list per email.)

- **Forward bookings:** **2** confirmed weddings on the books — October 2026 and January 2027. (A Spring 2027 hold exists but is not yet a paid deposit; do not cite as proof. If/when it firms up, update this section.)
- **Repeat planners:** None to date.
- **Testimonials / reviews:** None yet. Sarah wants the option to add as they come in. The composer cannot reach for a quote in v0; example emails must be quote-free until this fills in.
- **Press / wedding-blog mentions:** None.
- **Comparable groups already hosted:** Privacy-sensitive retreat groups. May be useful as social proof that the buyout actually delivers the privacy planners' couples want, even though the group wasn't a wedding.

**Composer rule:** Until testimonials land, body lines must lead with **property capability** or **proof of demand** ("we have weddings on the books for October 2026 and January 2027"). No testimonial fabrication. No "couples have said..." construction. No reference to the Spring 2027 hold.

## 6. The ask (CTA)

- **Primary CTA:** Click the landing page link.
- **Landing page URL:** https://weddings.lapuestadelsolresort.com/
- **Next step after click:** Landing page CTA = WhatsApp Sarah for date check / planning conversation.
- **What we are NOT asking for in this email:** Not asking for a quote response, not asking them to forward to a couple, not asking for a buyout commitment, not asking for a call. Just the click.
- **Confirmed (Sarah, 2026-05-04):** WhatsApp is the only next step. No call-scheduling alternative for this persona.

Closer-line voice anchors live in `library/shared/cta-variants.md` — read those for tonal shape, then write a fresh sentence per email.

## 7. Why we're a fit (the elevator-sentence)

> "We're a fully private oceanfront buyout that sleeps up to 35 people, a separate bridal suite, stunning backdrop of Isle de Coral in Jaltemba bay and includes gourmet meals and service."

**Source:** Sarah, 2026-05-04. Verbatim. The composer compresses this into one body line per email; the wording above is the canonical reference. If a body cannot be written without trimming or rewording the sentence, the composer compresses but **preserves the load-bearing nouns**: *private oceanfront buyout*, *up to 35 people*, *separate bridal suite*, *Isle de Coral in Jaltemba bay*, *gourmet meals and service*.

## 8. Voice notes

Voice rules come from `voice-spec.md` §4. Persona-specific overrides for this persona:

- **B2B register, not B2C.** Wedding planners are professional collaborators, not couples. Cap the brochure-vocabulary cluster (wonderful / beautiful / special / unforgettable / extraordinary / magical) at **0 per email** for this persona — drop one further than the global voice-spec cap of 1. Planners read brochure copy all day; it's the noise they're filtering past.
- **Lead with capability, not feeling.** Sarah's "absolutely thrilled" warmth-marker is in-voice generally but reads off-key opening a B2B planner email. Save the warmth marker for the closer, not the opener.
- **Single proof point per email.** Even when the proof bench fills out, one piece of proof per body — pick from §5 list per email.
- **Sign-offs:** rotate among `Warmly,` / `Best,` / `Warmest regards,` / `All my very best,` per `voice-spec.md` §2.6. For 60–100-word cold outbound to planners, `Warmly,` and `Best,` are closest in register.
- All other rules: use `voice-spec.md` as-is.

## 9. Hook angles

The composer chooses one hook angle based on enrichment data on the contact record. Mix angles across the example set; do not let the recent-sends log show one angle dominating.

- **Shared region:** recipient does work in CA / TX / NY / MX or has a portfolio piece tagged in those areas.
- **Recent work reference:** specific wedding from their portfolio in the last 6 months, called out in one specific detail. Composer must NOT fabricate — only used when enrichment surfaces a real reference.
- **Soft question:** opens with a planning-relevant question (e.g., "Are you taking 2027 inquiries yet?", "Do you ever do destination buyouts in Mexico?").
- **Direct intro:** no hook; clear who-we-are + why-them + link. Used when enrichment is thin.
- **Mutual context:** if enrichment surfaces a shared planner network, conference, or referral path.

## 10. Structure (the composer's scaffolding)

1. **Opener:** 1–2 sentences. Pick one hook angle from §9.
2. **Why-contacting disclosure:** 1 sentence. Names how we found them (per `library/shared/compliance-elements.md` §3).
3. **Value:** 1–2 sentences. What the resort is, in plain terms — beachfront Riviera Nayarit, full buyouts up to 35, all-in pricing. Compress §7 elevator sentence; preserve load-bearing nouns. No adjectives beyond what §8 allows. One concrete detail.
4. **CTA:** 1 sentence. Link to landing page with one-line framing — see `library/shared/cta-variants.md` for tonal shape.
5. **Sign-off:** rotate per §8.
6. **Compliance footer:** physical address + opt-out line, per `library/shared/compliance-elements.md` §1–§2.

Total: 40–150 words, 3–6 sentences. Within `constraints.json` `length`.

## 11. What this persona is NOT

- Not a venue scout (different list, different message — venue scouts evaluate properties at scale; planners pick venues for specific couples).
- Not a destination wedding consumer (we're going B2B here, not B2C — the couple gets a different message via a different campaign).
- Not a celebrity-tier planner (different price point, different relationship pattern; if a contact in the import is clearly celebrity-tier, suppress and surface to Sarah).

## 12. See examples

Ground-truth examples live in `library/examples/wedding-planner/`. The composer reads all of them at generation time. Persona is `library_status: sarah-reviewed`, so the composer is cleared to generate and send for this persona.

## 13. Notes & open questions

- The `pv-list.csv` (n=142) is the immediate source. Names there are individual planners, not agency intake addresses — confirm during early sends whether replies actually come from the addressed person or from a coordinator.
- Composer should NOT mention specific dates ("April 2027") in cold outbound — date-specific availability is an inquiry-reply move, not a cold-outbound move.

**Resolved (Sarah, 2026-05-04):**
- §5 proof points: filled in. Forward bookings = 2 (October 2026, January 2027). Spring 2027 dropped — soft hold, not proof. No testimonials yet. No press. No repeat planners.
- §6 landing page URL: https://weddings.lapuestadelsolresort.com/. WhatsApp confirmed as the only next step.
- §7 elevator sentence: provided verbatim by Sarah.
- §8 brochure-vocabulary cap: keep at 0 for this persona.

**Still open:**
- When the first testimonial lands, update §5 and re-generate examples to include a quote-grounded variant.
- When Spring 2027 firms up to a paid deposit, add it to forward bookings.
