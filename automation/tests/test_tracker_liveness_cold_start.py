"""Cold-start classification for tracker liveness (F-019).

Zero CRM sessions on a paid destination is only evidence of a tracking
failure when Meta shows the ad actually delivering. Zero impressions was
already a delivery warning; near-zero delivery was still alarming as a capture
failure, which is what both live failures at validation actually were —
1 and 2-4 impressions in seven days while sibling ads took 2,400+.
"""

import importlib.util
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent.parent / "scripts" / "tracker-liveness-test.py"


def load_module():
    spec = importlib.util.spec_from_file_location("tracker_liveness", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ColdStartClassificationTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        directory = Path(tempfile.mkdtemp())
        self.db_path = directory / "crm.db"
        con = sqlite3.connect(self.db_path)
        con.execute(
            """CREATE TABLE page_sessions (
                id TEXT PRIMARY KEY, created_at TEXT, is_bot INTEGER,
                utm_campaign TEXT, utm_source TEXT, landing_path TEXT
            )"""
        )
        con.commit()
        con.close()
        self.module.DB_PATH = self.db_path
        self.now = datetime.now(timezone.utc)
        # Old enough to be past the cold-start grace window.
        self.module.get_ad_created_time = lambda _secrets, _ad_id: self.now - timedelta(days=30)

    def classify(self, impressions):
        self.module.get_ad_impressions_7d = lambda _secrets, _ad_id: impressions
        destinations = [{
            "host": "lapuestadelsolresort.com",
            "url": "https://lapuestadelsolresort.com/lp",
            "utm_campaign": "retarget_video",
            "utm_source": "facebook",
            "ad_id": "1234567890",
        }]
        return self.module.cold_start_check(destinations, {"token": "x"}, self.now)

    def test_zero_impressions_is_a_delivery_warning(self):
        failures, warnings = self.classify(0)
        self.assertEqual(failures, [])
        self.assertEqual([item["type"] for item in warnings], ["no_delivery"])

    def test_near_zero_delivery_is_a_warning_not_a_capture_failure(self):
        for impressions in (1, 4, 19):
            with self.subTest(impressions=impressions):
                failures, warnings = self.classify(impressions)
                self.assertEqual(failures, [], f"{impressions} impressions must not alarm")
                self.assertEqual([item["type"] for item in warnings], ["near_zero_delivery"])
                self.assertIn("not a tracking failure", warnings[0]["message"])

    def test_real_delivery_with_no_sessions_still_alarms(self):
        failures, warnings = self.classify(2500)
        self.assertEqual(warnings, [])
        self.assertEqual([item["type"] for item in failures], ["no_capture"])
        self.assertEqual(failures[0]["impressions_7d"], 2500)

    def test_threshold_boundary_alarms(self):
        failures, _ = self.classify(self.module.MIN_IMPRESSIONS_FOR_CAPTURE_ALARM)
        self.assertEqual([item["type"] for item in failures], ["no_capture"])

    def test_unavailable_delivery_evidence_stays_unclassified(self):
        failures, warnings = self.classify(None)
        self.assertEqual(failures, [])
        self.assertEqual([item["type"] for item in warnings], ["delivery_unknown"])

    def test_a_real_session_clears_the_check_entirely(self):
        con = sqlite3.connect(self.db_path)
        con.execute(
            "INSERT INTO page_sessions (id, created_at, is_bot, utm_campaign, utm_source) VALUES (?,?,?,?,?)",
            ("sess-1", self.now.strftime("%Y-%m-%d %H:%M:%S"), 0, "retarget_video", "facebook"),
        )
        con.commit()
        con.close()
        failures, warnings = self.classify(2500)
        self.assertEqual(failures, [])
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()
