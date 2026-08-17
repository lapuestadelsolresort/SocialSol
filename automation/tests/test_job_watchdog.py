import unittest
from datetime import datetime, timedelta, timezone

import job_watchdog


def manifest(services, watchdog=None):
    return {
        "version": 1,
        "label_prefix": "com.lapuestadelsolresort.",
        "services": services,
        "watchdog": watchdog or {},
    }


class ExpectedFromManifestTests(unittest.TestCase):
    def test_hours_parse_including_fractions(self):
        expected = job_watchdog.expected_from_manifest(manifest(
            {"a": {"state": "loaded"}},
            {"resort-workflow-health": {"max_age_hours": 0.25},
             "resort-crm-backup": {"max_age_hours": 30}},
        ))
        self.assertEqual(expected["resort-workflow-health"], timedelta(minutes=15))
        self.assertEqual(expected["resort-crm-backup"], timedelta(hours=30))

    def test_empty_watchdog_section_raises(self):
        with self.assertRaises(ValueError):
            job_watchdog.expected_from_manifest(manifest({"a": {"state": "loaded"}}))


class ConvergenceProblemTests(unittest.TestCase):
    def test_resurrected_retired_producer_is_flagged(self):
        problems = job_watchdog.convergence_problems(
            manifest({
                "graph-regina": {"state": "loaded"},
                "regina-anniversary": {"state": "retired"},
            }),
            loaded={
                "com.lapuestadelsolresort.graph-regina",
                "com.lapuestadelsolresort.regina-anniversary",
            },
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("regina-anniversary", problems[0])
        self.assertIn("retired", problems[0])
        self.assertIn("resurrection", problems[0])

    def test_unknown_loaded_label_and_missing_expected_service(self):
        problems = job_watchdog.convergence_problems(
            manifest({"crm": {"state": "loaded"}, "workflow-worker": {"state": "loaded"}}),
            loaded={"com.lapuestadelsolresort.crm", "com.lapuestadelsolresort.mystery"},
        )
        self.assertEqual(len(problems), 2)
        self.assertTrue(any("mystery" in p and "absent from the service manifest" in p for p in problems))
        self.assertTrue(any("workflow-worker" in p and "not loaded" in p for p in problems))

    def test_converged_state_reports_nothing(self):
        problems = job_watchdog.convergence_problems(
            manifest({"crm": {"state": "loaded"}, "gtku": {"state": "retired"}}),
            loaded={"com.lapuestadelsolresort.crm"},
        )
        self.assertEqual(problems, [])


class StalenessProblemTests(unittest.TestCase):
    def test_never_failed_stale_and_healthy(self):
        now = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
        expected = {"a": timedelta(hours=30), "b": timedelta(hours=30),
                    "c": timedelta(hours=30), "d": timedelta(hours=30)}
        state = {
            "b": {"status": "failed", "last_run_at": now.isoformat(), "detail": "boom"},
            "c": {"status": "ok", "last_run_at": (now - timedelta(hours=31)).isoformat()},
            "d": {"status": "ok", "last_run_at": (now - timedelta(hours=1)).isoformat()},
        }
        problems = job_watchdog.staleness_problems(expected, state, now)
        self.assertEqual(len(problems), 3)
        self.assertTrue(any("`a` has never reported" in p for p in problems))
        self.assertTrue(any("`b` failed: boom" in p for p in problems))
        self.assertTrue(any("`c` is stale" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
