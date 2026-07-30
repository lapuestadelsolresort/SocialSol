#!/usr/bin/env python3
"""Idempotently reconcile campaign/variant experiments and optimizer safety cap."""

import argparse
import json
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))

VARIANT_EXPERIMENTS = [
    ("exp-summer-sale-control", "Summer sale control LP", "summer-sale-control-en"),
    ("exp-retreats-challenger-a", "Retreats challenger A LP", "retreats-challenger-a-en"),
]


def load_campaign_registry():
    registry_path = os.environ.get(
        "ACTIVE_CAMPAIGNS_PATH",
        os.path.join(ROOT, "campaigns", "active-campaigns.json"),
    )
    with open(registry_path, encoding="utf-8") as handle:
        registry = json.load(handle)
    experiments = []
    for campaign in registry.get("campaigns", []):
        campaign_id = str(campaign.get("campaign_id", "")).strip()
        slug = str(campaign.get("experiment_slug", "")).strip()
        utm = str(campaign.get("utm_campaign", "")).strip()
        if not campaign_id or not slug or not utm:
            raise ValueError(
                "each campaign requires campaign_id, experiment_slug, and utm_campaign"
            )
        experiments.append((slug, campaign.get("name") or slug, campaign_id, utm))
    return experiments, registry.get("budget_cap_daily_usd", 80)


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
    experiments, budget_cap_daily_usd = load_campaign_registry()
    con = sqlite3.connect(DB_PATH, timeout=20)
    try:
        con.execute("PRAGMA busy_timeout=20000")
        reconcile(con, experiments, budget_cap_daily_usd)
        if args.dry_run:
            con.rollback()
            print("dry-run: reconciliation SQL completed and rolled back")
        else:
            con.commit()
            print("marketing state reconciled")
    finally:
        con.close()


if __name__ == "__main__":
    main()
