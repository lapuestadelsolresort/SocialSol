import sqlite3
import unittest

from workflow_health import (
    alert_configuration_missing,
    expected_graph_agents,
    graph_agent_integrity,
    hard_failure_count,
    inspect,
)


SCHEMA = """
CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE workflow_steps (
  run_id TEXT, status TEXT, available_at TEXT, lease_expires_at TEXT
);
CREATE TABLE workflow_outbox (
  status TEXT, lease_expires_at TEXT, created_at TEXT
);
CREATE TABLE workflow_effects (
  id TEXT, provider TEXT, status TEXT, requested_at TEXT,
  verification_mode TEXT DEFAULT 'readback_required', verification_deadline_at TEXT
);
CREATE TABLE workflow_manual_reviews (status TEXT, effect_id TEXT, run_id TEXT);
"""


class WorkflowHealthTests(unittest.TestCase):
    def database(self):
        con = sqlite3.connect(":memory:")
        con.executescript(SCHEMA)
        return con

    def test_open_manual_review_is_a_hard_failure(self):
        con = self.database()
        con.execute("INSERT INTO workflow_manual_reviews(status) VALUES ('open')")
        metrics = inspect(con)
        self.assertEqual(metrics["open_manual_reviews"], 1)
        self.assertGreater(hard_failure_count(metrics), 0)

    def test_healthy_empty_control_plane_has_no_hard_failures(self):
        con = self.database()
        metrics = inspect(con)
        self.assertEqual(hard_failure_count(metrics), 0)

    def test_missing_alert_configuration_fails_closed(self):
        con = self.database()
        self.assertEqual(hard_failure_count(inspect(con), alert_config_missing=1), 1)

    def test_operator_check_suppresses_only_the_missing_alert_config_failure(self):
        self.assertEqual(alert_configuration_missing(False, "", ""), 1)
        self.assertEqual(alert_configuration_missing(True, "", ""), 0)

    def test_provider_acceptance_is_terminal_for_meta(self):
        con = self.database()
        con.execute("""INSERT INTO workflow_effects
            (id, provider, status, requested_at, verification_mode)
            VALUES ('meta-1','meta','accepted_by_provider',datetime('now','-1 day'),'provider_acceptance')""")
        metrics = inspect(con)
        self.assertEqual(metrics["old_unverified_effects"], 0)
        self.assertEqual(hard_failure_count(metrics), 0)

    def test_overdue_readback_effect_is_unhealthy(self):
        con = self.database()
        con.execute("""INSERT INTO workflow_effects
            (id, provider, status, requested_at, verification_mode, verification_deadline_at)
            VALUES ('postiz-1','postiz','accepted_by_provider',datetime('now','-1 day'),
                    'readback_required',datetime('now','-1 minute'))""")
        metrics = inspect(con)
        self.assertEqual(metrics["old_unverified_effects"], 1)
        self.assertGreater(hard_failure_count(metrics), 0)

    def test_live_workflows_require_their_graph_launchagents(self):
        policy = {
            "live_workflows": [
                "paulina.daily", "paulina.prepare_daily",
                "accounting.classify", "qbo.write", "whatsapp.reply",
            ]
        }
        self.assertEqual(expected_graph_agents(policy), [
            "com.lapuestadelsolresort.graph-accounting-inbox",
            "com.lapuestadelsolresort.graph-paulina",
            "com.lapuestadelsolresort.graph-paulina-prepare",
        ])

        class Result:
            def __init__(self, returncode):
                self.returncode = returncode

        def fake_run(command, **_kwargs):
            return Result(1 if command[-1].endswith("graph-paulina") else 0)

        metrics = graph_agent_integrity(policy, run=fake_run)
        self.assertEqual(metrics["runtime_graph_agents_missing"], 1)
        self.assertGreater(hard_failure_count(metrics), 0)


if __name__ == "__main__":
    unittest.main()
