/**
 * Banned-phrases utility for the compliance gate (Phase D Step 3.1b item 7).
 *
 * The canonical list lives at:
 *   prospector/library/shared/banned-phrases.md
 *
 * Per that file:
 *   - One phrase per line, lowercase, no quotes, no leading/trailing whitespace
 *   - Gate ignores: empty lines, lines beginning with `#`, lines that are `---`
 *   - Match is case-insensitive substring against subject + body
 *
 * The brochure-vocabulary cluster (wonderful, beautiful, special, etc.) is
 * intentionally NOT banned here — those have a per-email cap enforced
 * elsewhere in voice-spec.md §4. This file is for hard-banned substrings only.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PHRASES_PATH = path.join(
  __dirname,
  '..',
  'library',
  'shared',
  'banned-phrases.md'
);

// The data section starts after the `# Banned substrings` heading. Everything
// above it is narrative documentation that this parser MUST NOT treat as
// banned phrases.
const DATA_HEADING = '# Banned substrings';

function loadBannedPhrases(filePath = DEFAULT_PHRASES_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const headingIdx = raw.indexOf(DATA_HEADING);
  if (headingIdx < 0) {
    throw new Error(
      `loadBannedPhrases: '${DATA_HEADING}' heading not found in ${filePath}; ` +
        `parser cannot distinguish narrative from data.`
    );
  }
  // Skip past the heading line itself.
  const dataSection = raw.slice(headingIdx + DATA_HEADING.length);

  return dataSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line !== '---')
    .map((line) => line.toLowerCase());
}

/**
 * Find the first banned phrase present in the given text.
 * Returns { phrase, index } if found, null otherwise.
 * Match is case-insensitive substring. The returned `phrase` is the
 * lowercase canonical form from the list (for logging/audit).
 */
function findBannedPhrase(text, phrases) {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    const idx = haystack.indexOf(phrase);
    if (idx >= 0) return { phrase, index: idx };
  }
  return null;
}

module.exports = { loadBannedPhrases, findBannedPhrase, DEFAULT_PHRASES_PATH };
