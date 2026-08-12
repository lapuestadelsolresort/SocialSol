#!/usr/bin/env python3
"""Fixed-catalog adapter for durable paid-media workflow graphs.

This module never accepts a provider URL or arbitrary method. The graph passes
one validated operation, this adapter rechecks the live precondition, performs
at most the catalogued effect, and exposes a separate provider/local readback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from campaign_config import compare_brief_to_live
from campaign_registry import (
    fetch_live_snapshot,
    graph_api,
    graph_post,
    load_meta_secrets,
    load_registry,
    write_registry,
)
from meta_campaign_control import assert_matches, fetch_live_configuration, load_brief, provision

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
REGISTRY_PATH = ROOT / "campaigns/active-campaigns.json"
BRIEF_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,119}$")
VARIANT_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,119}$")
OPERATIONS = {
    "campaign_pause",
    "campaign_budget",
    "campaign_activate",
    "campaign_provision_paused",
    "landing_reweight",
    "landing_status",
}
LANDING_STATUSES = {"draft", "live", "paused", "retired"}


class MarketingWorkflowError(RuntimeError):
    pass


def stable_json(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def stable_hash(value):
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def safe_brief(brief_id):
    value = str(brief_id or "")
    if not BRIEF_ID_RE.fullmatch(value):
        raise MarketingWorkflowError("valid briefId is required")
    path = ROOT / "campaigns" / f"{value}.json"
    if not path.is_file():
        raise MarketingWorkflowError(f"committed campaign brief was not found: {value}")
    brief = load_brief(path)
    if brief.get("brief_id") != value:
        raise MarketingWorkflowError("brief_id in the committed file does not match its filename")
    return path, brief


def record_for_brief(records, brief_id):
    rows = [row for row in records if row.get("brief_id") == brief_id]
    if not rows:
        raise MarketingWorkflowError(f"campaign brief is not registered: {brief_id}")
    campaign_ids = {str(row.get("campaign_id") or "") for row in rows}
    if len(campaign_ids) != 1 or not next(iter(campaign_ids)):
        raise MarketingWorkflowError("campaign brief does not resolve to one registered campaign")
    return rows[0]


def read_variant(slug):
    if not VARIANT_SLUG_RE.fullmatch(str(slug or "")):
        raise MarketingWorkflowError("valid landing variant slug is required")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            """SELECT slug, page_slug, language, source, audience, status, traffic_weight
                 FROM lp_variants WHERE slug=?""",
            (slug,),
        ).fetchone()
        if not row:
            raise MarketingWorkflowError(f"landing variant was not found: {slug}")
        return dict(row)
    finally:
        con.close()


def optimizer_budget_cap():
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT value FROM optimizer_config WHERE key='budget_cap_daily'"
        ).fetchone()
        return float(json.loads(row[0])) if row else 0.0
    except sqlite3.OperationalError:
        return 0.0
    finally:
        con.close()


def normalize_request(request):
    if not isinstance(request, dict):
        raise MarketingWorkflowError("request must be an object")
    operation = str(request.get("operation") or "")
    if operation not in OPERATIONS:
        raise MarketingWorkflowError("unsupported marketing operation")
    reason = str(request.get("reason") or "").strip()
    if len(reason) < 8 or len(reason) > 500:
        raise MarketingWorkflowError("reason must be 8-500 characters")
    normalized = {"operation": operation, "reason": reason}
    if operation.startswith("campaign_"):
        brief_id = str(request.get("briefId") or "")
        if not BRIEF_ID_RE.fullmatch(brief_id):
            raise MarketingWorkflowError("valid briefId is required")
        normalized["briefId"] = brief_id
    if operation == "campaign_budget":
        value = float(request.get("dailyBudgetUsd") or 0)
        if value < 5 or value > 500:
            raise MarketingWorkflowError("dailyBudgetUsd must be from 5 to 500")
        normalized["dailyBudgetUsd"] = round(value, 2)
    if operation.startswith("landing_"):
        slug = str(request.get("slug") or "")
        if not VARIANT_SLUG_RE.fullmatch(slug):
            raise MarketingWorkflowError("valid landing variant slug is required")
        normalized["slug"] = slug
    if operation == "landing_reweight":
        value = request.get("trafficWeight")
        if not isinstance(value, int) or value < 0 or value > 100:
            raise MarketingWorkflowError("trafficWeight must be an integer from 0 to 100")
        normalized["trafficWeight"] = value
    if operation == "landing_status":
        status = str(request.get("status") or "")
        if status not in LANDING_STATUSES:
            raise MarketingWorkflowError("status must be draft, live, paused, or retired")
        normalized["status"] = status
    return normalized


def campaign_preflight(request, records, secrets):
    operation = request["operation"]
    brief_id = request["briefId"]
    brief_path, brief = safe_brief(brief_id)
    brief_hash = stable_hash(brief)
    if operation == "campaign_provision_paused":
        if any(row.get("brief_id") == brief_id for row in records):
            raise MarketingWorkflowError("campaign is already provisioned")
        _, plan = provision(brief, records, secrets, apply=False)
        return {
            "operation": operation,
            "provider": "meta",
            "targetRef": brief_id,
            "briefId": brief_id,
            "campaignId": None,
            "briefPath": str(brief_path.relative_to(ROOT)),
            "briefHash": brief_hash,
            "before": {"registered": False},
            "target": {"configuredStatus": "PAUSED", "plan": plan.get("proposal")},
        }

    record = record_for_brief(records, brief_id)
    if operation == "campaign_pause":
        current = graph_api(
            secrets,
            str(record["campaign_id"]),
            fields="id,name,status,effective_status,daily_budget,objective,updated_time",
        )
        if current.get("status") == "PAUSED":
            raise MarketingWorkflowError("campaign is already paused")
        return {
            "operation": operation,
            "provider": "meta",
            "targetRef": str(record["campaign_id"]),
            "briefId": brief_id,
            "campaignId": str(record["campaign_id"]),
            "briefHash": brief_hash,
            "before": current,
            "target": {"status": "PAUSED"},
        }

    if operation == "campaign_budget":
        object_id = str(
            record.get("budget_object_id")
            or (record.get("campaign_id") if record.get("budget_level") == "campaign" else record.get("adset_id"))
            or ""
        )
        if not object_id:
            raise MarketingWorkflowError("registered campaign has no budget object")
        current = graph_api(secrets, object_id, fields="id,name,status,effective_status,daily_budget,updated_time")
        current_budget = int(current.get("daily_budget") or 0) / 100.0
        target_budget = request["dailyBudgetUsd"]
        if abs(current_budget - target_budget) < 0.005:
            raise MarketingWorkflowError("campaign budget is already at the requested value")
        cap = optimizer_budget_cap()
        projected_total = None
        if target_budget > current_budget:
            live = fetch_live_snapshot(records, secrets)
            active_total = sum(
                float(row.get("daily_budget_usd") or 0)
                for row in live if row.get("effective_status") == "ACTIVE"
            )
            projected_total = round(active_total - current_budget + target_budget, 2)
            if cap <= 0 or projected_total > cap + 0.001:
                raise MarketingWorkflowError(
                    f"budget increase would violate the configured ${cap:.2f} active daily cap"
                )
        return {
            "operation": operation,
            "provider": "meta",
            "targetRef": object_id,
            "briefId": brief_id,
            "campaignId": str(record["campaign_id"]),
            "briefHash": brief_hash,
            "before": {**current, "daily_budget_usd": current_budget},
            "target": {"dailyBudgetUsd": target_budget},
            "budgetCapDailyUsd": cap,
            "projectedActiveBudgetUsd": projected_total,
        }

    if operation == "campaign_activate":
        live = assert_matches(brief, record, secrets=secrets)
        status = live["campaign"].get("status")
        if status == "ACTIVE":
            raise MarketingWorkflowError("campaign is already configured ACTIVE")
        return {
            "operation": operation,
            "provider": "meta",
            "targetRef": str(record["campaign_id"]),
            "briefId": brief_id,
            "campaignId": str(record["campaign_id"]),
            "briefHash": brief_hash,
            "before": {
                "campaign": live["campaign"],
                "configurationHash": stable_hash(live),
            },
            "target": {"status": "ACTIVE"},
        }
    raise MarketingWorkflowError("unsupported campaign operation")


def preflight(request):
    request = normalize_request(request)
    if request["operation"].startswith("campaign_"):
        result = campaign_preflight(request, load_registry(REGISTRY_PATH), load_meta_secrets())
    else:
        current = read_variant(request["slug"])
        field = "traffic_weight" if request["operation"] == "landing_reweight" else "status"
        value = request["trafficWeight"] if field == "traffic_weight" else request["status"]
        if current[field] == value:
            raise MarketingWorkflowError(f"landing variant {field} already has the requested value")
        result = {
            "operation": request["operation"],
            "provider": "crm",
            "targetRef": request["slug"],
            "before": current,
            "target": {field: value},
        }
    return {**result, "request": request}


def assert_preflight(request, expected_hash):
    current = preflight(request)
    actual_hash = stable_hash(current)
    if actual_hash != expected_hash:
        raise MarketingWorkflowError("marketing target changed after approval; create a fresh request")
    return current


def execute(request, expected_hash):
    request = normalize_request(request)
    current = assert_preflight(request, expected_hash)
    operation = request["operation"]
    if operation == "campaign_pause":
        response = graph_post(load_meta_secrets(), current["targetRef"], status="PAUSED")
        return {"accepted": True, "providerRef": current["targetRef"], "response": response}
    if operation == "campaign_budget":
        cents = int(round(request["dailyBudgetUsd"] * 100))
        response = graph_post(load_meta_secrets(), current["targetRef"], daily_budget=cents)
        return {"accepted": True, "providerRef": current["targetRef"], "response": response}
    if operation == "campaign_activate":
        response = graph_post(load_meta_secrets(), current["targetRef"], status="ACTIVE")
        return {"accepted": True, "providerRef": current["targetRef"], "response": response}
    if operation == "campaign_provision_paused":
        _, brief = safe_brief(request["briefId"])
        records = load_registry(REGISTRY_PATH)
        updated, result = provision(brief, records, load_meta_secrets(), apply=True)
        if not result.get("created"):
            raise MarketingWorkflowError("Meta provisioning did not create a new paused campaign")
        write_registry(updated, REGISTRY_PATH)
        return {
            "accepted": True,
            "providerRef": str(result["record"]["campaign_id"]),
            "createdObjectIds": {
                key: result["record"].get(key)
                for key in ("campaign_id", "adset_id", "creative_id", "ad_id")
            },
        }
    if operation.startswith("landing_"):
        field = "traffic_weight" if operation == "landing_reweight" else "status"
        value = request["trafficWeight"] if field == "traffic_weight" else request["status"]
        con = sqlite3.connect(DB_PATH, timeout=20)
        try:
            con.execute("PRAGMA busy_timeout=20000")
            con.execute("BEGIN IMMEDIATE")
            before = con.execute(
                f"SELECT {field} FROM lp_variants WHERE slug=?", (request["slug"],)
            ).fetchone()
            if not before or before[0] != current["before"][field]:
                raise MarketingWorkflowError("landing variant changed before the transaction committed")
            con.execute(f"UPDATE lp_variants SET {field}=? WHERE slug=?", (value, request["slug"]))
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()
        return {"accepted": True, "providerRef": request["slug"], "field": field, "value": value}
    raise MarketingWorkflowError("unsupported marketing operation")


def update_registry_readback(request, readback):
    records = load_registry(REGISTRY_PATH)
    now = datetime.now(timezone.utc).isoformat()
    changed = False
    for record in records:
        if record.get("brief_id") != request.get("briefId"):
            continue
        operation = request["operation"]
        if operation in {"campaign_pause", "campaign_activate"}:
            record["status"] = readback.get("effective_status") or readback.get("status")
            record["meta_status"] = readback.get("status")
            record["meta_effective_status"] = readback.get("effective_status")
            changed = True
        elif operation == "campaign_budget":
            field = "campaign_daily_budget_usd" if record.get("budget_level") == "campaign" else "daily_budget_usd"
            record[field] = request["dailyBudgetUsd"]
            changed = True
        record["meta_reconciled_at"] = now
    if changed:
        write_registry(records, REGISTRY_PATH)


def readback(request):
    request = normalize_request(request)
    operation = request["operation"]
    if operation.startswith("landing_"):
        current = read_variant(request["slug"])
        field = "traffic_weight" if operation == "landing_reweight" else "status"
        expected = request["trafficWeight"] if field == "traffic_weight" else request["status"]
        if current[field] != expected:
            raise MarketingWorkflowError("landing variant readback did not match the requested value")
        return {"verified": True, "providerRef": request["slug"], "readback": current}

    records = load_registry(REGISTRY_PATH)
    record = record_for_brief(records, request["briefId"])
    secrets = load_meta_secrets()
    if operation == "campaign_pause":
        current = graph_api(secrets, str(record["campaign_id"]), fields="id,name,status,effective_status,updated_time")
        if current.get("status") != "PAUSED":
            raise MarketingWorkflowError("Meta readback did not confirm configured PAUSED status")
        update_registry_readback(request, current)
        return {"verified": True, "providerRef": str(record["campaign_id"]), "readback": current}
    if operation == "campaign_budget":
        object_id = str(
            record.get("budget_object_id")
            or (record.get("campaign_id") if record.get("budget_level") == "campaign" else record.get("adset_id"))
            or ""
        )
        current = graph_api(secrets, object_id, fields="id,name,status,effective_status,daily_budget,updated_time")
        actual = int(current.get("daily_budget") or 0) / 100.0
        if abs(actual - request["dailyBudgetUsd"]) >= 0.005:
            raise MarketingWorkflowError("Meta readback did not confirm the requested daily budget")
        current["daily_budget_usd"] = actual
        update_registry_readback(request, current)
        return {"verified": True, "providerRef": object_id, "readback": current}
    if operation == "campaign_activate":
        _, brief = safe_brief(request["briefId"])
        live = fetch_live_configuration(record, secrets=secrets)
        drift = compare_brief_to_live(brief, live, require_active=False)
        if drift or live["campaign"].get("status") != "ACTIVE":
            raise MarketingWorkflowError("Meta activation readback found configuration drift or non-ACTIVE configured status")
        update_registry_readback(request, live["campaign"])
        return {
            "verified": True,
            "providerRef": str(record["campaign_id"]),
            "readback": live,
            "effectiveStatus": live["campaign"].get("effective_status"),
        }
    if operation == "campaign_provision_paused":
        _, brief = safe_brief(request["briefId"])
        live = assert_matches(brief, record, secrets=secrets)
        if live["campaign"].get("status") != "PAUSED":
            raise MarketingWorkflowError("new campaign is not configured PAUSED")
        return {"verified": True, "providerRef": str(record["campaign_id"]), "readback": live}
    raise MarketingWorkflowError("unsupported marketing operation")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("preflight", "execute", "readback"))
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--preflight-hash")
    args = parser.parse_args()
    request = json.loads(args.request_json)
    if args.phase == "preflight":
        result = preflight(request)
        result["preflightHash"] = stable_hash(result)
    elif args.phase == "execute":
        if not args.preflight_hash:
            parser.error("execute requires --preflight-hash")
        result = execute(request, args.preflight_hash)
    else:
        result = readback(request)
    print(stable_json(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(stable_json({"ok": False, "error": str(exc)}), file=os.sys.stderr)
        raise SystemExit(1)
