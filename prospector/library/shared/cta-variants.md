# CTA voice anchors

These are **voice anchors, not fill-in slots**. The composer reads them as inspiration for the closer line, then writes its own sentence in spirit. There is no rotation, no pick-one-of-eight. A draft that reuses one of these verbatim is wrong by definition — the LLM should be writing fresh prose every time.

The closer is the one place the CTA lives. Per `voice-spec.md` §2.9, Sarah pivots from the substance of the email to a one-sentence *"feel free / please don't hesitate / I'm always happy to"* register, with the action being the link click rather than a reply.

**Landing-page URL throughout:** `https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1` (matches the `planner_partner_program_v1` campaign). Other personas substitute their own live URL once provisioned.

---

## Voice-anchor lines

These show the **tonal shape** of the closer — the move from substance to easy-next-step, with the link as the action. Each line is in Sarah's voice as observed in `voice-spec.md`.

1. Here's the venue partner program if you'd like to see how referrals, site visits, and planner support work: https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1

2. Quick page if it's useful: https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1 — it has the property fit and partner terms in one place.

3. The partner overview is here if you want to keep it on file: https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1 — I'm always happy to answer the practical questions.

4. If it's helpful, this has the commission, hosted-visit details, property facts, and a WhatsApp line into me: https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1.

5. I'd love for you to take a look when you have a quiet minute — https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1 — and don't hesitate to ping me with questions.

6. If a private Riviera Nayarit venue belongs in your portfolio, this is the partner page I'd start with: https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1.

7. Page is here, with partnership terms and property fit in one place — https://planners.lapuestadelsolresort.com/?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1 — and I'm easy to reach if anything jumps out.

---

## What makes these in-voice

- **Pivot from substance to next-step.** The closer doesn't re-pitch. It hands over the link with low pressure.
- **Contractions in the casual stretch** (`it's`, `I'd`, `don't`) — per `voice-spec.md` §2.2.
- **One em-dash** for an aside or qualification, in line with corpus density — per `voice-spec.md` §2.3.
- **Closer register** is `feel free / don't hesitate / I'm always happy to / I'd love for you to` — per `voice-spec.md` §2.9.
- **Action is the link**, not a reply or a call. The page is the conversion event for cold outbound.

## What would be off-voice

- "Click here to learn more" — clinical, not Sarah.
- "Schedule a call" — not the ask in cold outbound; WhatsApp through the landing page is the next step (per `library/personas/wedding-planner.md` §6).
- "Looking forward to hearing from you" — `looking forward (to)` is a 0-corpus-occurrence phrase per `voice-spec.md` §3.1. Avoid.
- "Let me know if you'd like to learn more" — soft permission-asking; not the close-pattern Sarah uses.
- Two CTAs in one closer — pick one.

## Composer rule

Use these as inspiration for shape and register. Write a fresh sentence for every email. The compliance gate enforces `must_include_landing_page_link` and `max_links: 2` from `constraints.json`; voice-fidelity is enforced by the prompt (and by Sarah at draft-review).
