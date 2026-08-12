import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from runtime_paths import ROOT, runtime_state_dir, runtime_state_path


SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from migrate_tracking_state import SNAPSHOTS, migrate  # noqa: E402


class RuntimePathTests(unittest.TestCase):
    def test_default_runtime_state_is_outside_tracked_state_directory(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_state_dir(), ROOT / "runtime" / "state")
            self.assertEqual(
                runtime_state_path("tracking-health.json"),
                ROOT / "runtime" / "state" / "tracking-health.json",
            )

    def test_runtime_state_directory_can_be_overridden(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(
                os.environ, {"SOCIALSOL_RUNTIME_STATE_DIR": tmp}, clear=False
            ):
                self.assertEqual(runtime_state_dir(), Path(tmp).resolve())

    def test_runtime_filename_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            runtime_state_path("../tracking-health.json")

    def test_runtime_directory_is_git_ignored_and_legacy_snapshots_are_removed(self):
        ignored = subprocess.run(
            [
                "git",
                "check-ignore",
                "--no-index",
                "--quiet",
                str(ROOT / "runtime" / "state" / "tracking-health.json"),
            ],
            cwd=ROOT,
            check=False,
        )
        self.assertEqual(ignored.returncode, 0)
        for filename in SNAPSHOTS:
            self.assertFalse((ROOT / "state" / filename).exists())

    def test_migration_copies_without_deleting_and_preserves_replaced_runtime_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp) / "source"
            destination = Path(tmp) / "runtime-state"
            legacy = source_root / "state"
            legacy.mkdir(parents=True)
            for index, filename in enumerate(SNAPSHOTS):
                (legacy / filename).write_text(json.dumps({"revision": index}))

            first = migrate(source_root, destination)
            self.assertTrue(all(row["status"] == "copied" for row in first))
            self.assertTrue(all((legacy / filename).exists() for filename in SNAPSHOTS))
            self.assertEqual(
                json.loads((destination / SNAPSHOTS[0]).read_text()), {"revision": 0}
            )

            second = migrate(source_root, destination)
            self.assertTrue(all(row["status"] == "unchanged" for row in second))

            (legacy / SNAPSHOTS[0]).write_text(json.dumps({"revision": "new"}))
            third = migrate(source_root, destination)
            changed = third[0]
            self.assertEqual(changed["status"], "copied")
            self.assertTrue(Path(changed["backup"]).is_file())
            self.assertEqual(
                json.loads((destination / SNAPSHOTS[0]).read_text()),
                {"revision": "new"},
            )


if __name__ == "__main__":
    unittest.main()
