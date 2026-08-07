#!/usr/bin/env python3
"""Pull verified inbound WhatsApp leads from the attribution ledger.

Legacy browser pixel Lead events are excluded because they were button taps,
not actual conversations.

Usage:
    python3 wa_campaign_leads.py [--days 7] [--dry-run]
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))


def la_now():
    return datetime.now(ZoneInfo("America/Los_Angeles"))


def utc_window(day):
    local_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=ZoneInfo("America/Los_Angeles"))
    local_end = local_start + timedelta(days=1)
    return (
        local_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        local_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        print(f"DB not found: {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    today = la_now().date()

    # Yesterday's verified inbound WhatsApp leads. Attribution is sourced from
    # the deterministic ledger, never inferred from a loose time window.
    yesterday = (today - timedelta(days=1)).isoformat()
    y_start, y_end = utc_window(yesterday)

    cur.execute("""
        SELECT ae.lead_id AS id, ae.utm_campaign, ae.created_at
        FROM attribution_events ae
        WHERE ae.event_type='whatsapp_lead'
          AND ae.created_at >= ? AND ae.created_at < ?
        ORDER BY ae.created_at
    """, (y_start, y_end))
    yesterday_leads = [dict(r) for r in cur.fetchall()]

    # 7d WhatsApp leads by campaign
    week_start = (today - timedelta(days=args.days)).isoformat()
    w_start, _ = utc_window(week_start)
    _, w_end = utc_window(yesterday)

    cur.execute("""
        SELECT
            COALESCE(utm_campaign, 'unattributed') as campaign,
            COUNT(DISTINCT lead_id) as leads
        FROM attribution_events
        WHERE event_type='whatsapp_lead'
          AND created_at >= ? AND created_at < ?
        GROUP BY COALESCE(utm_campaign, 'unattributed')
        ORDER BY leads DESC
    """, (w_start, w_end))
    campaign_leads = [dict(r) for r in cur.fetchall()]

    # All-time WhatsApp leads by campaign
    cur.execute("""
        SELECT
            COALESCE(utm_campaign, 'unattributed') as campaign,
            COUNT(DISTINCT lead_id) as leads
        FROM attribution_events
        WHERE event_type='whatsapp_lead'
        GROUP BY COALESCE(utm_campaign, 'unattributed')
        ORDER BY leads DESC
    """)
    alltime = [dict(r) for r in cur.fetchall()]

    con.close()

    result = {
        "date": yesterday,
        "yesterday_wa_leads": len(yesterday_leads),
        "yesterday_leads": yesterday_leads,
        "period_days": args.days,
        "period_wa_leads_by_campaign": campaign_leads,
        "alltime_wa_leads_by_campaign": alltime,
    }

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
