#!/usr/bin/env python3
"""Reconcile Meta delivery state, destinations, UTMs, and experiment links.

This job is read-only against Meta. It updates the local runtime registry and
measurement ledger so reporting never treats local campaign state as truth.
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

from campaign_registry import (
    REGISTRY_PATH,
    apply_snapshot,
    fetch_live_snapshot,
    load_registry,
    write_registry,
)
from job_health import record

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
JOB_NAME = "resort-marketing-reconcile"

VARIANT_EXPERIMENTS = [
    ("exp-summer-sale-control", "Summer sale control LP", "summer-sale-control-en"),
    ("exp-retreats-challenger-a", "Retreats challenger A LP", "retreats-challenger-a-en"),
]


def campaign_experiments(registry):
    experiments = []
    seen = set()
    for campaign in registry:
        campaign_id = str(campaign.get("campaign_id", "")).strip()
        slug = str(campaign.get("experiment_slug", "")).strip()
        utm = str(campaign.get("utm_campaign", "")).strip()
        if not campaign_id or not slug or not utm:
            raise ValueError(
                "each campaign requires campaign_id, experiment_slug, and utm_campaign"
            )
        if campaign_id in seen:
            continue
        seen.add(campaign_id)
        experiments.append((
            slug,
            campaign.get("campaign_name") or campaign.get("name") or slug,
            campaign_id,
            utm,
        ))
    return experiments


def reconcile(con, experiments, budget_cap_daily_usd):
    for slug, title, campaign_id, utm in experiments:
        con.execute(
            """
            INSERT INTO experiments (
              slug, title, status, kind, bucket, funnel_stage, blast_radius,
              hypothesis, rationale, change_made, primary_metric, guardrail_metrics,
              observation_window, linked_campaign_id, linked_utm_campaign, source, created_by
            ) VALUES (?, ?, 'running', 'meta_campaign', 'leads', 'cta', 'low',
              'Paid traffic should produce attributable WhatsApp leads.',
              'Every active Meta campaign needs one explicit measurement ledger.',
              'Linked the live campaign, UTM, LP session, and WhatsApp lead path.',
              'lead_per_landing_page_view', 'spend,cpc,qualified_rate,wa_click_rate',
              'Review after 100 qualified sessions or 7 days with zero tracked sessions',
              ?, ?, 'reconcile_marketing_state', 'reconcile_job')
            ON CONFLICT(slug) DO UPDATE SET
              status='running', linked_campaign_id=excluded.linked_campaign_id,
              linked_utm_campaign=excluded.linked_utm_campaign, updated_at=datetime('now')
            """,
            (slug, title, campaign_id, utm),
        )

    for slug, title, variant_slug in VARIANT_EXPERIMENTS:
        con.execute(
            """
            INSERT INTO experiments (
              slug, title, status, kind, bucket, funnel_stage, blast_radius,
              hypothesis, rationale, change_made, primary_metric, guardrail_metrics,
              observation_window, linked_variant_slug, source, created_by
            ) VALUES (?, ?, 'running', 'lp_variant', 'leads', 'cta', 'low',
              'Landing-page copy should improve attributable WhatsApp leads.',
              'Every live variant needs an explicit experiment ledger.',
              'Registered the existing live variant without changing traffic weight.',
              'wa_click_per_qualified', 'qualified_rate,lead_rate,booking_rate',
              '100 qualified sessions before promotion or kill decision',
              ?, 'reconcile_marketing_state', 'reconcile_job')
            ON CONFLICT(slug) DO UPDATE SET
              status='running', linked_variant_slug=excluded.linked_variant_slug,
              updated_at=datetime('now')
            """,
            (slug, title, variant_slug),
        )

    con.execute(
        """
        INSERT INTO optimizer_config (key, value, updated_at)
        VALUES ('budget_cap_daily', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
        """,
        (json.dumps(budget_cap_daily_usd),),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    registry_path = os.environ.get("ACTIVE_CAMPAIGNS_PATH", str(REGISTRY_PATH))
    registry = load_registry(registry_path)
    snapshot = fetch_live_snapshot(registry)
    reconciled_at = datetime.now(timezone.utc).isoformat()
    updated_registry = apply_snapshot(registry, snapshot, reconciled_at)
    experiments = campaign_experiments(updated_registry)
    con = sqlite3.connect(DB_PATH, timeout=20)
    try:
        con.execute("PRAGMA busy_timeout=20000")
        row = con.execute(
            "SELECT value FROM optimizer_config WHERE key='budget_cap_daily'"
        ).fetchone()
        try:
            budget_cap_daily_usd = float(json.loads(row[0])) if row else 80
        except (TypeError, ValueError, json.JSONDecodeError):
            budget_cap_daily_usd = 80
        reconcile(con, experiments, budget_cap_daily_usd)
        if args.dry_run:
            con.rollback()
            changed = sum(1 for before, after in zip(registry, updated_registry) if before != after)
            print(json.dumps({
                "dry_run": True,
                "campaigns_seen": len(snapshot),
                "active_campaigns": sum(1 for row in snapshot if row["effective_status"] == "ACTIVE"),
                "registry_records_changed": changed,
                "active_daily_budget_usd": round(sum(
                    row.get("daily_budget_usd") or 0
                    for row in snapshot if row["effective_status"] == "ACTIVE"
                ), 2),
            }, indent=2))
        else:
            write_registry(updated_registry, registry_path)
            con.commit()
            record(JOB_NAME, True, f"{len(snapshot)} campaigns; {sum(1 for row in snapshot if row['effective_status'] == 'ACTIVE')} active")
            print(json.dumps({
                "reconciled_at": reconciled_at,
                "campaigns_seen": len(snapshot),
                "active_campaigns": sum(1 for row in snapshot if row["effective_status"] == "ACTIVE"),
                "active_daily_budget_usd": round(sum(
                    row.get("daily_budget_usd") or 0
                    for row in snapshot if row["effective_status"] == "ACTIVE"
                ), 2),
            }, indent=2))
    finally:
        con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        raise
