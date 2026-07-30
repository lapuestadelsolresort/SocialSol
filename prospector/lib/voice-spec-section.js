'use strict';
//
// voice-spec-section.js — single source of truth for the voice-spec.md §4 contract.
//
// Why this module exists: §4 of voice-spec.md is consumed by two callers
// — Paulina's composer (prospector/composer.js) and the R3 Voice Service
// (crm/lib/voice-draft.js). Before this module they each carried their
// own regex, and the patterns drifted (multiline anchor vs. literal
// newline lookahead). One contract, one regex, two importers.
//
// THE CONTRACT: §4 is everything between a line beginning with "## 4."
// and the next line beginning with "## 5.". No code fence required, no
// "next H2" heuristic — strictly §4 → §5. The structural guard test in
// crm/test/voice-draft.test.js asserts that voice-spec.md keeps §5
// immediately after §4 (no intervening H2).
//
// The rebuild script (crm/scripts/rebuild-voice-spec.js) generates a
// spec that honors this contract. If a future rebuild moves §5 or
// inserts a new H2 between §4 and §5, the structural guard test will
// fail — fix the rebuild template, do not loosen the regex.

const fs = require('fs');

const VOICE_SPEC_SECTION_4_REGEX = /^## 4\.[\s\S]*?(?=\n## 5\.)/m;

function extractSection4(rawMarkdown) {
  const m = String(rawMarkdown).match(VOICE_SPEC_SECTION_4_REGEX);
  return m ? m[0] : '';
}

function loadSection4(specPath) {
  const raw = fs.readFileSync(specPath, 'utf8');
  return extractSection4(raw);
}

module.exports = {
  VOICE_SPEC_SECTION_4_REGEX,
  extractSection4,
  loadSection4,
};
