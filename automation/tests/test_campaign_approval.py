import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import campaign_approval
import meta_campaign_control
from campaign_approval import (
    ApprovalError,
    bind_approval_request,
    record_approval,
    record_landing_approval,
    verify_landing_approval,
    verify_registry_approval,
    verify_slack_message,
)
from campaign_config import stable_brief_hash


def payload(message):
    return {"payload": {"ok": True, "messages": [message]}}


class CampaignApprovalTests(unittest.TestCase):
    def test_request_binding_requires_matching_brief_id(self):
        import campaign_approval
        original = campaign_approval.read_slack_message
        campaign_approval.read_slack_message = lambda *args, **kwargs: payload({
            "ts": "200.1", "bot_id": "B1", "text": "Brief: planner-partner-prospecting",
        })
        try:
            updated = bind_approval_request(
                [{"brief_id": "planner-partner-prospecting"}],
                brief_id="planner-partner-prospecting",
                channel_id="C1",
                request_ts="200.1",
            )
            self.assertEqual(updated[0]["approval_request"]["slack_ts"], "200.1")
        finally:
            campaign_approval.read_slack_message = original

    def test_real_human_thread_reply_is_accepted(self):
        result = verify_slack_message(
            payload({
                "ts": "200.2",
                "thread_ts": "200.1",
                "user": "U-JASON",
                "text": "launch it",
            }),
            slack_ts="200.2",
            approver_user_id="U-JASON",
            request_ts="200.1",
        )
        self.assertEqual(result["quoted_text"], "launch it")

    def test_fake_timestamp_fails(self):
        with self.assertRaisesRegex(ApprovalError, "did not resolve"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-JASON", "text": "go"}),
                slack_ts="999.9",
                approver_user_id="U-JASON",
            )

    def test_wrong_user_fails(self):
        with self.assertRaisesRegex(ApprovalError, "configured approver"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-OTHER", "text": "go"}),
                slack_ts="200.2",
                approver_user_id="U-JASON",
            )

    def test_unrelated_channel_message_fails_thread_binding(self):
        with self.assertRaisesRegex(ApprovalError, "not a reply"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-JASON", "text": "go"}),
                slack_ts="200.2",
                approver_user_id="U-JASON",
                request_ts="200.1",
            )

    def test_bot_message_fails(self):
        with self.assertRaisesRegex(ApprovalError, "bot/app"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-JASON", "text": "go", "bot_id": "B1"}),
                slack_ts="200.2",
                approver_user_id="U-JASON",
            )


BRIEF = {
    "brief_id": "test-camp",
    "campaign_name": "LPDS Test Campaign",
    "objective": "OUTCOME_TRAFFIC",
    "optimization_goal": "LANDING_PAGE_VIEWS",
    "campaign_daily_budget_usd": 5,
    "landing_page_url": "https://example.com/",
    "audience": {"countries": ["US"]},
}


class BriefHashBindingTests(unittest.TestCase):
    """F-001: approval receipts bind to the exact committed brief content."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / "campaigns").mkdir()
        self.brief_path = root / "campaigns" / "test-camp.json"
        self.brief_path.write_text(json.dumps(BRIEF))
        patcher = mock.patch.object(campaign_approval, "ROOT", root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.read_patch = mock.patch.object(
            campaign_approval,
            "read_slack_message",
            lambda *args, **kwargs: payload({
                "ts": "300.2", "thread_ts": "300.1", "user": "U-JASON", "text": "go",
            }),
        )
        self.read_patch.start()
        self.addCleanup(self.read_patch.stop)

    def record(self):
        return record_approval(
            [{"brief_id": "test-camp"}],
            brief_id="test-camp",
            channel_id="C1",
            slack_ts="300.2",
            approver_user_id="U-JASON",
            approved_by="Jason Starkey",
            request_ts="300.1",
        )

    def test_record_binds_the_committed_brief_hash(self):
        [row] = self.record()
        self.assertEqual(row["approval"]["brief_hash"], stable_brief_hash(BRIEF))

    def test_verify_rejects_receipts_without_content_binding(self):
        record = {
            "brief_id": "test-camp",
            "approval": {
                "slack_channel": "C1", "slack_ts": "300.2", "quoted_text": "go",
                "approved_by_user_id": "U-JASON", "approval_request_ts": "300.1",
            },
        }
        with self.assertRaisesRegex(ApprovalError, "lacks a brief content binding"):
            verify_registry_approval(record, channel_id="C1", approver_user_id="U-JASON")

    def test_verify_rejects_receipts_bound_to_other_content(self):
        [row] = self.record()
        edited = dict(BRIEF, campaign_daily_budget_usd=9)
        self.brief_path.write_text(json.dumps(edited))
        with self.assertRaisesRegex(ApprovalError, "binds to different brief content"):
            verify_registry_approval(row, channel_id="C1", approver_user_id="U-JASON")

    def test_verify_accepts_a_current_content_bound_receipt(self):
        [row] = self.record()
        receipt = verify_registry_approval(row, channel_id="C1", approver_user_id="U-JASON")
        self.assertEqual(receipt["brief_hash"], stable_brief_hash(BRIEF))


class LandingApprovalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "crm.db"
        con = sqlite3.connect(self.db_path)
        con.execute(
            """CREATE TABLE lp_variants (
                 slug TEXT PRIMARY KEY, page_slug TEXT, status TEXT, config TEXT,
                 approved_by TEXT, approved_at TEXT,
                 approved_config_hash TEXT, approval_receipt_json TEXT
               )"""
        )
        self.config_text = json.dumps({"hero": "Reviewed hero"})
        con.execute(
            "INSERT INTO lp_variants (slug, page_slug, status, config) VALUES ('variant-a', 'weddings', 'draft', ?)",
            (self.config_text,),
        )
        con.commit()
        con.close()
        self.read_patch = mock.patch.object(
            campaign_approval,
            "read_slack_message",
            lambda *args, **kwargs: payload({
                "ts": "400.2", "thread_ts": "400.1", "user": "U-JASON", "text": "landing approved",
            }),
        )
        self.read_patch.start()
        self.addCleanup(self.read_patch.stop)

    def record(self):
        return record_landing_approval(
            "variant-a",
            channel_id="C1",
            slack_ts="400.2",
            approver_user_id="U-JASON",
            approved_by="Jason Starkey",
            request_ts="400.1",
            db_path=self.db_path,
        )

    def test_record_stores_a_content_bound_receipt(self):
        receipt = self.record()
        self.assertEqual(receipt["config_hash"], campaign_approval.landing_config_hash(self.config_text))
        row = verify_landing_approval("variant-a", approver_user_id="U-JASON", db_path=self.db_path)
        self.assertEqual(row["quoted_text"], "landing approved")

    def test_verify_fails_after_content_edit(self):
        self.record()
        con = sqlite3.connect(self.db_path)
        con.execute(
            "UPDATE lp_variants SET config=? WHERE slug='variant-a'",
            (json.dumps({"hero": "Edited after review"}),),
        )
        con.commit()
        con.close()
        with self.assertRaisesRegex(ApprovalError, "stale"):
            verify_landing_approval("variant-a", approver_user_id="U-JASON", db_path=self.db_path)

    def test_verify_fails_without_any_receipt(self):
        with self.assertRaisesRegex(ApprovalError, "no recorded review approval"):
            verify_landing_approval("variant-a", approver_user_id="U-JASON", db_path=self.db_path)


class CliActivationBindingTests(unittest.TestCase):
    """The CLI activation path refuses stale or unbound approvals before any provider write."""

    def test_activate_refuses_an_unbound_approval_before_any_graph_post(self):
        posts = []
        record = {"brief_id": "test-camp", "campaign_id": "111"}
        with mock.patch.object(
            meta_campaign_control, "verify_registry_approval",
            lambda *a, **k: {"slack_ts": "1.2", "approved_by_user_id": "U-JASON", "quoted_text": "go"},
        ), mock.patch.object(
            meta_campaign_control, "graph_post",
            lambda *a, **k: posts.append(a) or {},
        ):
            with self.assertRaisesRegex(
                meta_campaign_control.CampaignControlError, "review is pending or stale",
            ):
                meta_campaign_control.activate(
                    BRIEF, [record], {},
                    channel_id="C1", approver_user_id="U-JASON", slack_account="acct",
                )
        self.assertEqual(posts, [])

    def test_activate_proceeds_past_the_binding_with_a_current_hash(self):
        record = {"brief_id": "test-camp", "campaign_id": "111"}
        sentinel = RuntimeError("stop-at-assert-matches")
        with mock.patch.object(
            meta_campaign_control, "verify_registry_approval",
            lambda *a, **k: {
                "slack_ts": "1.2", "approved_by_user_id": "U-JASON", "quoted_text": "go",
                "brief_hash": stable_brief_hash(BRIEF),
            },
        ), mock.patch.object(
            meta_campaign_control, "assert_matches",
            mock.Mock(side_effect=sentinel),
        ):
            with self.assertRaises(RuntimeError):
                meta_campaign_control.activate(
                    BRIEF, [record], {},
                    channel_id="C1", approver_user_id="U-JASON", slack_account="acct",
                )


if __name__ == "__main__":
    unittest.main()
