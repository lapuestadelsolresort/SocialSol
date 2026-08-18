import unittest

from marketing_snapshot import (
    derive_authorized_actions,
    format_commands,
    format_report,
    inclusive_window_days,
)


def campaign(*, spend, budget=10, ctr=1.0, cpc=1.0, taps=0, leads=0, status="ACTIVE"):
    return {
        "campaign_id": "cmp-1",
        "brief_ids": ["brief-one"],
        "committed_brief_ids": ["brief-one"],
        "status": status,
        "daily_budget_usd": budget,
        "window": {"start": "2026-08-09", "end": "2026-08-11"},
        "meta": {"spend": spend, "ctr": ctr, "cpc": cpc},
        "crm": {"wa_taps": taps, "verified_wa_leads": leads},
    }


class MarketingSnapshotAutonomyTests(unittest.TestCase):
    def test_autonomy_window_counts_completed_days_inclusively(self):
        self.assertEqual(inclusive_window_days("2026-08-09", "2026-08-11"), 3)
        self.assertEqual(inclusive_window_days("2026-08-11", "2026-08-11"), 1)

    def test_pause_requires_healthy_tracking_and_zero_conversion_evidence(self):
        actions = derive_authorized_actions(campaign(spend=45), True)
        self.assertEqual(actions[0]["action"], "pause")
        self.assertEqual(actions[0]["campaignId"], "cmp-1")
        self.assertEqual(derive_authorized_actions(campaign(spend=45), False), [])
        self.assertEqual(derive_authorized_actions(campaign(spend=45, taps=1), True), [])
        self.assertEqual(derive_authorized_actions(campaign(spend=45, leads=1), True), [])

    def test_budget_decrease_is_exact_and_capped_at_twenty_percent(self):
        actions = derive_authorized_actions(campaign(spend=25, budget=10, ctr=0.5), True)
        self.assertEqual(actions, [{
            "campaignId": "cmp-1",
            "briefId": "brief-one",
            "evidenceWindow": {"start": "2026-08-09", "end": "2026-08-11"},
            "action": "budget_decrease",
            "currentDailyBudgetUsd": 10.0,
            "targetDailyBudgetUsd": 8.0,
            "reason": "$25.00 spent with zero WhatsApp taps/leads and delivery outside the CTR/CPC guardrail; reduction capped at 20%",
        }])

    def test_no_action_when_delivery_is_efficient_or_campaign_is_not_active(self):
        self.assertEqual(derive_authorized_actions(campaign(spend=25), True), [])
        self.assertEqual(derive_authorized_actions(campaign(spend=45, status="PAUSED"), True), [])


if __name__ == "__main__":
    unittest.main()


class PointOfNeedCommandsTest(unittest.TestCase):
    """F-058: the daily paid report names the controls that act on its own rows."""

    def _snapshot(self, campaigns):
        return {"campaigns": campaigns}

    def test_each_campaign_gets_its_real_id_and_its_brief_drift_check(self):
        lines = format_commands(self._snapshot([
            {
                "campaign_name": "LPDS — Weddings",
                "campaign_id": "120210000000123",
                "committed_brief_ids": ["weddings"],
            },
        ]))
        body = "\n".join(lines)
        self.assertIn("`120210000000123`", body)
        self.assertIn("assert --brief campaigns/weddings.json", body)
        self.assertIn("!meta confirm <request-id> <hash>", body)
        self.assertIn("owner-only", body)
        self.assertIn("`!help`", body)

    def test_a_campaign_with_no_committed_brief_is_told_why_it_is_blocked(self):
        body = "\n".join(format_commands(self._snapshot([
            {
                "campaign_name": "LPDS — Retarget Hot",
                "campaign_id": "120210000000999",
                "committed_brief_ids": [],
            },
        ])))
        self.assertIn("no committed brief", body)
        self.assertNotIn("assert --brief campaigns/.json", body)

    def test_multiple_briefs_each_get_their_own_command(self):
        body = "\n".join(format_commands(self._snapshot([
            {
                "campaign_name": "LPDS — Milestones",
                "campaign_id": "120210000000777",
                "committed_brief_ids": ["milestones", "corporate-retreats"],
            },
        ])))
        self.assertIn("campaigns/milestones.json", body)
        self.assertIn("campaigns/corporate-retreats.json", body)

    def test_a_report_with_no_campaigns_appends_nothing(self):
        self.assertEqual(format_commands(self._snapshot([])), [])

    def test_the_commands_reach_the_rendered_report(self):
        snapshot = {
            "window": {"start": "2026-08-16", "end": "2026-08-16"},
            "totals": {"spend": 40.0, "sessions": 10, "wa_taps": 3, "verified_wa_leads": 1},
            "tracking_health": {"healthy": True},
            "campaigns": [{
                "campaign_name": "LPDS — Weddings",
                "campaign_id": "120210000000123",
                "committed_brief_ids": ["weddings"],
                "delivery_flags": [],
                "meta": {"spend": 40.0, "link_clicks": 12, "landing_page_views": 9},
                "crm": {"sessions": 10, "wa_taps": 3, "verified_wa_leads": 1},
            }],
            "unattributed_verified_leads": 0,
            "squarespace_commerce": {"available": False},
            "authorized_actions": [],
        }
        report = format_report(snapshot)
        self.assertIn("*Commands for these campaigns:*", report)
        self.assertIn("`120210000000123`", report)
        # the trailing definition line stays last so the report still ends on it
        self.assertTrue(report.rstrip().endswith("actual first inbound conversations._"))
