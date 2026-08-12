import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import campaign_registry as registry


class CampaignRegistryRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous_db = registry.DB_PATH
        self.previous_registry = registry.REGISTRY_PATH
        registry.DB_PATH = Path(self.directory.name) / "crm.db"
        registry.REGISTRY_PATH = Path(self.directory.name) / "active-campaigns.json"

    def tearDown(self):
        registry.DB_PATH = self.previous_db
        registry.REGISTRY_PATH = self.previous_registry
        self.directory.cleanup()

    def test_registry_write_creates_hashed_database_recovery_copy(self):
        records = [{"brief_id": "brief-one", "campaign_id": "123", "status": "ACTIVE"}]
        registry.write_registry(records, registry.REGISTRY_PATH)
        con = sqlite3.connect(registry.DB_PATH)
        row = con.execute(
            "SELECT records_json, records_hash, record_count FROM marketing_campaign_registry"
        ).fetchone()
        con.close()
        self.assertEqual(json.loads(row[0]), records)
        self.assertEqual(len(row[1]), 64)
        self.assertEqual(row[2], 1)

    def test_missing_runtime_registry_recovers_from_database_snapshot(self):
        records = [{"brief_id": "brief-one", "campaign_id": "123"}]
        registry.backup_registry(records, registry.REGISTRY_PATH)
        self.assertFalse(registry.REGISTRY_PATH.exists())
        self.assertEqual(registry.load_registry(registry.REGISTRY_PATH), records)

    def test_tampered_database_snapshot_fails_closed(self):
        registry.backup_registry([{"campaign_id": "123"}], registry.REGISTRY_PATH)
        con = sqlite3.connect(registry.DB_PATH)
        con.execute("UPDATE marketing_campaign_registry SET records_json='[]'")
        con.commit()
        con.close()
        with self.assertRaisesRegex(ValueError, "integrity hash"):
            registry.load_registry(registry.REGISTRY_PATH)

    def test_corrupt_runtime_file_does_not_silently_fall_back(self):
        registry.backup_registry([{"campaign_id": "123"}], registry.REGISTRY_PATH)
        registry.REGISTRY_PATH.write_text("not json")
        with self.assertRaisesRegex(ValueError, "not readable valid JSON"):
            registry.load_registry(registry.REGISTRY_PATH)


if __name__ == "__main__":
    unittest.main()
