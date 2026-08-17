import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import marketing_workflow as mw
from campaign_config import stable_brief_hash


def make_brief(**overrides):
    brief = {
        "brief_id": "test-camp",
        "campaign_name": "LPDS Test Campaign",
        "objective": "OUTCOME_TRAFFIC",
        "optimization_goal": "LANDING_PAGE_VIEWS",
        "campaign_daily_budget_usd": 5,
        "landing_page_url": "https://example.com/?utm_campaign=test",
        "audience": {"countries": ["US"], "expansion": False},
    }
    brief.update(overrides)
    return brief


def approval_for(brief, **overrides):
    receipt = {
        "approved_by": "Jason Starkey",
        "approved_by_user_id": "U-JASON",
        "slack_channel": "C-SOCIAL",
        "slack_ts": "1786313311.860909",
        "quoted_text": "go",
        "brief_hash": stable_brief_hash(brief),
    }
    receipt.update(overrides)
    return receipt


class CampaignReviewInvariantTests(unittest.TestCase):
    """F-001: spend cannot begin while creative/landing review is pending."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "campaigns").mkdir()
        self.brief = make_brief()
        self.write_brief(self.brief)
        self.record = {
            "brief_id": "test-camp",
            "campaign_id": "111",
            "adset_id": "222",
            "ad_id": "333",
            "creative_id": "444",
        }
        self.live = {
            "campaign": {"id": "111", "status": "PAUSED", "effective_status": "PAUSED"},
            "adset": {},
            "ad": {},
            "creative": {},
        }
        self.assert_matches_calls = []
        patchers = [
            mock.patch.object(mw, "ROOT", self.root),
            mock.patch.object(mw, "load_registry", lambda path: [dict(self.record)]),
            mock.patch.object(mw, "load_meta_secrets", lambda: {}),
            mock.patch.object(mw, "assert_matches", self.fake_assert_matches),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_brief(self, brief):
        (self.root / "campaigns" / "test-camp.json").write_text(json.dumps(brief))

    def fake_assert_matches(self, brief, record, secrets=None, require_active=False):
        self.assert_matches_calls.append(record.get("brief_id"))
        return self.live

    def activation_request(self):
        return {
            "operation": "campaign_activate",
            "briefId": "test-camp",
            "reason": "Activate after review approval",
        }

    def test_activation_preflight_blocks_without_any_approval_receipt(self):
        with self.assertRaisesRegex(mw.MarketingWorkflowError, "review is pending"):
            mw.preflight(self.activation_request())
        self.assertEqual(self.assert_matches_calls, [])

    def test_activation_preflight_blocks_when_approval_hashes_other_content(self):
        self.record["approval"] = approval_for(self.brief, brief_hash="0" * 64)
        with self.assertRaisesRegex(mw.MarketingWorkflowError, "review is stale"):
            mw.preflight(self.activation_request())
        self.assertEqual(self.assert_matches_calls, [])

    def test_activation_preflight_blocks_when_brief_changes_after_approval(self):
        self.record["approval"] = approval_for(self.brief)
        edited = make_brief(landing_page_url="https://example.com/?utm_campaign=changed")
        self.write_brief(edited)
        with self.assertRaisesRegex(mw.MarketingWorkflowError, "review is stale"):
            mw.preflight(self.activation_request())
        self.assertEqual(self.assert_matches_calls, [])

    def test_activation_preflight_passes_with_content_bound_approval(self):
        self.record["approval"] = approval_for(self.brief)
        result = mw.preflight(self.activation_request())
        self.assertEqual(result["review"]["state"], "approved")
        self.assertEqual(result["review"]["reviewBriefHash"], stable_brief_hash(self.brief))
        self.assertEqual(result["target"], {"status": "ACTIVE"})
        self.assertEqual(self.assert_matches_calls, ["test-camp"])

    def test_review_hash_ignores_lifecycle_fields_only(self):
        self.assertEqual(
            stable_brief_hash(make_brief()),
            stable_brief_hash(make_brief(status="ACTIVE", activated_at="2026-08-17T00:00:00Z")),
        )
        self.assertNotEqual(
            stable_brief_hash(make_brief()),
            stable_brief_hash(make_brief(campaign_daily_budget_usd=6)),
        )

    def test_execute_reenforces_review_and_never_posts_when_revoked(self):
        self.record["approval"] = approval_for(self.brief)
        preflight = mw.preflight(self.activation_request())
        expected_hash = mw.stable_hash(preflight)
        posts = []
        with mock.patch.object(mw, "graph_post", lambda *a, **k: posts.append((a, k)) or {}):
            del self.record["approval"]
            with self.assertRaisesRegex(mw.MarketingWorkflowError, "review is pending"):
                mw.execute(self.activation_request(), expected_hash)
        self.assertEqual(posts, [])

    def test_execute_posts_activation_when_review_bound(self):
        self.record["approval"] = approval_for(self.brief)
        preflight = mw.preflight(self.activation_request())
        expected_hash = mw.stable_hash(preflight)
        posts = []
        with mock.patch.object(mw, "graph_post", lambda secrets, ref, **k: posts.append((ref, k)) or {"ok": True}):
            result = mw.execute(self.activation_request(), expected_hash)
        self.assertTrue(result["accepted"])
        self.assertEqual(posts, [("111", {"status": "ACTIVE"})])


class ActivationReadbackRollbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "campaigns").mkdir()
        self.brief = make_brief()
        (self.root / "campaigns" / "test-camp.json").write_text(json.dumps(self.brief))
        self.record = {
            "brief_id": "test-camp",
            "campaign_id": "111",
            "adset_id": "222",
            "ad_id": "333",
            "creative_id": "444",
        }
        self.posts = []
        self.registry_writes = []
        patchers = [
            mock.patch.object(mw, "ROOT", self.root),
            mock.patch.object(mw, "load_registry", lambda path: [dict(self.record)]),
            mock.patch.object(mw, "load_meta_secrets", lambda: {}),
            mock.patch.object(mw, "graph_post", lambda secrets, ref, **k: self.posts.append((ref, dict(k))) or {}),
            mock.patch.object(mw, "graph_api", lambda secrets, ref, fields=None: {
                "id": ref, "status": "PAUSED", "effective_status": "PAUSED",
            }),
            mock.patch.object(mw, "write_registry", lambda records, path: self.registry_writes.append(records)),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def readback_request(self):
        return {
            "operation": "campaign_activate",
            "briefId": "test-camp",
            "reason": "Activate after review approval",
        }

    def live(self, name, status):
        return {
            "campaign": {
                "id": "111", "name": name, "status": status,
                "effective_status": status, "daily_budget": 500,
                "objective": "OUTCOME_TRAFFIC",
            },
            "adset": {
                "optimization_goal": "LANDING_PAGE_VIEWS",
                "targeting": {
                    "age_min": 18, "age_max": 65,
                    "geo_locations": {"countries": ["US"]},
                    "publisher_platforms": ["facebook", "instagram"],
                    "targeting_automation": {"advantage_audience": 0},
                    "targeting_relaxation_types": {"custom_audience": 0},
                },
            },
            "ad": {"effective_status": status},
            "creative": {"object_story_spec": {"link_data": {
                "link": "https://example.com/?utm_campaign=test",
            }}},
        }

    def test_drifted_active_campaign_rolls_back_to_paused(self):
        drifted = self.live("Renamed By Someone", "ACTIVE")
        with mock.patch.object(mw, "fetch_live_for_brief", lambda brief, record, secrets=None: drifted):
            with self.assertRaisesRegex(mw.MarketingWorkflowError, "rolled back to PAUSED"):
                mw.readback(self.readback_request())
        self.assertEqual(self.posts, [("111", {"status": "PAUSED"})])
        self.assertEqual(len(self.registry_writes), 1)

    def test_clean_but_inactive_readback_raises_without_second_rollback(self):
        inactive = self.live("LPDS Test Campaign", "PAUSED")
        with mock.patch.object(mw, "fetch_live_for_brief", lambda brief, record, secrets=None: inactive):
            with self.assertRaisesRegex(mw.MarketingWorkflowError, "non-ACTIVE configured status"):
                mw.readback(self.readback_request())
        self.assertEqual(self.posts, [])

    def test_clean_active_readback_verifies_and_updates_registry(self):
        clean = self.live("LPDS Test Campaign", "ACTIVE")
        with mock.patch.object(mw, "fetch_live_for_brief", lambda brief, record, secrets=None: clean):
            result = mw.readback(self.readback_request())
        self.assertTrue(result["verified"])
        self.assertEqual(self.posts, [])
        self.assertEqual(len(self.registry_writes), 1)


class LandingReviewInvariantTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "crm.db"
        con = sqlite3.connect(self.db_path)
        con.execute(
            """CREATE TABLE lp_variants (
                 slug TEXT PRIMARY KEY, page_slug TEXT, language TEXT, source TEXT,
                 audience TEXT, status TEXT, traffic_weight INTEGER, config TEXT,
                 approved_by TEXT, approved_at TEXT,
                 approved_config_hash TEXT, approval_receipt_json TEXT
               )"""
        )
        self.config_text = json.dumps({"hero": "Reviewed hero", "cta": "Book now"})
        con.execute(
            "INSERT INTO lp_variants (slug, page_slug, language, status, traffic_weight, config)"
            " VALUES ('variant-a', 'weddings', 'en', 'paused', 0, ?)",
            (self.config_text,),
        )
        con.commit()
        con.close()
        patcher = mock.patch.object(mw, "DB_PATH", self.db_path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def approve_current_content(self):
        import hashlib
        config_hash = hashlib.sha256(self.config_text.encode("utf-8")).hexdigest()
        con = sqlite3.connect(self.db_path)
        con.execute(
            "UPDATE lp_variants SET approved_config_hash=?, approval_receipt_json=? WHERE slug='variant-a'",
            (config_hash, json.dumps({"slack_ts": "100.1", "approved_by_user_id": "U-JASON"})),
        )
        con.commit()
        con.close()

    def live_request(self):
        return {
            "operation": "landing_status",
            "slug": "variant-a",
            "status": "live",
            "reason": "Serve the reviewed variant",
        }

    def test_going_live_is_blocked_without_recorded_review(self):
        with self.assertRaisesRegex(mw.MarketingWorkflowError, "landing review is pending or stale"):
            mw.preflight(self.live_request())

    def test_going_live_is_blocked_when_content_changed_after_review(self):
        self.approve_current_content()
        con = sqlite3.connect(self.db_path)
        con.execute(
            "UPDATE lp_variants SET config=? WHERE slug='variant-a'",
            (json.dumps({"hero": "Edited after review", "cta": "Book now"}),),
        )
        con.commit()
        con.close()
        with self.assertRaisesRegex(mw.MarketingWorkflowError, "landing review is pending or stale"):
            mw.preflight(self.live_request())

    def test_going_live_succeeds_with_content_bound_review_and_executes(self):
        self.approve_current_content()
        preflight = mw.preflight(self.live_request())
        self.assertTrue(preflight["before"]["review_approved"])
        result = mw.execute(self.live_request(), mw.stable_hash(preflight))
        self.assertTrue(result["accepted"])
        readback = mw.readback(self.live_request())
        self.assertTrue(readback["verified"])

    def test_pausing_a_variant_requires_no_review(self):
        con = sqlite3.connect(self.db_path)
        con.execute("UPDATE lp_variants SET status='live' WHERE slug='variant-a'")
        con.commit()
        con.close()
        pause_request = {
            "operation": "landing_status",
            "slug": "variant-a",
            "status": "paused",
            "reason": "Pause the variant for maintenance",
        }
        preflight = mw.preflight(pause_request)
        self.assertEqual(preflight["target"], {"status": "paused"})


if __name__ == "__main__":
    unittest.main()
