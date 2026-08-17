import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import media_backup_verify as mbv


def build_tree(base, files):
    for relative, content in files.items():
        path = base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


class VerifyAgainstMountTests(unittest.TestCase):
    def test_identical_copy_passes_and_hashes_everything_on_first_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "originals"
            copy = Path(tmp) / "offline"
            files = {"A_CAM/a.mp4": b"alpha", "DRONE/d.mp4": b"delta"}
            build_tree(source, files)
            build_tree(copy, files)
            with mock.patch.object(mbv, "SOURCE_ROOT", source):
                problems, total, hashed = mbv.verify_against_mount(copy, last_verified=None)
            self.assertEqual(problems, [])
            self.assertEqual(total, 2)
            self.assertEqual(hashed, 4)  # both files as "changed" + both in the random sample

    def test_missing_size_and_hash_mismatches_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "originals"
            copy = Path(tmp) / "offline"
            build_tree(source, {
                "A_CAM/missing.mp4": b"only-local",
                "A_CAM/short.mp4": b"full-length",
                "A_CAM/tampered.mp4": b"original",
            })
            build_tree(copy, {
                "A_CAM/short.mp4": b"cut",
                "A_CAM/tampered.mp4": b"0riginal",  # same size, different bytes
            })
            with mock.patch.object(mbv, "SOURCE_ROOT", source):
                problems, total, _ = mbv.verify_against_mount(copy, last_verified=None)
            self.assertEqual(total, 3)
            self.assertTrue(any("missing on offline copy" in p for p in problems))
            self.assertTrue(any("size mismatch" in p for p in problems))
            self.assertTrue(any("sha256 mismatch" in p for p in problems))

    def test_appledouble_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "originals"
            copy = Path(tmp) / "offline"
            build_tree(source, {"A_CAM/a.mp4": b"alpha", "A_CAM/._a.mp4": b"resource-fork"})
            build_tree(copy, {"A_CAM/a.mp4": b"alpha"})
            with mock.patch.object(mbv, "SOURCE_ROOT", source):
                problems, total, _ = mbv.verify_against_mount(copy, last_verified=None)
            self.assertEqual(problems, [])
            self.assertEqual(total, 1)


class GraceWindowTests(unittest.TestCase):
    def _run_main(self, config, state, expect_exit):
        records = []
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            with mock.patch.object(mbv, "load_config", return_value=config), \
                 mock.patch.object(mbv, "STATE_PATH", state_path), \
                 mock.patch.object(mbv, "read_state", return_value=state), \
                 mock.patch.object(mbv, "record", side_effect=lambda *args: records.append(args)):
                if expect_exit:
                    with self.assertRaises(SystemExit):
                        mbv.main()
                else:
                    mbv.main()
        return records

    def test_recent_attestation_within_grace_is_ok(self):
        attested = (datetime.now(timezone.utc) - timedelta(days=3)).date().isoformat()
        records = self._run_main(
            {"media_offline": {"attested_at": attested}}, {}, expect_exit=False,
        )
        self.assertTrue(records[-1][1])
        self.assertIn("within grace", records[-1][2])

    def test_no_attestation_and_no_verification_fails(self):
        records = self._run_main({}, {}, expect_exit=True)
        self.assertFalse(records[-1][1])

    def test_expired_grace_fails(self):
        stale = (datetime.now(timezone.utc) - timedelta(days=mbv.GRACE_DAYS + 2)).isoformat()
        records = self._run_main(
            {"media_offline": {"attested_at": "2026-01-01"}},
            {"last_verified_at": stale},
            expect_exit=True,
        )
        self.assertFalse(records[-1][1])


if __name__ == "__main__":
    unittest.main()
