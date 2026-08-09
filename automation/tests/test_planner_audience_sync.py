import json
import tempfile
import unittest
from pathlib import Path

from planner_audience_sync import campaigns_root_for_brief, configured_paid_planner_utms


class PlannerAudienceSyncTests(unittest.TestCase):
    def test_shelved_brief_still_scans_the_whole_campaigns_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            campaigns = Path(temp) / "campaigns"
            shelved = campaigns / "shelved"
            shelved.mkdir(parents=True)
            brief = shelved / "planner-partner-retargeting.json"
            brief.write_text("{}", encoding="utf-8")
            (campaigns / "planner-partner-prospecting.json").write_text(
                json.dumps({
                    "channel": "meta",
                    "page_slug": "planners",
                    "utm_campaign": "planner-prospecting",
                }),
                encoding="utf-8",
            )
            self.assertEqual(campaigns_root_for_brief(brief), campaigns)
            self.assertEqual(
                configured_paid_planner_utms(campaigns),
                ["planner-prospecting"],
            )


if __name__ == "__main__":
    unittest.main()
