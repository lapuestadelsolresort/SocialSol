import unittest

from marketing_snapshot import derive_authorized_actions, inclusive_window_days


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
