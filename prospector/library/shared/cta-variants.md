# CTA voice anchors

These are **voice anchors, not fill-in slots**. The composer reads them as inspiration for the closer line, then writes its own sentence in spirit. There is no rotation, no pick-one-of-eight. A draft that reuses one of these verbatim is wrong by definition — the LLM should be writing fresh prose every time.

The closer is the one place the CTA lives. Per `voice-spec.md` §2.9, Sarah pivots from the substance of the email to a one-sentence *"feel free / please don't hesitate / I'm always happy to"* register, with the action being the link click rather than a reply.

**Landing-page URL throughout:** `https://weddings.lapuestadelsolresort.com` (matches the `wedding_planners_v1` campaign's `landing_page_url`). Other personas substitute their own live URL once provisioned.

---

## Voice-anchor lines

These show the **tonal shape** of the closer — the move from substance to easy-next-step, with the link as the action. Each line is in Sarah's voice as observed in `voice-spec.md`.

1. If a buyout for a 2027 month is on the table, here's the page with photos and pricing — happy to go deeper if it sparks something: https://weddings.lapuestadelsolresort.com

2. Quick page if it's useful: https://weddings.lapuestadelsolresort.com — please feel free to share with the couple if anything resonates.

3. Page is here if you want to take a look or pass it along: https://weddings.lapuestadelsolresort.com — I'm always happy to talk through dates.

4. If it's helpful, the page has photos, capacity notes, and a WhatsApp line into me: https://weddings.lapuestadelsolresort.com.

5. I'd love for you to take a look when you have a quiet minute — https://weddings.lapuestadelsolresort.com — and don't hesitate to ping me with questions.

6. If your couples ever ask about a private oceanfront buyout in Mexico, this is the page I'd send them to: https://weddings.lapuestadelsolresort.com.

7. Page is here, with photos and capacity in one place — https://weddings.lapuestadelsolresort.com — and I'm easy to reach if anything jumps out.

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
