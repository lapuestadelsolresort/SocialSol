'use strict';
//
// cli-args.js — minimal argv parser for Regina scripts.
//
// Supports --key value and --key=value. Unknown keys are kept verbatim.
// Boolean flags (--flag) become true.

function parseArgs(argv) {
  const out = {};
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const key = tok.slice(2);
      const next = a[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

module.exports = { parseArgs };
