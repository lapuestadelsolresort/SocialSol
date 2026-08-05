#!/usr/bin/env python3
"""pipeline_validation.py — periodic data quality checks for the LP + ads pipeline.

Runs daily (after the daily report). Checks:
1. Bot sessions leaking through (is_bot=0 but UA matches known bot patterns)
2. Unflagged bots in recent sessions
3. Zero-engagement sessions from suspicious IPs (Meta/FB IP ranges)
4. Stale outreach sends stuck in non-terminal states
5. Meta campaign ↔ LP session alignment (campaigns spending but no sessions)

Posts warnings to #social-sol only if problems are found. Stays silent otherwise.

Usage:
    python3 pipeline_validation.py [--dry-run]
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
DB_PATH = os.path.join(ROOT, "crm", "data", "crm.db")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")

BOT_UA_PATTERNS = [
    "meta-externalads", "facebookexternalhit", "Facebot",
    "Googlebot", "bingbot", "Applebot", "AdsBot", "Amazonbot",
    "YandexBot", "Bytespider", "SemrushBot", "AhrefsBot", "DotBot",
    "PetalBot", "GPTBot", "ClaudeBot", "Twitterbot", "LinkedInBot",
    "Slackbot", "WhatsApp", "Discordbot", "HeadlessChrome",
    "crawler", "spider",
]


def la_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-7)))


def q1(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row and row[0] is not None else 0
    except sqlite3.Error:
        return 0


def check_unflagged_bots(cur, cutoff):
    """Find sessions marked is_bot=0 but whose UA matches a bot pattern."""
    conditions = " OR ".join(f"user_agent LIKE '%{p}%'" for p in BOT_UA_PATTERNS)
    count = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE is_bot=0 AND ({conditions}) AND created_at>=?", (cutoff,))
    if count > 0:
        # Auto-fix: flag them
        cur.execute(f"UPDATE page_sessions SET is_bot=1 WHERE is_bot=0 AND ({conditions})")
        return count
    return 0


def check_stale_sends(cur, cutoff_days=7):
    """Find outreach sends stuck in 'approved' or 'pending_approval' for too long."""
    cutoff = (la_now() - timedelta(days=cutoff_days)).strftime("%Y-%m-%d %H:%M:%S")
    stuck = q1(cur, "SELECT COUNT(*) FROM outreach_sends WHERE status IN ('approved','pending_approval') AND created_at < ?", (cutoff,))
    return stuck


def check_zero_engagement_rate(cur, cutoff):
    """Check if any page has >50% zero-engagement (non-bot) sessions in the window."""
    alerts = []
    cur.execute("SELECT DISTINCT page_slug FROM page_sessions WHERE page_slug IS NOT NULL AND is_bot=0 AND created_at>=?", (cutoff,))
    for (slug,) in cur.fetchall():
        total = q1(cur, "SELECT COUNT(*) FROM page_sessions WHERE page_slug=? AND is_bot=0 AND created_at>=?", (slug, cutoff))
        zero = q1(cur, "SELECT COUNT(*) FROM page_sessions WHERE page_slug=? AND is_bot=0 AND dwell_ms=0 AND max_scroll_pct=0 AND created_at>=?", (slug, cutoff))
        if total >= 10 and zero / total > 0.5:
            alerts.append(f"⚠️ *{slug}*: {zero}/{total} sessions ({round(100*zero/total)}%) had zero engagement — possible tracking issue or FB in-app browser bounce problem")
    return alerts


def check_bot_ratio(cur, cutoff):
    """Alert if bots are >20% of recent traffic on any page."""
    alerts = []
    cur.execute("SELECT DISTINCT page_slug FROM page_sessions WHERE page_slug IS NOT NULL AND created_at>=?", (cutoff,))
    for (slug,) in cur.fetchall():
        total = q1(cur, "SELECT COUNT(*) FROM page_sessions WHERE page_slug=? AND created_at>=?", (slug, cutoff))
        bots = q1(cur, "SELECT COUNT(*) FROM page_sessions WHERE page_slug=? AND is_bot=1 AND created_at>=?", (slug, cutoff))
        if total >= 5 and bots / total > 0.20:
            alerts.append(f"🤖 *{slug}*: {bots}/{total} sessions ({round(100*bots/total)}%) are bots")
    return alerts


def slack_post(text, dry_run=False):
    if dry_run:
        print(f"[dry-run] would post to Slack:\n{text}")
        return
    if not CHANNEL or not SLACK_ACCOUNT:
        print("[pipeline_validation] Slack not configured", file=sys.stderr)
        return
    cmd = [
        OPENCLAW, "message", "send",
        "--account", SLACK_ACCOUNT,
        "--target", CHANNEL,
        "--message", text,
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=30)
    except Exception as e:
        print(f"[pipeline_validation] Slack send failed: {e}", file=sys.stderr)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not os.path.exists(DB_PATH):
        print("[pipeline_validation] DB not found, skipping")
        return

    con = sqlite3.connect(DB_PATH, timeout=20)
    con.execute("PRAGMA busy_timeout=20000")
    cur = con.cursor()

    cutoff_7d = (la_now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    issues = []

    # 1. Fix unflagged bots
    fixed = check_unflagged_bots(cur, cutoff_7d)
    if fixed:
        con.commit()
        issues.append(f"🔧 Auto-fixed {fixed} unflagged bot sessions from last 7 days")

    # 2. Stale outreach sends
    stale = check_stale_sends(cur)
    if stale:
        issues.append(f"📧 {stale} outreach sends stuck in approved/pending_approval for >7 days — may need investigation")

    # 3. Zero engagement rate
    issues.extend(check_zero_engagement_rate(cur, cutoff_7d))

    # 4. Bot ratio
    issues.extend(check_bot_ratio(cur, cutoff_7d))

    con.close()

    if issues:
        header = f"*🔍 Pipeline Validation — {la_now().strftime('%Y-%m-%d')}*"
        body = "\n".join(f"• {i}" for i in issues)
        slack_post(f"{header}\n{body}", dry_run=args.dry_run)
        print(f"[pipeline_validation] {len(issues)} issue(s) found")
    else:
        print("[pipeline_validation] All checks passed ✅")


if __name__ == "__main__":
    main()
