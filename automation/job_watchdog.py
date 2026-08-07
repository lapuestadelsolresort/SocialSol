#!/usr/bin/env python3
"""Alert #social-sol when expected resort jobs are failed or stale."""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from job_health import STATE_PATH

OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
EXPECTED = {
    "resort-daily-consolidated": timedelta(hours=30),
    "resort-tracking-health": timedelta(hours=30),
    "resort-weekly-tracking-audit": timedelta(days=8),
    "resort-marketing-reconcile": timedelta(hours=30),
    "resort-lp-phase-gate": timedelta(hours=30),
    "resort-crm-backup": timedelta(hours=30),
    "resort-log-rotation": timedelta(days=8),
    "resort-crm-audience-sync": timedelta(hours=30),
}


def main():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, json.JSONDecodeError):
        state = {}

    now = datetime.now(timezone.utc)
    problems = []
    for job, max_age in EXPECTED.items():
        entry = state.get(job)
        if not entry:
            problems.append(f"`{job}` has never reported")
            continue
        try:
            last_run = datetime.fromisoformat(entry["last_run_at"])
        except (KeyError, TypeError, ValueError):
            problems.append(f"`{job}` has invalid status data")
            continue
        age = now - last_run
        if entry.get("status") != "ok":
            problems.append(f"`{job}` failed: {entry.get('detail') or 'no detail'}")
        elif age > max_age:
            problems.append(f"`{job}` is stale ({age.total_seconds() / 3600:.1f}h)")

    if not problems:
        print("job watchdog: all expected jobs healthy")
        return

    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration is not configured")
    message = "*⚠️ Resort automation health alert*\n" + "\n".join(f"• {item}" for item in problems)
    subprocess.run(
        [
            OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
            "--target", f"channel:{CHANNEL}", "--message", message, "--json",
        ],
        check=True,
        timeout=30,
        capture_output=True,
    )
    print(f"job watchdog: alerted on {len(problems)} problem(s)")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"job_watchdog: {exc}", file=sys.stderr)
        sys.exit(1)
