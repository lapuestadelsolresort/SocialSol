'use strict';

// Owner quarantine (F-020, qc/DECISIONS.md D-002, 2026-08-15): these workflows
// stay registered but must never be armed as live in a rendered production
// config. Re-arming one is a release-path change, not a runtime toggle.
//
// Canonical here so the shadow validator that enforces it and the operator
// documentation and help surface that describe it cannot disagree.
const QUARANTINED_LIVE_WORKFLOWS = ['meta.dm.reply'];

module.exports = { QUARANTINED_LIVE_WORKFLOWS };
