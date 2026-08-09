import sqlite3
import tempfile
import unittest
from pathlib import Path

from planner_audience_health import planner_audience_metrics


class PlannerAudienceHealthTests(unittest.TestCase):
    def test_paid_sessions_are_quarantined_but_email_is_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "test.db"
            con = sqlite3.connect(db)
            con.execute(
                """CREATE TABLE page_sessions (
                     page_slug TEXT, is_bot INTEGER, created_at TEXT,
                     utm_source TEXT, utm_medium TEXT, utm_campaign TEXT)"""
            )
            rows = [
                ("planners", 0, "meta", "paid", "planner-retarget"),
                ("planners", 0, "meta", "paid", "planner-prospecting"),
                ("planners", 0, "paulina", "email", "planner_partner_program_v1"),
                ("planners", 0, None, None, None),
                ("planners", 1, None, None, None),
                ("weddings", 0, None, None, None),
            ]
            con.executemany(
                "INSERT INTO page_sessions VALUES (?, ?, datetime('now'), ?, ?, ?)",
                rows,
            )
            con.commit()
            con.close()
            report = planner_audience_metrics(
                db,
                ["planner-retarget", "planner-prospecting"],
                days=180,
                threshold=3,
            )
            self.assertEqual(report["paid_sessions_quarantined"], 2)
            self.assertEqual(report["clean_seed_sessions"], 2)
            self.assertEqual(report["clean_email_sessions"], 1)
            self.assertFalse(report["reactivation_ready"])


if __name__ == "__main__":
    unittest.main()
