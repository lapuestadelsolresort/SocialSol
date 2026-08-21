"""Brief-shape dispatch in the tracking-health configuration check (F-071).

From 2026-08-18 the daily tracking-health control was red for every brief
committed under F-045 ("registry record is missing ad_id") and, because the
autonomous Meta pause/decrease gate reads that state, the safety net could not
act. Multi-ad briefs describe campaign/adset-level registry rows that carry no
ad_id/creative_id by design; the configuration check must resolve their ad
population from the adset, exactly as the mutation gate already does, while a
single-ad brief keeps the exact ad/creative comparison and its fail-closed
error.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "tracking-health-check.py"
sys.path.insert(0, str(ROOT / "automation"))

import meta_campaign_control  # noqa: E402


def load_module():
    spec = importlib.util.spec_from_file_location("tracking_health_check", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MULTI_AD_BRIEF = {
    "brief_id": "retarget-test",
    "campaign_name": "Test — Retargeting",
    "objective": "OUTCOME_LEADS",
    "optimization_goal": "LINK_CLICKS",
    "campaign_daily_budget_usd": 10,
    "audience": {"countries": ["US"]},
    "ads": [
        {"landing_page_url": "https://example.com/a"},
        {"landing_page_url": "https://example.com/b"},
    ],
}

SINGLE_AD_BRIEF = {
    "brief_id": "single-test",
    "campaign_name": "Test — Single",
    "objective": "OUTCOME_LEADS",
    "optimization_goal": "LINK_CLICKS",
    "campaign_daily_budget_usd": 10,
    "audience": {"countries": ["US"]},
    "landing_page_url": "https://example.com/a",
}

RECORD_WITHOUT_AD = {"brief_id": "retarget-test", "campaign_id": "111", "adset_id": "222"}
SECRETS = {"access_token": "test-token", "ad_account_act": "act_test"}


class FetchLiveForBriefDispatchTests(unittest.TestCase):
    """The shared dispatcher the check now uses."""

    def setUp(self):
        self.calls = []
        self.original = meta_campaign_control.graph_api

        def fake_graph_api(secrets, path, fields=None, **kwargs):
            self.calls.append(path)
            if path.endswith("/ads"):
                return {"data": [
                    {"id": "a1", "creative": {"id": "c1"}},
                    {"id": "a2", "creative": {"id": "c2"}},
                ]}
            return {"id": path, "name": "live", "targeting": {}}

        meta_campaign_control.graph_api = fake_graph_api

    def tearDown(self):
        meta_campaign_control.graph_api = self.original

    def test_multi_ad_brief_resolves_ads_from_the_adset_without_ad_id(self):
        live = meta_campaign_control.fetch_live_for_brief(MULTI_AD_BRIEF, RECORD_WITHOUT_AD, secrets=SECRETS)
        self.assertIn("222/ads", self.calls)
        self.assertEqual(len(live["ads"]), 2)
        self.assertEqual(len(live["creatives"]), 2)
        self.assertNotIn("ad", live)

    def test_single_ad_brief_still_fails_closed_without_ad_id(self):
        with self.assertRaises(meta_campaign_control.CampaignControlError) as ctx:
            meta_campaign_control.fetch_live_for_brief(
                SINGLE_AD_BRIEF, {"brief_id": "single-test", "campaign_id": "111", "adset_id": "222"}, secrets=SECRETS,
            )
        self.assertIn("registry record is missing ad_id", str(ctx.exception))
        self.assertEqual(self.calls, [])


class ConfigurationChecksTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.briefs_dir = Path(tempfile.mkdtemp())
        (self.briefs_dir / "retarget-test.json").write_text(json.dumps(MULTI_AD_BRIEF))
        (self.briefs_dir / "single-test.json").write_text(json.dumps(SINGLE_AD_BRIEF))

    def test_live_multi_ad_brief_is_verified_through_the_brief_shaped_fetcher(self):
        seen = []

        def fetch_live(brief, record, secrets=None):
            seen.append((brief["brief_id"], record.get("ad_id")))
            return {"campaign": {}, "adset": {}, "ads": [], "creatives": []}

        self.module.compare_brief_to_live = lambda brief, live: []
        failures, infra = self.module.configuration_checks(
            [RECORD_WITHOUT_AD, {"brief_id": "paused", "campaign_id": "999", "adset_id": "998"}],
            live={"111": {"effective_status": "ACTIVE"}},
            secrets={},
            fetch_live=fetch_live,
            briefs_dir=self.briefs_dir,
        )
        self.assertEqual(failures, [])
        self.assertEqual(infra, [{"name": "campaign_configuration", "brief_id": "retarget-test", "ok": True}])
        self.assertEqual(seen, [("retarget-test", None)])

    def test_fetch_error_is_reported_per_brief_not_raised(self):
        def fetch_live(brief, record, secrets=None):
            raise meta_campaign_control.CampaignControlError("registry record is missing ad_id")

        failures, infra = self.module.configuration_checks(
            [{"brief_id": "single-test", "campaign_id": "111", "adset_id": "222"}],
            live={"111": {"effective_status": "ACTIVE"}},
            secrets={},
            fetch_live=fetch_live,
            briefs_dir=self.briefs_dir,
        )
        self.assertEqual(
            failures,
            ["campaign configuration could not be verified: single-test: registry record is missing ad_id"],
        )
        self.assertFalse(infra[0]["ok"])

    def test_default_fetcher_is_the_shared_brief_shape_dispatcher(self):
        self.assertIs(
            self.module.configuration_checks.__defaults__[0],
            meta_campaign_control.fetch_live_for_brief,
        )


if __name__ == "__main__":
    unittest.main()
