#!/usr/bin/env python3
"""Seven-day, same-window reconciliation using live campaign destinations."""

import argparse
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "automation"))
from campaign_measurement import crm_metrics, meta_metrics  # noqa: E402
from campaign_registry import fetch_live_snapshot, group_registry, load_meta_secrets, load_registry  # noqa: E402
from job_health import record  # noqa: E402

DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("TRACKING_QC_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "ig-drafts")
JOB_NAME = "resort-weekly-tracking-audit"
SESSION_RATIO_MIN = 0.30


def post(message, dry_run):
    if dry_run:
        print(message)
        return
    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration is not configured")
    subprocess.run([
        OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
        "--target", f"channel:{CHANNEL}", "--message", message, "--json",
    ], check=True, timeout=30, capture_output=True)


def run(days, dry_run, no_post=False):
    today = datetime.now(ZoneInfo("America/Los_Angeles")).date()
    end_day = (today - timedelta(days=1)).isoformat()
    start_day = (today - timedelta(days=days)).isoformat()
    records, secrets = load_registry(), load_meta_secrets()
    snapshot = fetch_live_snapshot(records, secrets)
    live = {row["campaign_id"]: row for row in snapshot if row["effective_status"] == "ACTIVE"}
    campaigns = [row for row in group_registry(records) if row["campaign_id"] in live]
    if not campaigns or not DB_PATH.exists():
        raise RuntimeError("live campaigns or CRM database unavailable")
    for campaign in campaigns:
        campaign["utm_tags"] = live[campaign["campaign_id"]]["utm_tags"]
    meta, crm = meta_metrics(secrets, campaigns, start_day, end_day), crm_metrics(DB_PATH, campaigns, start_day, end_day)
    failures, lines = [], [f"*Weekly Tracking Reconciliation — {start_day} to {end_day}*"]
    for campaign in campaigns:
        cid = campaign["campaign_id"]
        mm, cm = meta[cid], crm[cid]
        ratio = cm["sessions"] / mm["link_clicks"] if mm["link_clicks"] else None
        ok = not (mm["link_clicks"] >= 20 and ratio < SESSION_RATIO_MIN)
        ok = ok and not (cm["sessions"] >= 20 and cm["sessions_with_behavior"] == 0)
        if not ok:
            failures.append(campaign["campaign_name"])
        ratio_text = "n/a" if ratio is None else f"{ratio:.0%}"
        lines.append(
            f"{'✅' if ok else '🔴'} *{campaign['campaign_name'].replace('LPDS — ', '')}:* "
            f"${mm['spend']:.2f} | {mm['link_clicks']} link clicks | {cm['sessions']} sessions ({ratio_text}) | "
            f"{cm['wa_taps']} WA taps | {cm['verified_wa_leads']} verified WA leads"
        )
    if failures:
        lines.append("Pause recommendations remain blocked for failed campaigns.")
    if not no_post:
        post("\n".join(lines), dry_run)
    elif dry_run:
        print("\n".join(lines))
    if not dry_run:
        record(JOB_NAME, not failures, f"{start_day}..{end_day}: {len(failures)} failure(s)")
    return not failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-post", action="store_true")
    args = parser.parse_args()
    raise SystemExit(0 if run(args.days, args.dry_run, args.no_post) else 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"weekly tracking audit: {exc}", file=sys.stderr)
        raise SystemExit(2)
