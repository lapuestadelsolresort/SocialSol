import sqlite3
import tempfile
import unittest
from pathlib import Path

from capi_health import meta_capi_delivery_health, meta_capi_failure_message


class MetaCapiHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "crm.db"
        con = sqlite3.connect(self.db_path)
        con.execute(
            """CREATE TABLE conversion_deliveries (
                 provider TEXT, status TEXT, updated_at TEXT
               )"""
        )
        con.commit()
        con.close()

    def tearDown(self):
        self.temp.cleanup()

    def insert(self, provider, status, updated_at):
        con = sqlite3.connect(self.db_path)
        con.execute(
            "INSERT INTO conversion_deliveries VALUES (?,?,?)",
            (provider, status, updated_at),
        )
        con.commit()
        con.close()

    def test_sent_and_fresh_pending_are_healthy(self):
        self.insert("meta-capi", "sent", "2026-08-09 01:00:00")
        self.insert("meta-capi", "pending", "2999-01-01 00:00:00")
        self.assertTrue(meta_capi_delivery_health(self.db_path)["ok"])

    def test_failed_delivery_is_unhealthy(self):
        self.insert("meta-capi", "failed", "2026-08-09 01:00:00")
        health = meta_capi_delivery_health(self.db_path)
        self.assertFalse(health["ok"])
        self.assertEqual(health["failed"], 1)
        self.assertIn("1 failed", meta_capi_failure_message(health))

    def test_stale_pending_is_unhealthy(self):
        self.insert("meta-capi", "pending", "2000-01-01 00:00:00")
        health = meta_capi_delivery_health(self.db_path)
        self.assertFalse(health["ok"])
        self.assertEqual(health["stale_pending"], 1)

    def test_other_provider_does_not_contaminate_meta_health(self):
        self.insert("other", "failed", "2000-01-01 00:00:00")
        self.assertTrue(meta_capi_delivery_health(self.db_path)["ok"])


if __name__ == "__main__":
    unittest.main()
