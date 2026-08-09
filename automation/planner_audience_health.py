#!/usr/bin/env python3
"""Report the honest planner retargeting seed after paid-traffic quarantine.

Historical paid sessions remain available to paid-campaign reporting. This
report only removes them from organic/email demand and retargeting readiness.
The quarantine was introduced on 2026-08-09 after a self-seeding loop was
confirmed in the planner website audience.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path

from campaign_registry import load_json

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))


def planner_audience_metrics(db_path, excluded_utm_campaigns, days=180, threshold=100):
    excluded = sorted(set(str(value) for value in excluded_utm_campaigns if value))
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            """SELECT utm_source, utm_medium, utm_campaign, COUNT(*) sessions
               FROM page_sessions
               WHERE is_bot=0 AND page_slug='planners'
                 AND created_at >= datetime('now', ?)
               GROUP BY utm_source, utm_medium, utm_campaign""",
            (f"-{int(days)} days",),
        ).fetchall()
    finally:
        con.close()
    paid = clean = email = organic_or_direct = 0
    groups = []
    for row in rows:
        utm = str(row["utm_campaign"] or "")
        source = str(row["utm_source"] or "")
        medium = str(row["utm_medium"] or "")
        count = int(row["sessions"] or 0)
        quarantined = utm in excluded or medium.lower() == "paid" or source.lower() == "meta"
        if quarantined:
            paid += count
            category = "paid_quarantined"
        else:
            clean += count
            if medium.lower() == "email" or source.lower() == "paulina":
                email += count
                category = "email_clean"
            else:
                organic_or_direct += count
                category = "organic_or_direct_clean"
        groups.append({
            "utm_source": source or None,
            "utm_medium": medium or None,
            "utm_campaign": utm or None,
            "sessions": count,
            "category": category,
        })
    total = paid + clean
    return {
        "window_days": int(days),
        "page_slug": "planners",
        "total_non_bot_sessions": total,
        "paid_sessions_quarantined": paid,
        "paid_share_pct": round(100.0 * paid / total, 1) if total else 0.0,
        "clean_seed_sessions": clean,
        "clean_email_sessions": email,
        "clean_organic_or_direct_sessions": organic_or_direct,
        "reactivation_threshold": int(threshold),
        "reactivation_ready": clean >= int(threshold),
        "excluded_utm_campaigns": excluded,
        "groups": sorted(groups, key=lambda row: (-row["sessions"], row["category"])),
    }


def main():
    parser = argparse.ArgumentParser(description="Clean planner audience readiness report")
    parser.add_argument("--brief", required=True, help="retargeting/shelved brief containing audience exclusions")
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    brief = load_json(args.brief, {})
    audience = brief.get("audience") or {}
    report = planner_audience_metrics(
        args.db,
        audience.get("excluded_utm_campaigns") or [],
        days=args.days,
        threshold=audience.get("reactivation_threshold") or 100,
    )
    if args.json:
        print(json.dumps(report, indent=2))
        return
    ready = "READY" if report["reactivation_ready"] else "SHELVED"
    print(
        f"Planner audience: {report['clean_seed_sessions']} clean / "
        f"{report['paid_sessions_quarantined']} paid quarantined "
        f"({report['paid_share_pct']:.1f}% paid) — {ready} until "
        f"{report['reactivation_threshold']} clean sessions"
    )


if __name__ == "__main__":
    main()
