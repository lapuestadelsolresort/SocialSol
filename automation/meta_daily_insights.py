#!/usr/bin/env python3
"""Pull yesterday's Meta Ads insights and post a summary to #social-sol.

Runs daily after the LP report. Pulls spend, impressions, clicks, CTR, CPC,
and landing page views per campaign and ad. Flags underperformers and
frequency fatigue.

Usage:
    python3 meta_daily_insights.py [--dry-run] [--days N]
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from job_health import get_status, record

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SECRETS_DIR = os.environ.get("SOCIALSOL_SECRETS_DIR", os.path.join(ROOT, "secrets"))
SECRETS = os.path.join(SECRETS_DIR, "meta.json")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
G = "https://graph.facebook.com/v21.0"
JOB_NAME = "resort-meta-daily"

# Thresholds
CTR_WARN = 0.8       # Below 0.8% CTR = flag
CPC_WARN = 1.50      # Above $1.50 CPC = flag
FREQ_WARN = 3.0      # Above 3.0 frequency = creative fatigue warning

# Friendly display names (Meta campaign name -> short label)
# Report is now at campaign level (each segment has its own campaign)
FRIENDLY_NAMES = {
    "LPDS — Weddings": "Weddings",
    "LPDS — Corporate Retreats": "Corporate Retreats",
    "LPDS — Groups / Milestones": "Groups / Milestones",
    "LPDS — Retargeting — Website Visitors": "Retargeting",
    # Legacy (ad set level, kept for backward compat)
    "LPDS — Retarget Warm 8-30d": "Retargeting (Warm 8–30d)",
    "LPDS — Retarget Hot 7d": "Retargeting (Hot 7d)",
}


def la_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-7)))


def api(endpoint, token, **params):
    qs = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    url = f"{G}/{endpoint}?{qs}"
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Meta API request failed for {endpoint}: {exc}") from exc
    if payload.get("error"):
        raise RuntimeError(f"Meta API error for {endpoint}: {payload['error'].get('message', 'unknown')}")
    return payload


def post_slack(msg, dry_run=False):
    if dry_run:
        print(msg)
        return True
    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration is not configured")
    cmd = [
        OPENCLAW, "message", "send",
        "--channel", "slack",
        "--account", SLACK_ACCOUNT,
        "--target", f"channel:{CHANNEL}",
        "--message", msg,
        "--json",
    ]
    try:
        subprocess.run(cmd, check=True, timeout=30, capture_output=True, text=True)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise RuntimeError(f"Slack post failed: {exc}") from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--days", type=int, default=1,
                        help="Number of days to look back (default: 1 = yesterday)")
    args = parser.parse_args()

    with open(SECRETS) as f:
        creds = json.load(f)
    token = creds["access_token"]
    act = creds["ad_account_act"]

    # Date range
    if args.days == 1:
        date_preset = "yesterday"
    elif args.days <= 7:
        date_preset = "last_7d"
    else:
        date_preset = "last_30d"

    report_label = (la_now().date() - timedelta(days=1)).isoformat() if args.days == 1 else f"last {args.days} days"
    if not args.dry_run:
        previous = get_status(JOB_NAME)
        if previous.get("status") == "ok" and previous.get("detail") == report_label:
            print(f"meta_daily_insights: {report_label} already posted")
            return

    # First, get only ACTIVE campaign IDs
    camp_data = api(f"{act}/campaigns", token,
                    fields="id,name,status", filtering=json.dumps([{"field": "effective_status", "operator": "IN", "value": ["ACTIVE"]}]), limit="50")
    active_ids = {c["id"]: c["name"] for c in camp_data.get("data", [])}

    if not active_ids:
        msg = f"*Meta Ads daily report — {report_label}*\nNo active campaigns."
        post_slack(msg, args.dry_run)
        if not args.dry_run:
            record(JOB_NAME, True, report_label)
        return

    # Campaign-level insights (only active campaigns)
    fields = "campaign_name,spend,impressions,clicks,ctr,cpc,actions,frequency"
    data = api(f"{act}/insights", token,
              fields=fields, date_preset=date_preset, level="campaign",
              filtering=json.dumps([
                  {"field": "campaign.effective_status", "operator": "IN", "value": ["ACTIVE"]},
              ]),
              limit="20")

    campaigns = data.get("data", [])
    if not campaigns:
        msg = f"*Meta Ads daily report — {report_label}*\nNo active campaign data for this period."
        post_slack(msg, args.dry_run)
        if not args.dry_run:
            record(JOB_NAME, True, report_label)
        return

    total_spend = 0
    total_clicks = 0
    total_impressions = 0
    lines = []
    warnings = []

    for c in campaigns:
        raw_name = c.get("campaign_name", "?")
        name = FRIENDLY_NAMES.get(raw_name, raw_name)
        spend = float(c.get("spend", 0))
        impressions = int(c.get("impressions", 0))
        clicks = int(c.get("clicks", 0))
        ctr = float(c.get("ctr", 0))
        cpc = float(c.get("cpc", 0)) if c.get("cpc") else 0
        freq = float(c.get("frequency", 0))

        total_spend += spend
        total_clicks += clicks
        total_impressions += impressions

        # Extract landing page views from actions
        lp_views = 0
        for act_item in (c.get("actions") or []):
            if act_item.get("action_type") == "landing_page_view":
                lp_views = int(act_item.get("value", 0))

        lines.append(
            f"  • *{name}*\n"
            f"    ${spend:.2f} spent | {impressions:,} impr | {clicks} clicks | "
            f"CTR {ctr:.2f}% | CPC ${cpc:.2f} | {lp_views} LP views | freq {freq:.1f}"
        )

        if ctr > 0 and ctr < CTR_WARN:
            warnings.append(f"⚠️ {name}: CTR {ctr:.2f}% is below {CTR_WARN}%")
        if cpc > CPC_WARN:
            warnings.append(f"⚠️ {name}: CPC ${cpc:.2f} is above ${CPC_WARN:.2f}")
        if freq > FREQ_WARN:
            warnings.append(f"🔄 {name}: frequency {freq:.1f} — creative fatigue likely")

    # Build message
    msg = f"*Meta Ads daily report — {report_label}*\n"
    msg += f"Total: ${total_spend:.2f} spent | {total_impressions:,} impressions | {total_clicks} clicks\n\n"
    msg += "\n".join(lines)

    if warnings:
        msg += "\n\n*Flags:*\n" + "\n".join(warnings)
    else:
        msg += "\n\n✅ All metrics within healthy ranges"

    post_slack(msg, args.dry_run)
    if not args.dry_run:
        record(JOB_NAME, True, report_label)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"meta_daily_insights: {exc}", file=sys.stderr)
        sys.exit(1)
