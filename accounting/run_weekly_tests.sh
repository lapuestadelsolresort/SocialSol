#!/bin/bash
# Weekly Kapital Accounting Integrity Tests
# Runs all 7 tests and outputs a Slack-ready report
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
python3 accounting/tests.py 3 2>&1
