#!/usr/bin/env python3
"""Fail-closed pause recommendation gate backed by live Meta and verified CRM data."""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from campaign_measurement import crm_metrics, meta_metrics
from campaign_registry import fetch_live_snapshot, group_registry, load_meta_secrets, load_registry

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
HEALTH_PATH = ROOT / "state/tracking-health.json"
VERIFICATION_PATH = ROOT / "state/tracking-verification.json"
MIN_VERIFIED_DAYS = 14


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def resolve_campaign(identifier, records, snapshot):
    live_by_id = {row["campaign_id"]: row for row in snapshot}
    for group in group_registry(records):
        live = live_by_id.get(group["campaign_id"])
        if live:
            group["utm_tags"] = live["utm_tags"]
            group["destinations"] = live["destinations"]
            group["status"] = live["effective_status"]
        candidates = {group["campaign_id"], group["campaign_name"], *group["utm_tags"]}
        if identifier in candidates:
            return group
    raise RuntimeError(f"campaign not found: {identifier}")


def freshness(state, hours=36):
    try:
        stamp = datetime.fromisoformat(state["timestamp"])
        return datetime.now(timezone.utc) - stamp.astimezone(timezone.utc) <= timedelta(hours=hours)
    except (KeyError, TypeError, ValueError):
        return False


def evaluate(identifier):
    records = load_registry()
    secrets = load_meta_secrets()
    snapshot = fetch_live_snapshot(records, secrets)
    campaign = resolve_campaign(identifier, records, snapshot)
    cid = campaign["campaign_id"]
    today = datetime.now(ZoneInfo("America/Los_Angeles")).date()
    end_day = (today - timedelta(days=1)).isoformat()
    start_day = (today - timedelta(days=14)).isoformat()
    checks = {}

    try:
        mm = meta_metrics(secrets, [campaign], start_day, end_day)[cid]
        cm = crm_metrics(DB_PATH, [campaign], start_day, end_day)[cid]
        observed = mm["impressions"] > 0 and (mm["link_clicks"] > 0 or mm["landing_page_views"] > 0)
        checks["dual_source"] = {
            "passed": observed,
            "detail": (
                f"queried Meta ({mm['impressions']} impressions, {mm['link_clicks']} link clicks) and CRM "
                f"({cm['sessions']} sessions, {cm['verified_wa_leads']} verified inbound leads)"
                if observed else "Meta returned no actual delivery observations for the 14-day gate window"
            ),
            "meta": mm,
            "crm": cm,
        }
    except Exception as exc:
        checks["dual_source"] = {"passed": False, "detail": f"source query failed: {exc}"}

    health = read_json(HEALTH_PATH, {}) or {}
    campaign_health = (health.get("campaigns") or {}).get(cid, {})
    health_ok = freshness(health) and health.get("healthy") is True and campaign_health.get("healthy") is True
    checks["tracking_healthy"] = {
        "passed": health_ok,
        "detail": (
            f"campaign and infrastructure healthy as of {health.get('timestamp')}"
            if health_ok else "campaign-specific tracking health is failed, missing, or older than 36 hours"
        ),
    }

    verification = read_json(VERIFICATION_PATH, {}) or {}
    verified = (verification.get("campaigns") or {}).get(cid, {})
    try:
        since = datetime.fromisoformat(verified["verified_since"])
        age = datetime.now(timezone.utc) - since.astimezone(timezone.utc)
        age_days = age.total_seconds() / 86400
    except (KeyError, TypeError, ValueError):
        age_days = 0
    age_ok = verified.get("healthy") is True and age_days >= MIN_VERIFIED_DAYS
    checks["verified_age"] = {
        "passed": age_ok,
        "detail": (
            f"{age_days:.1f} continuous days of campaign-specific verified tracking"
            if age_ok else f"only {age_days:.1f}/{MIN_VERIFIED_DAYS} continuous verified tracking days"
        ),
    }

    can_pause = all(check["passed"] for check in checks.values())
    return can_pause, {
        "campaign_id": cid,
        "campaign_name": campaign["campaign_name"],
        "live_status": campaign["status"],
        "utm_tags": campaign["utm_tags"],
        "can_recommend_pause": can_pause,
        "verdict": "SAFE to recommend pause" if can_pause else "BLOCKED — needs investigation first",
        "checks": checks,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", required=True, help="campaign ID, exact name, or any UTM alias")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    allowed, result = evaluate(args.campaign)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if allowed else 1)


if __name__ == "__main__":
    main()
