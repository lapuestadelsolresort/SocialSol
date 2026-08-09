import unittest

from campaign_config import (
    audience_rule_summary,
    build_clean_audience_rule,
    build_targeting,
    compare_brief_to_live,
)
from campaign_registry import apply_snapshot
from planner_audience_sync import configured_paid_planner_utms


def brief_fixture():
    return {
        "campaign_name": "LPDS — Planners — Partner Prospecting",
        "objective": "OUTCOME_TRAFFIC",
        "optimization_goal": "LANDING_PAGE_VIEWS",
        "campaign_daily_budget_usd": 5,
        "landing_page_url": "https://planners.example/?utm_campaign=planner-prospecting",
        "audience": {
            "countries": ["US", "CA"],
            "age_min": 25,
            "age_max": 65,
            "publisher_platforms": ["facebook", "instagram"],
            "interests": [{"id": "i1", "name": "Wedding Planners"}],
            "work_positions": [{"id": "w1", "name": "Wedding planner"}],
            "custom_audience_ids": [],
            "expansion": False,
        },
    }


def matching_live(brief):
    return {
        "campaign": {
            "name": brief["campaign_name"],
            "objective": brief["objective"],
            "daily_budget": "500",
            "effective_status": "ACTIVE",
        },
        "adset": {
            "optimization_goal": brief["optimization_goal"],
            "effective_status": "ACTIVE",
            "targeting": build_targeting(brief),
        },
        "ad": {"effective_status": "ACTIVE"},
        "creative": {"object_story_spec": {"link_data": {"link": brief["landing_page_url"]}}},
    }


class CampaignConfigTests(unittest.TestCase):
    def test_paid_planner_utm_discovery_ignores_non_brief_json(self):
        import json
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "planner.json").write_text(json.dumps({
                "channel": "meta", "page_slug": "planners", "utm_campaign": "planner-paid",
            }))
            (root / "other.json").write_text(json.dumps({
                "channel": "meta", "page_slug": "weddings", "utm_campaign": "weddings-paid",
            }))
            (root / "array.json").write_text("[]")
            self.assertEqual(configured_paid_planner_utms(root), ["planner-paid"])

    def test_reconciliation_preserves_declared_status(self):
        records = [{"campaign_id": "1", "status": "PAUSED", "utm_campaign": "x"}]
        snapshot = [{
            "campaign_id": "1", "status": "ACTIVE", "effective_status": "ACTIVE",
            "active_ad_count": 1, "destinations": [], "utm_tags": ["x"],
            "daily_budget_usd": 5,
        }]
        [updated] = apply_snapshot(records, snapshot, "2026-08-09T00:00:00Z")
        self.assertEqual(updated["status"], "PAUSED")
        self.assertEqual(updated["meta_effective_status"], "ACTIVE")

    def test_matching_campaign_has_no_drift(self):
        brief = brief_fixture()
        self.assertEqual(compare_brief_to_live(brief, matching_live(brief), require_active=True), [])

    def test_custom_audience_relaxation_and_inclusion_are_drift(self):
        brief = brief_fixture()
        live = matching_live(brief)
        live["adset"]["targeting"]["custom_audiences"] = [{"id": "old-pixel-audience"}]
        live["adset"]["targeting"]["targeting_relaxation_types"] = {"custom_audience": 1}
        fields = {row["field"] for row in compare_brief_to_live(brief, live)}
        self.assertIn("targeting.custom_audiences", fields)
        self.assertIn("targeting.custom_audience_relaxation", fields)

    def test_budget_country_and_creative_drift_are_detected(self):
        brief = brief_fixture()
        live = matching_live(brief)
        live["campaign"]["daily_budget"] = "700"
        live["adset"]["targeting"]["geo_locations"]["countries"] = ["US"]
        live["creative"]["object_story_spec"]["link_data"]["link"] = "https://wrong.example/"
        fields = {row["field"] for row in compare_brief_to_live(brief, live)}
        self.assertEqual(
            fields,
            {"campaign.daily_budget_cents", "targeting.countries", "creative.links"},
        )

    def test_clean_audience_rule_contains_paid_utm_exclusions(self):
        audience = {
            "pixel_id": "123",
            "retention_days": 180,
            "url_contains": "planners.example",
            "excluded_utm_campaigns": ["planner-retarget", "planner-prospecting"],
        }
        summary = audience_rule_summary(build_clean_audience_rule(audience))
        self.assertEqual(summary["included_urls"], ["planners.example"])
        self.assertEqual(
            summary["excluded_urls"],
            ["utm_campaign=planner-prospecting", "utm_campaign=planner-retarget"],
        )


if __name__ == "__main__":
    unittest.main()
