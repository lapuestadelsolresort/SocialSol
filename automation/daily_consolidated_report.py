#!/usr/bin/env python3
"""One date-aligned Meta → CRM → verified WhatsApp daily report."""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from marketing_snapshot import build_snapshot, format_report
from job_health import get_status, record
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
JOB_NAME = "resort-daily-consolidated"


def la_now():
    return datetime.now(ZoneInfo("America/Los_Angeles"))


def build_report(day):
    return format_report(build_snapshot(day, day))


def post_to_slack(message):
    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration is not configured")
    subprocess.run([
        OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
        "--target", f"channel:{CHANNEL}", "--message", message, "--json",
    ], check=True, timeout=30, capture_output=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    day = args.date or (la_now().date() - timedelta(days=1)).isoformat()
    snapshot = build_snapshot(day, day)
    report = format_report(snapshot)
    if args.json:
        print(json.dumps({"snapshot": snapshot, "message": report}, separators=(",", ":"), sort_keys=True))
        return
    if args.dry_run:
        print(report)
        return
    previous = get_status(JOB_NAME)
    if previous.get("status") == "ok" and previous.get("detail") == day:
        print(f"daily report: {day} already posted")
        return
    post_to_slack(report)
    record(JOB_NAME, True, day)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"daily report: {exc}", file=sys.stderr)
        sys.exit(1)
