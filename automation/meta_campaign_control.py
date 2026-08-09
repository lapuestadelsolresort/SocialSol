#!/usr/bin/env python3
"""Fail-closed Meta campaign provisioning, assertion, and activation.

Provisioning creates a PAUSED campaign with ACTIVE children, so campaign-level
activation is the only switch that can start spend. Activation requires a live,
re-resolved Slack approval receipt from the runtime campaign registry.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from campaign_approval import ApprovalError, verify_registry_approval
from campaign_config import build_targeting, compare_brief_to_live
from campaign_registry import (
    REGISTRY_PATH,
    graph_api,
    graph_post,
    load_json,
    load_meta_secrets,
    load_registry,
    write_registry,
)

ROOT = Path(__file__).resolve().parent.parent


class CampaignControlError(RuntimeError):
    pass


def atomic_json(path, value):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(value, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def load_brief(path):
    brief = load_json(path, None)
    if not isinstance(brief, dict):
        raise CampaignControlError(f"campaign brief is missing or invalid: {path}")
    required = {
        "brief_id", "campaign_name", "objective", "optimization_goal",
        "campaign_daily_budget_usd", "landing_page_url", "audience",
    }
    missing = sorted(required - set(brief))
    if missing:
        raise CampaignControlError("brief is missing: " + ", ".join(missing))
    return brief


def registry_record(records, brief_id):
    return next((row for row in records if row.get("brief_id") == brief_id), None)


def fetch_live_configuration(record, secrets=None):
    secrets = secrets or load_meta_secrets()
    for field in ("campaign_id", "adset_id", "ad_id", "creative_id"):
        if not record.get(field):
            raise CampaignControlError(f"registry record is missing {field}")
    campaign = graph_api(
        secrets,
        str(record["campaign_id"]),
        fields="id,name,status,effective_status,daily_budget,lifetime_budget,objective,bid_strategy",
    )
    adset = graph_api(
        secrets,
        str(record["adset_id"]),
        fields="id,name,status,effective_status,campaign_id,daily_budget,optimization_goal,bid_strategy,billing_event,targeting",
    )
    ad = graph_api(
        secrets,
        str(record["ad_id"]),
        fields="id,name,status,effective_status,adset_id,creative{id,name}",
    )
    creative = graph_api(
        secrets,
        str(record["creative_id"]),
        fields="id,name,object_story_spec,asset_feed_spec,url_tags",
    )
    return {"campaign": campaign, "adset": adset, "ad": ad, "creative": creative}


def assert_matches(brief, record, secrets=None, require_active=False):
    live = fetch_live_configuration(record, secrets=secrets)
    drift = compare_brief_to_live(brief, live, require_active=require_active)
    if drift:
        raise CampaignControlError("campaign configuration drift:\n" + json.dumps(drift, indent=2))
    return live


def _replace_creative_link(creative, landing_page_url):
    story = json.loads(json.dumps(creative.get("object_story_spec") or {}))
    link_data = story.get("link_data") or {}
    if not link_data:
        raise CampaignControlError("source creative does not have object_story_spec.link_data")
    link_data["link"] = landing_page_url
    story["link_data"] = link_data
    return story


def _new_registry_record(brief, ids):
    audience = brief["audience"]
    return {
        "brief_id": brief["brief_id"],
        "campaign_name": brief["campaign_name"],
        "campaign_id": str(ids["campaign_id"]),
        "adset_id": str(ids["adset_id"]),
        "adset_name": brief.get("adset_name") or f"{brief['campaign_name']} — Ad Set",
        "ad_id": str(ids["ad_id"]),
        "creative_id": str(ids["creative_id"]),
        "status": "PAUSED",
        "bucket": brief.get("bucket", "leads"),
        "page_slug": brief.get("page_slug"),
        "utm_campaign": brief.get("utm_campaign"),
        "utm_content": brief.get("utm_content"),
        "budget_level": brief.get("budget_level", "campaign"),
        "budget_object_id": str(ids["campaign_id"]),
        "campaign_daily_budget_usd": float(brief["campaign_daily_budget_usd"]),
        "experiment_slug": brief.get("experiment_slug"),
        "landing_page_url": brief["landing_page_url"],
        "audience_countries": audience.get("countries") or [],
        "audience_expansion": bool(audience.get("expansion")),
        "objective": brief["objective"],
        "optimization_goal": brief["optimization_goal"],
        "bid_strategy": brief.get("bid_strategy", "LOWEST_COST_WITHOUT_CAP"),
        "replaces_campaign_id": str(brief.get("replaces_campaign_id") or "") or None,
        "replaces_brief_id": brief.get("replaces_brief_id"),
        "notes": brief.get("notes"),
        "provisioned_at": datetime.now(timezone.utc).isoformat(),
    }


def provision(brief, records, secrets, apply=False, resume_ids=None):
    existing = registry_record(records, brief["brief_id"])
    if existing:
        live = assert_matches(brief, existing, secrets=secrets)
        return records, {"created": False, "record": existing, "live": live}
    creative_config = brief.get("creative") or {}
    source_creative_id = creative_config.get("source_creative_id")
    if not source_creative_id and creative_config.get("source_brief_id"):
        source_record = registry_record(records, creative_config["source_brief_id"])
        source_creative_id = source_record.get("creative_id") if source_record else None
    if not source_creative_id:
        raise CampaignControlError("brief creative requires source_creative_id or a registered source_brief_id")
    proposal = {
        "campaign": {
            "name": brief["campaign_name"],
            "objective": brief["objective"],
            "status": "PAUSED",
            "daily_budget": int(round(float(brief["campaign_daily_budget_usd"]) * 100)),
            "bid_strategy": brief.get("bid_strategy", "LOWEST_COST_WITHOUT_CAP"),
            "special_ad_categories": [],
        },
        "adset": {
            "name": brief.get("adset_name") or f"{brief['campaign_name']} — Ad Set",
            "billing_event": brief.get("billing_event", "IMPRESSIONS"),
            "optimization_goal": brief["optimization_goal"],
            "status": "ACTIVE",
            "targeting": build_targeting(brief),
        },
        "creative": {"source_creative_id": str(source_creative_id)},
        "ad": {"name": brief.get("ad_name") or f"{brief['campaign_name']} — Ad", "status": "ACTIVE"},
    }
    if not apply:
        return records, {"created": False, "dry_run": True, "proposal": proposal}

    act = secrets["ad_account_act"]
    ids = {key: str(value) for key, value in (resume_ids or {}).items() if value}
    if not ids.get("campaign_id"):
        campaign = graph_post(secrets, f"{act}/campaigns", **proposal["campaign"])
        ids["campaign_id"] = str(campaign["id"])
    try:
        if not ids.get("adset_id"):
            adset = graph_post(
                secrets,
                f"{act}/adsets",
                campaign_id=ids["campaign_id"],
                **proposal["adset"],
            )
            ids["adset_id"] = str(adset["id"])
        source_creative = graph_api(
            secrets,
            str(source_creative_id),
            fields="id,name,object_story_spec",
        )
        creative = graph_post(
            secrets,
            f"{act}/adcreatives",
            name=brief.get("creative_name") or f"{brief['campaign_name']} — Creative",
            object_story_spec=_replace_creative_link(source_creative, brief["landing_page_url"]),
        )
        ids["creative_id"] = str(creative["id"])
        ad = graph_post(
            secrets,
            f"{act}/ads",
            name=proposal["ad"]["name"],
            adset_id=ids["adset_id"],
            creative={"creative_id": ids["creative_id"]},
            status="ACTIVE",
        )
        ids["ad_id"] = str(ad["id"])
    except Exception as exc:
        try:
            graph_post(secrets, ids["campaign_id"], status="PAUSED")
        except Exception:
            pass
        raise CampaignControlError(
            f"provisioning stopped with campaign {ids['campaign_id']} safely PAUSED: {exc}"
        ) from exc

    record = _new_registry_record(brief, ids)
    updated = [*records, record]
    live = assert_matches(brief, record, secrets=secrets)
    return updated, {"created": True, "record": record, "live": live}


def _update_observed(records, brief_id, live, approval=None):
    updated = []
    for original in records:
        row = dict(original)
        if row.get("brief_id") == brief_id:
            row["status"] = live["campaign"].get("effective_status") or live["campaign"].get("status")
            row["meta_status"] = live["campaign"].get("status")
            row["meta_effective_status"] = live["campaign"].get("effective_status")
            row["meta_reconciled_at"] = datetime.now(timezone.utc).isoformat()
            if approval:
                row["approval"] = approval
        updated.append(row)
    return updated


def activate(brief, records, secrets, *, channel_id, approver_user_id, slack_account):
    record = registry_record(records, brief["brief_id"])
    if not record:
        raise CampaignControlError("campaign must be provisioned before activation")
    try:
        approval = verify_registry_approval(
            record,
            channel_id=channel_id,
            approver_user_id=approver_user_id,
            account=slack_account,
        )
    except ApprovalError as exc:
        raise CampaignControlError(f"activation approval failed: {exc}") from exc
    assert_matches(brief, record, secrets=secrets)
    graph_post(secrets, str(record["campaign_id"]), status="ACTIVE")
    live = fetch_live_configuration(record, secrets=secrets)
    drift = compare_brief_to_live(brief, live, require_active=True)
    if drift:
        status_fields = {
            "campaign.effective_status", "adset.effective_status", "ad.effective_status",
        }
        configuration_drift = [row for row in drift if row.get("field") not in status_fields]
        if configuration_drift:
            graph_post(secrets, str(record["campaign_id"]), status="PAUSED")
            rolled_back = fetch_live_configuration(record, secrets=secrets)
            return _update_observed(records, brief["brief_id"], rolled_back, approval), {
                "cutover_complete": False,
                "reason": "configuration_drift_rolled_back_to_paused",
                "drift": configuration_drift,
                "live": rolled_back,
            }
        # Keep the replaced campaign running. Meta review can make child status
        # temporarily non-ACTIVE; a later activation/finalization run is safe.
        return _update_observed(records, brief["brief_id"], live, approval), {
            "cutover_complete": False,
            "reason": "replacement_not_fully_active",
            "drift": drift,
            "live": live,
        }

    replaced_id = str(brief.get("replaces_campaign_id") or "")
    if not replaced_id and brief.get("replaces_brief_id"):
        replaced = registry_record(records, brief["replaces_brief_id"])
        replaced_id = str((replaced or {}).get("campaign_id") or "")
    if replaced_id:
        graph_post(secrets, replaced_id, status="PAUSED")
    updated = _update_observed(records, brief["brief_id"], live, approval)
    for row in updated:
        if replaced_id and str(row.get("campaign_id") or "") == replaced_id:
            row["status"] = "RETIRED"
            row["meta_status"] = "PAUSED"
            row["retired_at"] = datetime.now(timezone.utc).isoformat()
            row["retired_reason"] = f"replaced_by:{brief['brief_id']}"
    return updated, {"cutover_complete": True, "replaced_campaign_id": replaced_id, "live": live}


def main():
    parser = argparse.ArgumentParser(description="Provision/assert/activate a brief-driven Meta campaign")
    parser.add_argument("action", choices=("plan", "provision", "assert", "activate"))
    parser.add_argument("--brief", required=True)
    parser.add_argument("--registry", default=str(REGISTRY_PATH))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--channel-id", default=os.environ.get("RESORT_SOCIAL_CHANNEL", ""))
    parser.add_argument("--approver-user-id", default=os.environ.get("CAMPAIGN_APPROVER_SLACK_USER_ID", ""))
    parser.add_argument("--slack-account", default=os.environ.get("OPENCLAW_SLACK_ACCOUNT", ""))
    parser.add_argument("--resume-campaign-id")
    parser.add_argument("--resume-adset-id")
    args = parser.parse_args()
    brief_path = Path(args.brief)
    brief = load_brief(brief_path)
    records = load_registry(args.registry)
    secrets = load_meta_secrets()

    if args.action in ("plan", "provision"):
        updated, result = provision(
            brief,
            records,
            secrets,
            apply=args.apply and args.action == "provision",
            resume_ids={
                "campaign_id": args.resume_campaign_id,
                "adset_id": args.resume_adset_id,
            },
        )
        if result.get("created"):
            write_registry(updated, args.registry)
        print(json.dumps(result, indent=2))
        return
    record = registry_record(records, brief["brief_id"])
    if not record:
        raise CampaignControlError(f"brief_id {brief['brief_id']!r} is not registered")
    if args.action == "assert":
        live = assert_matches(brief, record, secrets=secrets)
        print(json.dumps({"ok": True, "live": live}, indent=2))
        return
    if not args.apply:
        raise CampaignControlError("activation is a production mutation and requires --apply")
    if not args.channel_id or not args.approver_user_id or not args.slack_account:
        raise CampaignControlError("activation requires configured Slack channel, approver, and account")
    updated, result = activate(
        brief,
        records,
        secrets,
        channel_id=args.channel_id,
        approver_user_id=args.approver_user_id,
        slack_account=args.slack_account,
    )
    write_registry(updated, args.registry)
    if result.get("cutover_complete"):
        active_brief = dict(brief)
        active_brief["status"] = "ACTIVE"
        active_brief["activated_at"] = datetime.now(timezone.utc).isoformat()
        atomic_json(brief_path, active_brief)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
