# Compliance elements

The four required elements every cold-outbound email must include. The compliance gate (Step 3.1) reads the keys from `constraints.json` (`required_elements`) and looks them up here at validation time. Canonical values come from `prospector/config.json` — when the resort's address or the sender identity changes, update `config.json` first; this file documents the contract, not the source.

This file is human-readable reference. Code consumes the keys; humans consume the prose.

---

## 1. `physical_address`

The resort's mailing address as it appears on the website footer. Required by Resend's AUP for cold-outbound and by US/CAN-SPAM for any commercial email crossing those jurisdictions.

**Canonical value (from `prospector/config.json`):**

> Del Mirador 300, Pescadores, 63720 La Peñita de Jaltemba, Nayarit, Mexico

**Where it appears in the email:**
A single plain-text line in the compliance footer at the very bottom of the body, after the sign-off. No styling, no hyperlinks. Example footer block:

```
Del Mirador 300, Pescadores, 63720 La Peñita de Jaltemba, Nayarit, Mexico
Reply 'unsubscribe' and I'll remove you immediately.
```

**Validation:** the compliance gate substring-matches the canonical address (case-sensitive). Address drift in the body fails the check.

---

## 2. `opt_out_link`

A working unsubscribe path the recipient can take. Two surfaces, both required:

1. A clickable web URL pointing to the public `/unsubscribe` endpoint (Step 3.1a) with a per-send HMAC-signed token. This is the path Gmail/Yahoo's native one-click button uses, and the path 95%+ of unsubscribes will go through.
2. A mailto fallback to a dedicated alias for older mail clients and recipients who prefer "reply to unsubscribe."

**Canonical mailto target:**

> `mailto:unsubscribe@outreach.lapuestadelsolresort.com?subject=unsubscribe`

`unsubscribe@outreach.*` is a dedicated alias (separate from `sarah@outreach.*`) forwarded via ImprovMX to Sarah + Jason. Triage of "I want to unsubscribe" vs "I want to talk to Sarah" is possible because the inboxes can filter on `to:` address.

**Canonical body URL pattern:**

> `https://webhook.lapuestadelsolresort.com/unsubscribe?token=<TOKEN>`

The TOKEN is generated once per send by `prospector/lib/headers.js` `buildUnsubscribeArtifacts(contactId, campaignName)` — same token used in the `List-Unsubscribe` header (§4 below). Re-use the token across both surfaces; do not regenerate.

**Body block (required shape — the compliance gate verifies presence of both the URL and the mailto):**

> Del Mirador 300, Pescadores, 63720 La Peñita de Jaltemba, Nayarit, Mexico
> Reply 'unsubscribe' to unsubscribe@outreach.lapuestadelsolresort.com or [click here to unsubscribe](https://webhook.lapuestadelsolresort.com/unsubscribe?token=<TOKEN>) — I'll remove you immediately.

The wording around the link is composer-flexible (e.g., "or unsubscribe here", "or use this link") as long as the URL with a valid token is present. The mailto target and URL host are fixed.

**Validation (gate's item 4):** every `https://webhook.lapuestadelsolresort.com/unsubscribe?token=<...>` URL extracted from the body MUST verify against the recipient's `contactId`. The gate also requires at least one such URL in both header and body — catches templating regressions that drop the link from one surface.

---

## 3. `why_contacting_disclosure`

One sentence in the body that names how Paulina found this recipient. The composer generates this from enrichment data on the contact record (`pv_list_v1` import, conference attendee list, mutual referrer, public portfolio piece, etc.).

**Why this is required:** cold outbound to a stranger that doesn't disclose how you got their address reads as scrape-spam — both to humans and to inbox-provider classifiers. A specific source ("saw your write-up on the Sayulita beach ceremony last month") performs better and is honest about the contact path.

**What counts as a valid disclosure:**
- A specific source the composer can name from enrichment data — a portfolio piece, a publication mention, a conference, a referrer name.
- A general source named honestly when no specific data exists — "your name came up in a list of independent destination-wedding planners I'm reaching out to."

**What does NOT count:**
- Fabricated specifics ("loved your recent Tulum wedding!" when there is no evidence of a Tulum wedding).
- Vague hand-waves ("we found your email online").
- Omission entirely.

**Composer rule:** if enrichment yields no usable disclosure, the composer falls back to the honest general source above. It does NOT fabricate.

**Validation:** the compliance gate checks for an approved disclosure pattern.
When manual review is enabled, the configured reviewer must still confirm that
the claimed source is accurate.

---

## 4. `list_unsubscribe_header`

RFC 2369 / 8058 header set on the SMTP envelope at send time, not in the body. Resend accepts custom headers via the SDK call.

**Canonical header value:**

```
List-Unsubscribe: <mailto:unsubscribe@outreach.lapuestadelsolresort.com?subject=unsubscribe>, <https://webhook.lapuestadelsolresort.com/unsubscribe?token=<TOKEN>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Built by `prospector/lib/headers.js` `buildUnsubscribeArtifacts()`. The TOKEN value is the same token embedded in the body URL (§2) — generated once per send.

The `List-Unsubscribe-Post` line is RFC 8058 (Gmail / Yahoo February 2026 sender requirements) and is required for any sender doing >5,000/day — we are far below that threshold but Gmail honors the header regardless and sends a higher-trust signal.

**Where this is set:** `prospector/orchestrator.js` and
`regina/lib/auto-send.js` add it to the Resend request. The composer does not
write this header.

**Validation:** the compliance gate confirms that both the message body and
headers contain a valid token for the recipient before the Resend request.

---

---

## Why-contacting disclosure patterns (item 6 gate)

The compliance gate's item 6 runs a weak pattern check on the email body. At least one of these patterns must match (case-insensitive substring) for the gate to mark the item as `manual` and pass through to draft-review. Pattern miss is a hard fail (`item_6_no_disclosure_pattern`) — catches the composer regression where the disclosure is dropped entirely.

- `i came across`
- `came across your`
- `i saw your`
- `your work`
- `your portfolio`
- `your name came up`
- `found you via`
- `noticed your`
- `i'm reaching out because`
- `recommended`
- `referred`

Pattern match returns `items: {6: 'manual'}` in the gate result struct, not a
semantic green checkmark. When review is enabled, the configured reviewer
confirms that the disclosure fits the recipient.

This list evolves; when the composer learns a new opener shape, add the pattern here. The gate reloads on each evaluation.

---

## Source of truth

If `prospector/config.json` changes the address, sender email, or reply-to, this file updates in the same commit. Keep them in lockstep — the compliance gate trusts `config.json` for the live values; this file documents what those values mean and how they appear in an email.
