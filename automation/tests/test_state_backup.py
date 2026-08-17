import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import state_backup


class SnapshotTasksDbTests(unittest.TestCase):
    def test_snapshot_is_consistent_and_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tasks.db"
            con = sqlite3.connect(source)
            con.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)")
            con.executemany("INSERT INTO tasks (title) VALUES (?)", [("a",), ("b",)])
            con.commit()
            con.close()
            snapshot = Path(tmp) / "snapshot.db"
            with mock.patch.object(state_backup, "TASKS_DB", source):
                state_backup.snapshot_tasks_db(snapshot)
            check = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
            rows = check.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
            check.close()
            self.assertEqual(rows, 2)

    def test_corrupt_snapshot_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tasks.db"
            sqlite3.connect(source).close()
            snapshot = Path(tmp) / "snapshot.db"
            with mock.patch.object(state_backup, "TASKS_DB", source), \
                 mock.patch.object(state_backup.sqlite3, "connect", side_effect=sqlite3.OperationalError("locked")):
                with self.assertRaises(sqlite3.OperationalError):
                    state_backup.snapshot_tasks_db(snapshot)


class PruneTests(unittest.TestCase):
    def test_prune_keeps_newest_thirty(self):
        with tempfile.TemporaryDirectory() as tmp:
            backup_dir = Path(tmp)
            for day in range(1, 34):
                (backup_dir / f"state-2026-07-{day:02d}.tar.gz.enc").write_bytes(b"x")
            with mock.patch.object(state_backup, "BACKUP_DIR", backup_dir):
                state_backup.prune_local()
            remaining = sorted(p.name for p in backup_dir.glob("state-*.tar.gz.enc"))
            self.assertEqual(len(remaining), 30)
            self.assertNotIn("state-2026-07-01.tar.gz.enc", remaining)
            self.assertIn("state-2026-07-33.tar.gz.enc", remaining)


class MainPipelineTests(unittest.TestCase):
    def _fixture(self, tmp):
        base = Path(tmp)
        tasks = base / "tasks.db"
        con = sqlite3.connect(tasks)
        con.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY)")
        con.commit()
        con.close()
        policy = base / "policy.json"
        policy.write_text('{"version": 1}\n')
        openclaw = base / "openclaw.json"
        openclaw.write_text('{"agents": {}}\n')
        passphrase = base / "pass"
        passphrase.write_text("secret\n")
        backups = base / "backups"
        return tasks, policy, openclaw, passphrase, backups

    def test_main_builds_verified_archive_and_uploads(self):
        with tempfile.TemporaryDirectory() as tmp:
            tasks, policy, openclaw, passphrase, backups = self._fixture(tmp)
            uploads = []
            records = []

            def fake_encrypt(source, destination, passphrase_file):
                Path(destination).write_bytes(Path(source).read_bytes())

            with mock.patch.object(state_backup, "TASKS_DB", tasks), \
                 mock.patch.object(state_backup, "POLICY_PATH", policy), \
                 mock.patch.object(state_backup, "OPENCLAW_CONFIG", openclaw), \
                 mock.patch.object(state_backup, "BACKUP_DIR", backups), \
                 mock.patch.object(state_backup, "load_config", return_value={"passphrase_file": str(passphrase)}), \
                 mock.patch.object(state_backup, "encrypt", side_effect=fake_encrypt), \
                 mock.patch.object(state_backup, "upload", side_effect=lambda path, config: uploads.append(path)), \
                 mock.patch.object(state_backup, "get_status", return_value={}), \
                 mock.patch.object(state_backup, "record", side_effect=lambda *args: records.append(args)):
                state_backup.main()

            artifacts = list(backups.glob("state-*.tar.gz.enc"))
            self.assertEqual(len(artifacts), 1)
            self.assertEqual(uploads, [artifacts[0]])
            self.assertEqual(records[-1][0], "resort-state-backup")
            self.assertTrue(records[-1][1])
            with tarfile.open(artifacts[0], "r:gz") as archive:
                names = sorted(archive.getnames())
                self.assertEqual(names, ["metadata.json", "openclaw.json", "policy.json", "tasks.db"])
                metadata = json.loads(archive.extractfile("metadata.json").read())
                self.assertEqual(sorted(metadata["sha256"]), ["openclaw.json", "policy.json", "tasks.db"])

    def test_main_skips_when_already_done_today(self):
        with tempfile.TemporaryDirectory() as tmp:
            tasks, policy, openclaw, passphrase, backups = self._fixture(tmp)
            backups.mkdir()
            from datetime import datetime, timezone
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            done = backups / f"state-{stamp}.tar.gz.enc"
            done.write_bytes(b"existing")
            uploads = []
            with mock.patch.object(state_backup, "TASKS_DB", tasks), \
                 mock.patch.object(state_backup, "POLICY_PATH", policy), \
                 mock.patch.object(state_backup, "OPENCLAW_CONFIG", openclaw), \
                 mock.patch.object(state_backup, "BACKUP_DIR", backups), \
                 mock.patch.object(state_backup, "load_config", return_value={"passphrase_file": str(passphrase)}), \
                 mock.patch.object(state_backup, "upload", side_effect=lambda path, config: uploads.append(path)), \
                 mock.patch.object(state_backup, "get_status", return_value={"status": "ok", "detail": done.name}), \
                 mock.patch.object(state_backup, "record"):
                state_backup.main()
            self.assertEqual(uploads, [])
            self.assertEqual(done.read_bytes(), b"existing")

    def test_missing_store_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            tasks, policy, openclaw, passphrase, backups = self._fixture(tmp)
            tasks.unlink()
            with mock.patch.object(state_backup, "TASKS_DB", tasks), \
                 mock.patch.object(state_backup, "POLICY_PATH", policy), \
                 mock.patch.object(state_backup, "OPENCLAW_CONFIG", openclaw):
                with self.assertRaises(RuntimeError):
                    state_backup.main()


if __name__ == "__main__":
    unittest.main()
