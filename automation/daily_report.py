#!/usr/bin/env python3
"""Post or print the resort LP optimizer daily report."""

import argparse
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from job_health import get_status, record

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
QUALIFIED = "(max_scroll_pct > 0 OR reached_cta = 1 OR dwell_ms >= 10000)"
# Use the is_bot column (set at ingest by track.js / lp.js) instead of
# long UA-string matching.  Faster, consistent across all scripts, and
# the ingest bot-list is the single source of truth.
BOT_FILTER = "is_bot=0"
JOB_NAME = "resort-daily-report"


def la_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-7)))


def report_date(arg_date):
    return arg_date or (la_now() - timedelta(days=1)).strftime("%Y-%m-%d")


def utc_window(day):
    local_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=ZoneInfo("America/Los_Angeles"))
    local_end = local_start + timedelta(days=1)
    return (
        local_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        local_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    )


def q1(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row and row[0] is not None else 0
    except sqlite3.Error:
        return 0


def qall(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    except sqlite3.Error:
        return []


def pct(num, den):
    return f"{(100.0 * num / den):.1f}%" if den else "-"


def build_report(db_path, day):
    start_utc, end_utc = utc_window(day)
    if not os.path.exists(db_path):
        return f"*Resort LP daily report - {day}*\n(no database found at {db_path})"

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cur = con.cursor()
    window = (start_utc, end_utc)
    human = f"created_at>=? AND created_at<? AND {BOT_FILTER}"
    sessions = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {human}", window)
    qualified = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {human} AND {QUALIFIED}", window)
    reached_cta = q1(cur, f"SELECT COALESCE(SUM(reached_cta),0) FROM page_sessions WHERE {human}", window)
    wa_clicks = q1(cur, f"SELECT COALESCE(SUM(cta_clicked),0) FROM page_sessions WHERE {human}", window)
    leads = q1(cur, "SELECT COUNT(*) FROM leads WHERE created_at>=? AND created_at<?", window)
    booked = q1(cur, "SELECT COUNT(*) FROM leads WHERE status='booked' AND created_at>=? AND created_at<?", window)
    attributed_leads = q1(
        cur,
        "SELECT COUNT(DISTINCT l.id) FROM leads l JOIN page_sessions ps ON ps.lead_id=l.id "
        "WHERE l.created_at>=? AND l.created_at<?",
        window,
    )
    per_page = qall(
        cur,
        "SELECT COALESCE(page_slug,'unknown'), COUNT(*), "
        f"COALESCE(SUM(CASE WHEN {QUALIFIED} THEN 1 ELSE 0 END),0), "
        "COALESCE(SUM(reached_cta),0), COALESCE(SUM(cta_clicked),0) "
        f"FROM page_sessions WHERE {human} "
        "GROUP BY COALESCE(page_slug,'unknown') ORDER BY 1",
        window,
    )
    due = qall(
        cur,
        "SELECT slug, review_at, primary_metric FROM experiments "
        "WHERE status='running' AND review_at IS NOT NULL AND review_at<=? ORDER BY review_at",
        (day,),
    )
    con.close()

    lines = [f"*Resort LP daily report - {day}*"]
    lines.append(
        f"- Sessions: {sessions}  Qualified: {qualified} ({pct(qualified, sessions)})\n"
        f"- CTA reached: {reached_cta}  WhatsApp clicks: {wa_clicks} ({pct(wa_clicks, qualified or sessions)})\n"
        f"- Leads: {leads}  LP-attributed leads: {attributed_leads}  Booked: {booked}"
    )
    if per_page:
        lines.append("- By page (sessions / qualified / CTA / WhatsApp):")
        for page, s, q, cta, click in per_page:
            lines.append(f"  - {page}: {s} / {q} / {cta} / {click}")
    if due:
        lines.append("- Reviews due:")
        for slug, review_at, metric in due:
            lines.append(f"  - {slug}: {metric} due {review_at}")
    else:
        lines.append("- Reviews due: none")
    return "\n".join(lines)


def post_to_slack(message):
    if not CHANNEL or not SLACK_ACCOUNT:
        sys.stderr.write("daily_report: Slack integration is not configured\n")
        return False
    try:
        subprocess.run(
            [OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
             "--target", f"channel:{CHANNEL}", "--message", message, "--json"],
            check=True,
            timeout=30,
            capture_output=True,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        sys.stderr.write(f"daily_report: Slack post failed: {e}\n")
        return False


def main():
    ap = argparse.ArgumentParser(description="Resort LP daily report")
    ap.add_argument("--date")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    day = report_date(args.date)
    report = build_report(DB_PATH, day)
    if args.dry_run:
        print(report)
        return
    previous = get_status(JOB_NAME)
    if previous.get("status") == "ok" and previous.get("detail") == day:
        print(f"daily_report: {day} already posted")
        return
    if not post_to_slack(report):
        record(JOB_NAME, False, day)
        sys.exit(1)
    record(JOB_NAME, True, day)


if __name__ == "__main__":
    main()
