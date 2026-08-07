#!/usr/bin/env python3
"""One date-aligned Meta → CRM → verified WhatsApp daily report."""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from campaign_measurement import crm_metrics, meta_metrics, unattributed_verified_leads
from campaign_registry import fetch_live_snapshot, group_registry, load_meta_secrets, load_registry
from job_health import get_status, record

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
HEALTH_PATH = ROOT / "state/tracking-health.json"
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
JOB_NAME = "resort-daily-consolidated"
CTR_WARN, CPC_WARN, FREQ_WARN = 0.8, 1.5, 3.0


def la_now():
    return datetime.now(ZoneInfo("America/Los_Angeles"))


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def health_for_day(day):
    state = read_json(HEALTH_PATH, {}) or {}
    try:
        stamp = datetime.fromisoformat(state["timestamp"])
        fresh = datetime.now(timezone.utc) - stamp.astimezone(timezone.utc) < timedelta(hours=36)
    except (KeyError, TypeError, ValueError):
        fresh = False
    return state if fresh and state.get("measurement_date") == day else {
        "healthy": False,
        "failure_count": 1,
        "failures": ["tracking health state is missing, stale, or for a different date"],
    }


def build_report(day):
    records = load_registry()
    secrets = load_meta_secrets()
    snapshot = fetch_live_snapshot(records, secrets)
    live_ids = {row["campaign_id"] for row in snapshot if row["effective_status"] == "ACTIVE"}
    campaigns = [row for row in group_registry(records) if row["campaign_id"] in live_ids]
    by_live = {row["campaign_id"]: row for row in snapshot}
    for campaign in campaigns:
        live = by_live[campaign["campaign_id"]]
        campaign["utm_tags"] = live["utm_tags"]
        campaign["destinations"] = live["destinations"]

    meta = meta_metrics(secrets, campaigns, day)
    crm = crm_metrics(DB_PATH, campaigns, day)
    unattributed = unattributed_verified_leads(DB_PATH, day)
    health = health_for_day(day)
    warnings = []
    total_spend = 0.0
    total_sessions = total_taps = total_verified = 0
    lines = []
    for campaign in campaigns:
        cid = campaign["campaign_id"]
        mm, cm = meta[cid], crm[cid]
        total_spend += mm["spend"]
        total_sessions += cm["sessions"]
        total_taps += cm["wa_taps"]
        total_verified += cm["verified_wa_leads"]
        short = campaign["campaign_name"].replace("LPDS — ", "")
        lines.append(
            f"  • *{short}:* ${mm['spend']:.2f} | {mm['link_clicks']} link clicks | "
            f"{mm['landing_page_views']} LPV | {cm['sessions']} CRM sessions | "
            f"{cm['wa_taps']} WA taps | {cm['verified_wa_leads']} verified WA leads"
        )
        if mm["ctr"] and mm["ctr"] < CTR_WARN:
            warnings.append(f"⚠️ {short}: CTR {mm['ctr']:.2f}% < {CTR_WARN}%")
        if mm["cpc"] > CPC_WARN:
            warnings.append(f"⚠️ {short}: CPC ${mm['cpc']:.2f} > ${CPC_WARN:.2f}")
        if mm["frequency"] > FREQ_WARN:
            warnings.append(f"🔄 {short}: frequency {mm['frequency']:.1f}")

    parts = [f"*Daily Paid Social Report — {day}*", ""]
    if not health.get("healthy"):
        parts += [f"🔴 *Tracking integrity failed* ({health.get('failure_count', 1)} issue(s)); performance decisions are blocked.", ""]
    parts += [
        f"*Same-day totals:* ${total_spend:.2f} spend | {total_sessions} CRM sessions | "
        f"{total_taps} WhatsApp taps | {total_verified} verified inbound WhatsApp leads",
        "*By campaign (exact UTM sets):*",
        *lines,
    ]
    if unattributed:
        parts.append(f"  • *Unattributed inbound WhatsApp leads:* {unattributed} (kept separate; never guessed)")
    if warnings:
        parts += ["", "*Meta delivery flags:*", *warnings]
    elif health.get("healthy"):
        parts += ["", "✅ Tracking integrity and Meta delivery thresholds passed"]
    else:
        parts += ["", "Meta delivery thresholds passed; tracking integrity did not."]
    parts += ["", "_WA taps are button clicks. Verified WA leads are actual first inbound conversations._"]
    return "\n".join(parts)


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
    args = parser.parse_args()
    day = args.date or (la_now().date() - timedelta(days=1)).isoformat()
    report = build_report(day)
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
