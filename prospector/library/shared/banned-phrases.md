# Banned phrases

Substrings the compliance gate (Step 3.1) flags. The composer must not produce a draft containing any of these. The gate matches **case-insensitively** against the email body and subject line.

This file is the **canonical machine-readable list**. The narrative reasoning lives in `voice-spec.md` §3 — read that first if you want the why behind any line.

## How the list is sourced

- Phrases sourced from `voice-spec.md` §3.1 (Sarah-corpus 0-occurrence phrases that LLMs reach for and Sarah does not use).
- Phrases sourced from the Step 2.2 spec (sales-speak the composer must avoid).
- Union of both lists, deduplicated.

## Format

One phrase per line, lowercase, no quotes, no leading/trailing whitespace. The gate ignores: empty lines, lines beginning with `#` (comments), and lines that are exactly `---` (markdown horizontal rules used for human readability).

## What is NOT on this list

The brochure-vocabulary cluster (`wonderful`, `beautiful`, `special`, `unforgettable`, `extraordinary`, `magical`) is **not** banned globally — Sarah uses these in-voice. They are capped per-email by `voice-spec.md` §4 (≤1 per email globally; per-persona overrides may set this to 0, e.g., wedding-planner). Cap enforcement is a separate gate check, not a banned-substring check.

The phrase `reach out` is **not** banned despite being a common sales cliché — Sarah uses it 3× in corpus in closer constructions (`voice-spec.md` §3.2 calibration signal).

---

# Banned substrings

# from voice-spec.md §3.1 (Sarah corpus, 0 occurrences)
circle back
touch base
bandwidth
synergies
i hope this finds you well
i hope this email finds you well
i wanted to
just wanted to
quick question
definitely
kind regards
sincerely
looking forward to
looking forward
i believe
i think
actually
honestly
frankly
obviously
clearly
literally
amazing
warm regards
all the best

# from Step 2.2 spec seed list (sales-speak)
synergy
leverage
just following up
as per my last email
unique opportunity
world-class
premier
