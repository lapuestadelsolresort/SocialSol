#!/usr/bin/env python3
"""Build, apply, and verify the clean planner website-audience rule."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from campaign_config import audience_rule_summary, build_clean_audience_rule
from campaign_registry import graph_api, graph_post, load_json, load_meta_secrets


class AudienceSyncError(RuntimeError):
    pass


def configured_paid_planner_utms(campaigns_dir):
    found = set()
    for path in Path(campaigns_dir).rglob("*.json"):
        data = load_json(path, {})
        if not isinstance(data, dict):
            continue
        if data.get("channel") == "meta" and data.get("page_slug") == "planners" and data.get("utm_campaign"):
            found.add(str(data["utm_campaign"]))
    return sorted(found)


def campaigns_root_for_brief(brief_path):
    brief_path = Path(brief_path)
    return next(
        (parent for parent in (brief_path.parent, *brief_path.parents) if parent.name == "campaigns"),
        brief_path.parent,
    )


def expected_summary(audience):
    return audience_rule_summary(build_clean_audience_rule(audience))


def fetch_audience(secrets, audience_id):
    return graph_api(
        secrets,
        str(audience_id),
        fields="id,name,subtype,retention_days,rule,delivery_status,operation_status",
    )


def assert_audience(audience, live):
    expected = expected_summary(audience)
    actual = audience_rule_summary(live.get("rule") or {})
    drift = []
    if expected != actual:
        drift.append({"field": "audience.rule", "expected": expected, "actual": actual})
    if int(live.get("retention_days") or 0) != int(audience.get("retention_days") or 180):
        drift.append({
            "field": "audience.retention_days",
            "expected": int(audience.get("retention_days") or 180),
            "actual": int(live.get("retention_days") or 0),
        })
    if drift:
        raise AudienceSyncError("planner audience drift:\n" + json.dumps(drift, indent=2))
    return actual


def main():
    parser = argparse.ArgumentParser(description="Synchronize the clean planner pixel audience rule")
    parser.add_argument("action", choices=("plan", "assert", "sync"))
    parser.add_argument("--brief", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    brief_path = Path(args.brief)
    brief = load_json(brief_path, {})
    audience = brief.get("audience") or {}
    campaigns_dir = campaigns_root_for_brief(brief_path)
    configured_utms = configured_paid_planner_utms(campaigns_dir)
    excluded_utms = sorted(set(audience.get("excluded_utm_campaigns") or []))
    missing_exclusions = sorted(set(configured_utms) - set(excluded_utms))
    if missing_exclusions:
        raise AudienceSyncError(
            "audience rule is missing paid planner UTMs: " + ", ".join(missing_exclusions)
        )
    audience_id = audience.get("audience_id") or brief.get("custom_audience_id")
    if not audience_id:
        raise AudienceSyncError("brief audience is missing audience_id")
    rule = build_clean_audience_rule(audience)
    if args.action == "plan":
        print(json.dumps({"audience_id": str(audience_id), "rule": rule}, indent=2))
        return
    secrets = load_meta_secrets()
    if args.action == "sync":
        if not args.apply:
            raise AudienceSyncError("audience sync is a production mutation and requires --apply")
        graph_post(
            secrets,
            str(audience_id),
            rule=rule,
            retention_days=int(audience.get("retention_days") or 180),
        )
    live = fetch_audience(secrets, audience_id)
    summary = assert_audience(audience, live)
    print(json.dumps({"ok": True, "audience_id": str(audience_id), "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
