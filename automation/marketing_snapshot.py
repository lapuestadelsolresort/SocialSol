#!/usr/bin/env python3
"""Source-backed paid-Meta snapshot and bounded autonomy recommendations."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from campaign_measurement import (
    crm_metrics,
    meta_metrics,
    squarespace_commerce_metrics,
    unattributed_verified_leads,
)
from campaign_registry import backup_registry, fetch_live_snapshot, group_registry, load_meta_secrets, load_registry
from runtime_paths import runtime_state_path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
HEALTH_PATH = runtime_state_path("tracking-health.json")
LA = ZoneInfo("America/Los_Angeles")

CTR_WARN = 0.8
CPC_WARN = 1.5
FREQUENCY_WARN = 3.0
AUTONOMOUS_DECREASE_MIN_SPEND = 20.0
AUTONOMOUS_PAUSE_MIN_SPEND = 40.0
AUTONOMOUS_MAX_DECREASE_FRACTION = 0.20
AUTONOMOUS_MIN_DAILY_BUDGET = 5.0
AUTONOMOUS_MIN_WINDOW_DAYS = 3


def la_today():
    return datetime.now(LA).date()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def health_for_day(day, now=None):
    state = read_json(HEALTH_PATH, {}) or {}
    current = now or datetime.now(timezone.utc)
    try:
        stamp = datetime.fromisoformat(state["timestamp"]).astimezone(timezone.utc)
        fresh = current - stamp < timedelta(hours=36)
    except (KeyError, TypeError, ValueError):
        fresh = False
    if fresh and state.get("measurement_date") == day:
        return state
    return {
        "healthy": False,
        "failure_count": 1,
        "failures": ["tracking health state is missing, stale, or for a different date"],
    }


def delivery_flags(metrics):
    flags = []
    if metrics["ctr"] and metrics["ctr"] < CTR_WARN:
        flags.append({"kind": "low_ctr", "actual": metrics["ctr"], "threshold": CTR_WARN})
    if metrics["cpc"] > CPC_WARN:
        flags.append({"kind": "high_cpc", "actual": metrics["cpc"], "threshold": CPC_WARN})
    if metrics["frequency"] > FREQUENCY_WARN:
        flags.append({"kind": "high_frequency", "actual": metrics["frequency"], "threshold": FREQUENCY_WARN})
    return flags


def inclusive_window_days(start, end):
    return (datetime.strptime(end, "%Y-%m-%d").date() - datetime.strptime(start, "%Y-%m-%d").date()).days + 1


def derive_authorized_actions(campaign, tracking_healthy):
    """Return only actions that may cross the autonomous mutation boundary.

    A snapshot covers three completed local days by default. Tracking must be
    healthy, the campaign must still be active, and conversion evidence must be
    empty. Pausing has the higher bar. Otherwise a single reduction is capped
    at 20% and may never set a daily budget below $5.
    """
    if not tracking_healthy or campaign.get("status") != "ACTIVE":
        return []
    metrics = campaign["meta"]
    crm = campaign["crm"]
    brief_ids = campaign.get("committed_brief_ids") or []
    if not brief_ids or crm["verified_wa_leads"] or crm["wa_taps"]:
        return []
    spend = float(metrics["spend"])
    base = {
        "campaignId": campaign["campaign_id"],
        "briefId": brief_ids[0],
        "evidenceWindow": campaign["window"],
    }
    if spend >= AUTONOMOUS_PAUSE_MIN_SPEND:
        return [{
            **base,
            "action": "pause",
            "reason": (
                f"${spend:.2f} spent in the evidence window with zero WhatsApp taps "
                "and zero verified WhatsApp leads"
            ),
        }]
    inefficient = metrics["cpc"] > CPC_WARN or (metrics["ctr"] and metrics["ctr"] < CTR_WARN)
    budget = campaign.get("daily_budget_usd")
    if spend < AUTONOMOUS_DECREASE_MIN_SPEND or not inefficient or budget is None:
        return []
    target = round(max(AUTONOMOUS_MIN_DAILY_BUDGET, float(budget) * (1 - AUTONOMOUS_MAX_DECREASE_FRACTION)), 2)
    if target >= float(budget):
        return []
    return [{
        **base,
        "action": "budget_decrease",
        "currentDailyBudgetUsd": float(budget),
        "targetDailyBudgetUsd": target,
        "reason": (
            f"${spend:.2f} spent with zero WhatsApp taps/leads and delivery outside "
            f"the CTR/CPC guardrail; reduction capped at {AUTONOMOUS_MAX_DECREASE_FRACTION:.0%}"
        ),
    }]


def build_snapshot(start_day=None, end_day=None):
    end = end_day or (la_today() - timedelta(days=1)).isoformat()
    start = start_day or (datetime.strptime(end, "%Y-%m-%d").date() - timedelta(days=2)).isoformat()
    if datetime.strptime(start, "%Y-%m-%d").date() > datetime.strptime(end, "%Y-%m-%d").date():
        raise ValueError("start day must be on or before end day")

    records = load_registry()
    registry_backup = backup_registry(records)
    secrets = load_meta_secrets()
    live_snapshot = fetch_live_snapshot(records, secrets)
    live_by_id = {
        row["campaign_id"]: row for row in live_snapshot if row["effective_status"] == "ACTIVE"
    }
    groups = [row for row in group_registry(records) if row["campaign_id"] in live_by_id]
    for group in groups:
        live = live_by_id[group["campaign_id"]]
        group["utm_tags"] = live["utm_tags"]
        group["destinations"] = live["destinations"]

    meta = meta_metrics(secrets, groups, start, end)
    crm = crm_metrics(DB_PATH, groups, start, end)
    health = health_for_day(end)
    campaigns = []
    for group in groups:
        campaign_id = group["campaign_id"]
        live = live_by_id[campaign_id]
        brief_ids = sorted({
            str(record.get("brief_id")) for record in group.get("records") or []
            if record.get("brief_id")
        })
        row = {
            "campaign_id": campaign_id,
            "campaign_name": group["campaign_name"],
            "brief_ids": brief_ids,
            "committed_brief_ids": [
                brief_id for brief_id in brief_ids
                if (ROOT / "campaigns" / f"{brief_id}.json").is_file()
            ],
            "status": live["effective_status"],
            "configured_status": live["status"],
            "daily_budget_usd": live.get("daily_budget_usd"),
            "utm_tags": live["utm_tags"],
            "destinations": live["destinations"],
            "active_ad_count": live["active_ad_count"],
            "meta": meta[campaign_id],
            "crm": crm[campaign_id],
            "window": {"start": start, "end": end, "timezone": "America/Los_Angeles"},
        }
        row["delivery_flags"] = delivery_flags(row["meta"])
        campaigns.append(row)

    window_days = inclusive_window_days(start, end)
    autonomy_window_ready = window_days >= AUTONOMOUS_MIN_WINDOW_DAYS
    authorized_actions = []
    if autonomy_window_ready:
        for campaign in campaigns:
            authorized_actions.extend(derive_authorized_actions(campaign, bool(health.get("healthy"))))

    commerce = squarespace_commerce_metrics(DB_PATH, start, end)
    totals = {
        "spend": round(sum(row["meta"]["spend"] for row in campaigns), 2),
        "sessions": sum(row["crm"]["sessions"] for row in campaigns),
        "wa_taps": sum(row["crm"]["wa_taps"] for row in campaigns),
        "verified_wa_leads": sum(row["crm"]["verified_wa_leads"] for row in campaigns),
    }
    generated_at = datetime.now(timezone.utc).isoformat()
    return {
        "generated_at": generated_at,
        "window": {"start": start, "end": end, "timezone": "America/Los_Angeles"},
        "tracking_health": health,
        "campaigns": campaigns,
        "authorized_actions": authorized_actions,
        "autonomy": {
            "ready": autonomy_window_ready,
            "window_days": window_days,
            "minimum_window_days": AUTONOMOUS_MIN_WINDOW_DAYS,
        },
        "totals": totals,
        "unattributed_verified_leads": unattributed_verified_leads(DB_PATH, start, end),
        "squarespace_commerce": commerce,
        "authority": {
            "delivery": "live Meta campaign, ad, destination, and insights APIs",
            "conversion": "CRM page sessions, events, and verified inbound WhatsApp attribution",
            "tracking": "fresh tracking-health state for the final day in the window",
            "registry": {
                "source": "ignored runtime JSON with hashed CRM SQLite recovery copy",
                **registry_backup,
            },
        },
    }


def format_report(snapshot):
    window = snapshot["window"]
    label = window["start"] if window["start"] == window["end"] else f"{window['start']} through {window['end']}"
    totals = snapshot["totals"]
    health = snapshot["tracking_health"]
    parts = [f"*Paid Social Report — {label}*", ""]
    if not health.get("healthy"):
        parts += [
            f"🔴 *Tracking integrity failed* ({health.get('failure_count', 1)} issue(s)); performance decisions are blocked.",
            "",
        ]
    parts += [
        f"*Activity totals:* ${totals['spend']:.2f} spend | {totals['sessions']} CRM sessions | "
        f"{totals['wa_taps']} WhatsApp taps | {totals['verified_wa_leads']} verified inbound WhatsApp leads",
        "*By campaign (exact UTM sets):*",
    ]
    for campaign in snapshot["campaigns"]:
        meta, crm = campaign["meta"], campaign["crm"]
        short = campaign["campaign_name"].replace("LPDS — ", "")
        parts.append(
            f"  • *{short}:* ${meta['spend']:.2f} | {meta['link_clicks']} link clicks | "
            f"{meta['landing_page_views']} LPV | {crm['sessions']} CRM sessions | "
            f"{crm['wa_taps']} WA taps | {crm['verified_wa_leads']} verified WA leads"
        )
    if snapshot["unattributed_verified_leads"]:
        parts.append(
            f"  • *Unattributed inbound WhatsApp leads:* {snapshot['unattributed_verified_leads']} "
            "(kept separate; never guessed)"
        )
    commerce = snapshot["squarespace_commerce"]
    if commerce["available"]:
        parts += [
            "",
            "*Squarespace direct commerce (not campaign-attributed):*",
            f"  • {commerce['orders']} order(s) | ${commerce['collected']:.2f} collected | "
            f"${commerce['fees']:.2f} fees | ${commerce['refunds']:.2f} refunds | "
            f"${commerce['net_after_fees_and_refunds']:.2f} net",
        ]
        if commerce["ownerrez_exceptions"]:
            parts.append(f"  • ⚠️ {commerce['ownerrez_exceptions']} order(s) need OwnerRez link review")
    flags = [
        (campaign["campaign_name"].replace("LPDS — ", ""), flag)
        for campaign in snapshot["campaigns"] for flag in campaign["delivery_flags"]
    ]
    if flags:
        parts += ["", "*Meta delivery flags:*"]
        for name, flag in flags:
            if flag["kind"] == "low_ctr":
                parts.append(f"⚠️ {name}: CTR {flag['actual']:.2f}% < {flag['threshold']:.1f}%")
            elif flag["kind"] == "high_cpc":
                parts.append(f"⚠️ {name}: CPC ${flag['actual']:.2f} > ${flag['threshold']:.2f}")
            else:
                parts.append(f"🔄 {name}: frequency {flag['actual']:.1f}")
    elif health.get("healthy"):
        parts += ["", "✅ Tracking integrity and Meta delivery thresholds passed"]
    else:
        parts += ["", "Meta delivery thresholds passed; tracking integrity did not."]
    if snapshot["authorized_actions"]:
        parts += ["", f"*Bounded autonomous actions currently authorized:* {len(snapshot['authorized_actions'])}"]
        for action in snapshot["authorized_actions"]:
            target = (
                f" → ${action['targetDailyBudgetUsd']:.2f}/day"
                if action["action"] == "budget_decrease" else ""
            )
            parts.append(f"  • {action['briefId']}: {action['action']}{target} — {action['reason']}")
    unmanaged = [row for row in snapshot["campaigns"] if not row["committed_brief_ids"]]
    if unmanaged:
        parts += [
            "",
            f"⚠️ *Autonomy blocked for {len(unmanaged)} live campaign(s):* no committed brief matches the runtime registry.",
        ]
    parts += ["", "_WA taps are button clicks. Verified WA leads are actual first inbound conversations._"]
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--date")
    args = parser.parse_args()
    if args.date and (args.start or args.end):
        parser.error("--date cannot be combined with --start/--end")
    snapshot = build_snapshot(args.date or args.start, args.date or args.end)
    print(json.dumps(snapshot, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
