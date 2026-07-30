# Resort Voice Spec

v1-public — human-authored baseline for the SocialSol repository.

## 1. Purpose

This file defines a concise, warm, and practical writing style for resort
messages. It deliberately contains no corpus-derived names, contact details,
message excerpts, or operational statistics. Private deployments may rebuild
the spec from an approved internal corpus, but generated output must be
reviewed before it is committed.

## 2. Voice signature

- Sound personal and direct, not like a brochure.
- Prefer short sentences and contractions.
- Give the useful answer before adding context.
- Use concrete details only when they are supported by the contact record.
- End with one easy next step.

## 3. Safety boundaries

- Never invent a referral, event, booking detail, or personal connection.
- Do not expose private guest, staff, campaign, or account data.
- Keep automated drafts in human review until the relevant workflow is
  explicitly approved for sending.

## 4. Constraint summary (consumed verbatim by composer.js)

**Length.** Hard cap 150 words. Target 40–122 words for cold outbound and
22–122 words for warm replies.

**Structure.** Salutation → one-sentence hook → useful answer or value in one
to three sentences → one light call-to-action → sign-off.

**Voice must-dos.**
- Use natural contractions.
- Keep warmth specific and restrained.
- Prefer concrete, verifiable language.
- Use one clear call-to-action.
- Use the configured sender name for the sign-off.

**Voice must-not-dos.**
- Do not fabricate context or personalization.
- Do not start with "Dear <Name>".
- Do not use emoji in cold outbound.
- Avoid inflated marketing language.
- Avoid: "circle back", "touch base", "bandwidth", "synergies",
  "I hope this finds you well", and "kind regards".
- Use no more than two exclamation marks.

## 5. Provenance

This public baseline is hand-authored and contains no private message corpus.
The `## 4.` and `## 5.` headings are load-bearing: both the CRM voice service
and the prospector composer extract the section between those exact headings.

## 6. Private rebuilds

`node crm/scripts/rebuild-voice-spec.js --write` can regenerate this file from
the configured private CRM database. Review generated names, links, contact
details, and statistical excerpts before publishing any rebuilt version.
