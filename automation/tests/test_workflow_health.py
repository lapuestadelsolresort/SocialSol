import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from workflow_health import (
    alert_configuration_missing,
    checkout_integrity,
    expected_graph_agents,
    graph_agent_integrity,
    hard_failure_count,
    incident_alert_active,
    inspect,
    notify_incident_once,
    policy_fingerprint_integrity,
    scheduled_graph_integrity,
    set_incident_alert_active,
)


SCHEMA = """
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, trigger_type TEXT,
  error_message TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE workflow_steps (
  run_id TEXT, status TEXT, available_at TEXT, lease_expires_at TEXT
);
CREATE TABLE workflow_outbox (
  status TEXT, lease_expires_at TEXT, created_at TEXT
);
CREATE TABLE workflow_effects (
  id TEXT, run_id TEXT, provider TEXT, status TEXT, requested_at TEXT,
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

    def test_pre_effect_email_thread_rejection_is_reported_without_failing_health(self):
        con = self.database()
        con.execute("""INSERT INTO workflow_runs
            (id, workflow_name, status, trigger_type, error_message, created_at, updated_at)
            VALUES ('rejected-email', 'email.reply.propose', 'failed',
                    'slack_email_reply_command',
                    'no recorded inbound message exists for this Slack thread',
                    datetime('now'), datetime('now'))""")
        metrics = inspect(con)
        self.assertEqual(metrics["email_command_rejections_24h"], 1)
        self.assertEqual(metrics["failed_24h"], 0)
        self.assertEqual(hard_failure_count(metrics), 0)

    def test_email_thread_failure_after_an_effect_remains_a_hard_failure(self):
        con = self.database()
        con.execute("""INSERT INTO workflow_runs
            (id, workflow_name, status, trigger_type, error_message, created_at, updated_at)
            VALUES ('effect-email', 'email.reply.propose', 'failed',
                    'slack_email_reply_command',
                    'no recorded inbound message exists for this Slack thread',
                    datetime('now'), datetime('now'))""")
        con.execute("""INSERT INTO workflow_effects
            (id, run_id, provider, status, requested_at, verification_mode)
            VALUES ('effect-1', 'effect-email', 'gmail', 'failed', datetime('now'), 'readback_required')""")
        metrics = inspect(con)
        self.assertEqual(metrics["email_command_rejections_24h"], 0)
        self.assertEqual(metrics["failed_24h"], 1)
        self.assertGreater(hard_failure_count(metrics), 0)

    def test_missing_alert_configuration_fails_closed(self):
        con = self.database()
        self.assertEqual(hard_failure_count(inspect(con), alert_config_missing=1), 1)

    def test_operator_check_suppresses_only_the_missing_alert_config_failure(self):
        self.assertEqual(alert_configuration_missing(False, "", ""), 1)
        self.assertEqual(alert_configuration_missing(True, "", ""), 0)

    def test_serving_checkout_must_remain_clean_main(self):
        class Result:
            def __init__(self, stdout):
                self.stdout = stdout

        def dirty_feature_run(command, **_kwargs):
            if "--show-current" in command:
                return Result("codex/unfinished-change\n")
            return Result(" M automation/workflow_health.py\n")

        metrics = checkout_integrity(run=dirty_feature_run)
        self.assertEqual(metrics["runtime_git_wrong_branch"], 1)
        self.assertEqual(metrics["runtime_git_dirty"], 1)
        self.assertEqual(metrics["runtime_git_check_error"], 0)
        self.assertGreater(hard_failure_count(metrics), 0)

    def test_clean_main_checkout_is_healthy(self):
        class Result:
            def __init__(self, stdout):
                self.stdout = stdout

        def clean_main_run(command, **_kwargs):
            return Result("main\n" if "--show-current" in command else "")

        metrics = checkout_integrity(run=clean_main_run)
        self.assertEqual(metrics, {
            "runtime_git_wrong_branch": 0,
            "runtime_git_dirty": 0,
            "runtime_git_check_error": 0,
        })

    def test_incident_alert_state_suppresses_repeats_and_resets_after_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "workflow-health-alert-state.json"
            messages = []

            def capture(message):
                messages.append(message)
                return True

            self.assertFalse(incident_alert_active(state_path))
            self.assertTrue(notify_incident_once(
                "failure", capture, state_path
            ))
            self.assertFalse(notify_incident_once(
                "same failure", capture, state_path
            ))
            self.assertEqual(messages, ["failure"])
            self.assertTrue(incident_alert_active(state_path))
            set_incident_alert_active(False, state_path)
            self.assertFalse(incident_alert_active(state_path))
            self.assertTrue(notify_incident_once(
                "future failure", capture, state_path
            ))
            self.assertEqual(messages, ["failure", "future failure"])

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

    def test_live_scheduled_graphs_require_a_recent_success(self):
        con = self.database()
        policy = {"live_workflows": ["marketing.report.daily", "meta.audience.sync"]}
        missing = scheduled_graph_integrity(con, policy)
        self.assertEqual(missing["scheduled_graph_missing"], 2)
        self.assertGreater(hard_failure_count(missing), 0)
        con.execute("""INSERT INTO workflow_runs
            (id,workflow_name,status,created_at,updated_at)
            VALUES ('report','marketing.report.daily','completed',datetime('now'),datetime('now'))""")
        con.execute("""INSERT INTO workflow_runs
            (id,workflow_name,status,created_at,updated_at)
            VALUES ('audience','meta.audience.sync','completed',datetime('now'),datetime('now'))""")
        healthy = scheduled_graph_integrity(con, policy)
        self.assertEqual(healthy, {
            "scheduled_graph_missing": 0,
            "scheduled_graph_stale": 0,
            "scheduled_graph_failed": 0,
        })


class PolicyFingerprintTests(unittest.TestCase):
    """F-055: workflow/policy.json is gitignored, so the dirty-checkout guard
    cannot see a hand edit. The fingerprint makes one detectable."""

    def _scratch(self, policy_text='{"version": 1}'):
        directory = Path(tempfile.mkdtemp())
        policy = directory / "policy.json"
        policy.write_text(policy_text, encoding="utf-8")
        return policy, directory / "policy-fingerprint.json"

    def test_matching_record_is_not_flagged(self):
        import hashlib
        policy, record = self._scratch()
        digest = hashlib.sha256(policy.read_bytes()).hexdigest()
        record.write_text(json.dumps({"sha256": digest}), encoding="utf-8")
        metrics = policy_fingerprint_integrity(policy, record)
        self.assertEqual(metrics["runtime_policy_unrecorded"], 0)
        self.assertEqual(metrics["runtime_policy_sha"], digest[:16])

    def test_out_of_band_edit_is_flagged(self):
        policy, record = self._scratch()
        record.write_text(json.dumps({"sha256": "0" * 64}), encoding="utf-8")
        self.assertEqual(policy_fingerprint_integrity(policy, record)["runtime_policy_unrecorded"], 1)

    def test_missing_record_is_flagged(self):
        policy, record = self._scratch()
        self.assertEqual(policy_fingerprint_integrity(policy, record)["runtime_policy_unrecorded"], 1)

    def test_missing_policy_defers_to_runtime_policy_error(self):
        policy, record = self._scratch()
        policy.unlink()
        metrics = policy_fingerprint_integrity(policy, record)
        self.assertEqual(metrics["runtime_policy_unrecorded"], 0)
        self.assertIsNone(metrics["runtime_policy_sha"])

    def test_drift_does_not_page_the_five_minute_job(self):
        # Reported, not hard-failing: release:check surfaces it to a human.
        self.assertEqual(hard_failure_count({"runtime_policy_unrecorded": 1}), 0)


if __name__ == "__main__":
    unittest.main()
