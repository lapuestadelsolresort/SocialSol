"""Local backup retention (F-034): date-based, burst-proof, parse-safe."""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import crm_backup


def _touch(directory, name):
    path = directory / name
    path.write_bytes(b"x")
    return path


class PruneLocalTests(unittest.TestCase):
    def test_deploy_burst_does_not_evict_older_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            today = datetime.now(timezone.utc).date()
            # A deploy-burst afternoon: 12 forced snapshots in one day.
            burst = [
                _touch(directory, f"crm-{today.isoformat()}T15{index:02d}00Z.db.gz.enc")
                for index in range(12)
            ]
            # Daily backups from the preceding week: inside keep_days.
            recent = [
                _touch(directory, f"crm-{(today - timedelta(days=offset)).isoformat()}.db.gz.enc")
                for offset in range(1, 8)
            ]
            # Backups far beyond the window: prunable.
            ancient = [
                _touch(directory, f"crm-{(today - timedelta(days=40 + offset)).isoformat()}.db.gz.enc")
                for offset in range(3)
            ]
            with mock.patch.object(crm_backup, "BACKUP_DIR", directory):
                crm_backup.prune_local(keep_days=30, min_keep=10)
            for path in burst + recent:
                self.assertTrue(path.exists(), f"{path.name} is inside the window and must survive")
            for path in ancient:
                self.assertFalse(path.exists(), f"{path.name} is outside the window and must be pruned")

    def test_min_keep_floor_survives_even_when_ancient(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            today = datetime.now(timezone.utc).date()
            stale = [
                _touch(directory, f"crm-{(today - timedelta(days=100 + offset)).isoformat()}.db.gz.enc")
                for offset in range(6)
            ]
            with mock.patch.object(crm_backup, "BACKUP_DIR", directory):
                crm_backup.prune_local(keep_days=30, min_keep=4)
            survivors = sorted(path for path in stale if path.exists())
            self.assertEqual(len(survivors), 4, "the newest min_keep files survive regardless of age")

    def test_unparseable_names_are_never_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            today = datetime.now(timezone.utc).date()
            odd = _touch(directory, "crm-migration-copy.db.gz.enc")
            keepers = [
                _touch(directory, f"crm-{(today - timedelta(days=offset)).isoformat()}.db.gz.enc")
                for offset in range(3)
            ]
            with mock.patch.object(crm_backup, "BACKUP_DIR", directory):
                crm_backup.prune_local(keep_days=30, min_keep=1)
            self.assertTrue(odd.exists(), "a name without a parseable date is left alone")
            for path in keepers:
                self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
