"""Declared campaign status vs live effective status (F-046).

`status` on a registry record reads as intent. Reporting prefers
`meta_effective_status`, so a row declaring PAUSED while the campaign was live
and spending contradicted reality with nothing to surface it. The reconciler
now marks the divergence on the record and reports it.
"""

import unittest

from campaign_registry import apply_snapshot, status_divergence


def snapshot_row(campaign_id, effective_status, **overrides):
    row = {
        "campaign_id": campaign_id,
        "campaign_name": f"campaign-{campaign_id}",
        "status": effective_status,
        "effective_status": effective_status,
        "active_ad_count": 2,
        "destinations": [],
        "utm_tags": [],
        "daily_budget_usd": 5.0,
    }
    row.update(overrides)
    return row


class StatusDivergenceTests(unittest.TestCase):
    def test_declared_paused_but_live_active_diverges(self):
        self.assertEqual(
            status_divergence("PAUSED", "ACTIVE"),
            {"declared": "PAUSED", "live": "ACTIVE"},
        )

    def test_declared_active_but_live_paused_diverges(self):
        self.assertEqual(
            status_divergence("ACTIVE", "CAMPAIGN_PAUSED"),
            {"declared": "ACTIVE", "live": "CAMPAIGN_PAUSED"},
        )

    def test_agreement_is_not_a_divergence(self):
        self.assertIsNone(status_divergence("ACTIVE", "ACTIVE"))
        self.assertIsNone(status_divergence("PAUSED", "CAMPAIGN_PAUSED"))
        self.assertIsNone(status_divergence("paused", "ADSET_PAUSED"))

    def test_richer_meta_vocabulary_does_not_manufacture_divergence(self):
        # Both non-ACTIVE: different words, same meaning for this check.
        self.assertIsNone(status_divergence("PAUSED", "WITH_ISSUES"))
        self.assertIsNone(status_divergence("ARCHIVED", "IN_PROCESS"))

    def test_unknown_or_missing_values_are_not_divergences(self):
        self.assertIsNone(status_divergence("", "ACTIVE"))
        self.assertIsNone(status_divergence(None, "ACTIVE"))
        self.assertIsNone(status_divergence("PAUSED", "UNKNOWN"))
        self.assertIsNone(status_divergence("PAUSED", ""))


class ApplySnapshotTests(unittest.TestCase):
    def test_divergence_is_recorded_on_the_record(self):
        records = [{"campaign_id": "111", "campaign_name": "weddings", "status": "PAUSED"}]
        updated = apply_snapshot(records, [snapshot_row("111", "ACTIVE")], "2026-08-17T00:00:00Z")
        self.assertEqual(updated[0]["status_divergence"], {
            "declared": "PAUSED", "live": "ACTIVE", "observed_at": "2026-08-17T00:00:00Z",
        })

    def test_divergence_clears_once_reconciled(self):
        records = [{
            "campaign_id": "111", "campaign_name": "weddings", "status": "ACTIVE",
            "status_divergence": {"declared": "PAUSED", "live": "ACTIVE", "observed_at": "old"},
        }]
        updated = apply_snapshot(records, [snapshot_row("111", "ACTIVE")], "2026-08-17T00:00:00Z")
        self.assertNotIn("status_divergence", updated[0])

    def test_records_with_no_live_counterpart_are_untouched(self):
        records = [{"campaign_id": "999", "status": "PAUSED"}]
        updated = apply_snapshot(records, [snapshot_row("111", "ACTIVE")], "2026-08-17T00:00:00Z")
        self.assertEqual(updated[0], records[0])


if __name__ == "__main__":
    unittest.main()
