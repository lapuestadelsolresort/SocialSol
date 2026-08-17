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


def multi_ad_brief_fixture():
    brief = brief_fixture()
    del brief["landing_page_url"]
    brief["campaign_name"] = "LPDS — Weddings"
    brief["ads"] = [
        {"ad_name": "Wedding — Aspirational", "landing_page_url": "https://weddings.example/?utm_content=w1"},
        {"ad_name": "Video — Pier Walk", "landing_page_url": "https://weddings.example/?utm_content=pier"},
    ]
    return brief


def multi_ad_matching_live(brief):
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
        "ads": [
            {"id": "a1", "effective_status": "ACTIVE", "creative": {"id": "c1"}},
            {"id": "a2", "effective_status": "ACTIVE", "creative": {"id": "c2"}},
        ],
        "creatives": [
            {"object_story_spec": {"link_data": {"link": brief["ads"][0]["landing_page_url"]}}},
            {"object_story_spec": {"link_data": {"link": brief["ads"][1]["landing_page_url"]}}},
        ],
    }


class MultiAdComparatorTests(unittest.TestCase):
    def test_matching_multi_ad_campaign_has_no_drift(self):
        brief = multi_ad_brief_fixture()
        live = multi_ad_matching_live(brief)
        self.assertEqual(compare_brief_to_live(brief, live, require_active=True), [])

    def test_explicit_empty_platforms_and_absent_advantage_flag_match_unrestricted_live(self):
        brief = multi_ad_brief_fixture()
        brief["audience"]["publisher_platforms"] = []
        live = multi_ad_matching_live(brief)
        live["adset"]["targeting"].pop("publisher_platforms", None)
        live["adset"]["targeting"].pop("targeting_automation", None)
        self.assertEqual(compare_brief_to_live(brief, live), [])
        live["adset"]["targeting"]["targeting_automation"] = {"advantage_audience": 1}
        fields = {row["field"] for row in compare_brief_to_live(brief, live)}
        self.assertEqual(fields, {"targeting.advantage_audience"})

    def test_region_targeted_brief_compares_region_keys(self):
        brief = multi_ad_brief_fixture()
        del brief["audience"]["countries"]
        brief["audience"]["regions"] = [
            {"key": "3843", "name": "Alabama", "country": "US"},
            {"key": "3847", "name": "California", "country": "US"},
        ]
        live = multi_ad_matching_live(brief)
        self.assertEqual(compare_brief_to_live(brief, live), [])
        live["adset"]["targeting"]["geo_locations"]["regions"] = [{"key": "3843"}]
        fields = {row["field"] for row in compare_brief_to_live(brief, live)}
        self.assertEqual(fields, {"targeting.regions"})

    def test_extra_live_ad_and_foreign_link_are_drift(self):
        brief = multi_ad_brief_fixture()
        live = multi_ad_matching_live(brief)
        live["ads"].append({"id": "a3", "effective_status": "ACTIVE", "creative": {"id": "c3"}})
        live["creatives"].append(
            {"object_story_spec": {"link_data": {"link": "https://unreviewed.example/"}}}
        )
        fields = {row["field"] for row in compare_brief_to_live(brief, live)}
        self.assertEqual(fields, {"adset.ad_count", "creative.links"})

    def test_inactive_child_ad_blocks_require_active(self):
        brief = multi_ad_brief_fixture()
        live = multi_ad_matching_live(brief)
        live["ads"][1]["effective_status"] = "PAUSED"
        fields = {row["field"] for row in compare_brief_to_live(brief, live, require_active=True)}
        self.assertEqual(fields, {"ad.a2.effective_status"})


if __name__ == "__main__":
    unittest.main()
