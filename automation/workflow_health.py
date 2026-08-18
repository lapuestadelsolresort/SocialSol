#!/usr/bin/env python3
"""Fail closed on stalled durable workflows, dead outbox rows, or DB damage."""

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from job_health import record

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm" / "data" / "crm.db"))
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
ALERT_CHANNEL = os.environ.get("RESORT_OPS_ALERTS_CHANNEL", "")
JOB_NAME = "resort-workflow-health"
POLICY_PATH = Path(os.environ.get("RESORT_WORKFLOW_POLICY_PATH", ROOT / "workflow" / "policy.json"))
ALERT_STATE_PATH = Path(os.environ.get(
    "RESORT_WORKFLOW_HEALTH_ALERT_STATE_PATH",
    ROOT / "memory" / "workflow-health-alert-state.json",
))

GRAPH_AGENTS = {
    "accounting.classify": "com.lapuestadelsolresort.graph-accounting-inbox",
    "qbo.write": "com.lapuestadelsolresort.graph-accounting-inbox",
    "receipt.reconcile": "com.lapuestadelsolresort.graph-receipt-reconcile",
    "paulina.daily": "com.lapuestadelsolresort.graph-paulina",
    "paulina.prepare_daily": "com.lapuestadelsolresort.graph-paulina-prepare",
    "regina.daily": "com.lapuestadelsolresort.graph-regina",
    "ownerrez.crm.sync": "com.lapuestadelsolresort.graph-crm-sync",
    "squarespace.crm.sync": "com.lapuestadelsolresort.graph-squarespace-sync",
    "social.publish_routine": "com.lapuestadelsolresort.graph-social-routine",
    "social.publish_due": "com.lapuestadelsolresort.graph-social-publish",
    "marketing.report.daily": "com.lapuestadelsolresort.daily-report",
    "meta.audience.sync": "com.lapuestadelsolresort.crm-audience-sync",
}
SCHEDULED_GRAPH_MAX_AGE = {
    "marketing.report.daily": 30 * 60 * 60,
    "meta.audience.sync": 30 * 60 * 60,
}


def expected_graph_agents(policy):
    live = set(policy.get("live_workflows") or [])
    return sorted({label for workflow, label in GRAPH_AGENTS.items() if workflow in live})


def graph_agent_integrity(policy, run=subprocess.run):
    missing = 0
    domain = f"gui/{os.getuid()}"
    for label in expected_graph_agents(policy):
        result = run(
            ["/bin/launchctl", "print", f"{domain}/{label}"],
            timeout=10,
            capture_output=True,
            text=True,
        )
        missing += int(result.returncode != 0)
    return {"runtime_graph_agents_missing": missing, "runtime_policy_error": 0}


def scheduled_graph_integrity(con, policy, now=None):
    live = set(policy.get("live_workflows") or [])
    current = now or datetime.now(timezone.utc)
    metrics = {
        "scheduled_graph_missing": 0,
        "scheduled_graph_stale": 0,
        "scheduled_graph_failed": 0,
    }
    for workflow, max_age_seconds in SCHEDULED_GRAPH_MAX_AGE.items():
        if workflow not in live:
            continue
        completed = con.execute(
            """SELECT updated_at FROM workflow_runs
                 WHERE workflow_name=? AND status='completed'
                 ORDER BY updated_at DESC LIMIT 1""",
            (workflow,),
        ).fetchone()
        latest = con.execute(
            """SELECT status, updated_at FROM workflow_runs
                 WHERE workflow_name=? ORDER BY created_at DESC LIMIT 1""",
            (workflow,),
        ).fetchone()
        if not completed:
            metrics["scheduled_graph_missing"] += 1
        else:
            try:
                stamp = datetime.fromisoformat(completed[0])
                if stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=timezone.utc)
                stale = (current - stamp.astimezone(timezone.utc)).total_seconds() > max_age_seconds
            except (TypeError, ValueError):
                stale = True
            metrics["scheduled_graph_stale"] += int(stale)
        if latest and latest[0] == "failed" and (not completed or latest[1] > completed[0]):
            metrics["scheduled_graph_failed"] += 1
    return metrics


def runtime_integrity():
    """Detect a mutable checkout whose loaded Node processes predate source edits."""
    targets = {
        "crm": str(ROOT / "crm" / "server.js"),
        "worker": str(ROOT / "crm" / "scripts" / "workflow-worker.js"),
    }
    try:
        output = subprocess.run(
            ["ps", "-axo", "pid=,lstart=,command="], check=True, timeout=10,
            capture_output=True, text=True,
        ).stdout
    except Exception:
        return {"runtime_process_missing": len(targets), "runtime_code_drift": 0, "runtime_process_check_error": 1}
    starts = {}
    for line in output.splitlines():
        for name, script in targets.items():
            if script not in line:
                continue
            fields = line.split(None, 6)
            if len(fields) < 7:
                continue
            try:
                started = datetime.strptime(
                    " ".join(fields[1:6]), "%a %b %d %H:%M:%S %Y"
                ).astimezone().timestamp()
            except ValueError:
                continue
            starts[name] = started
    watched = {
        "crm": [ROOT / "crm" / "server.js", ROOT / "crm" / "lib", ROOT / "crm" / "routes", ROOT / "crm" / "workflows"],
        "worker": [ROOT / "crm" / "scripts" / "workflow-worker.js", ROOT / "crm" / "lib", ROOT / "crm" / "workflows"],
    }
    drift = 0
    for name, started in starts.items():
        latest = 0.0
        for item in watched[name]:
            if item.is_file():
                latest = max(latest, item.stat().st_mtime)
            elif item.is_dir():
                latest = max([latest, *(path.stat().st_mtime for path in item.rglob("*.js"))])
        drift += int(latest > started)
    return {
        "runtime_process_missing": len(targets) - len(starts),
        "runtime_code_drift": drift,
        "runtime_process_check_error": 0,
    }


def policy_fingerprint_integrity(policy_path=None, record_path=None):
    """Detect a runtime policy that nobody recorded installing (F-055).

    workflow/policy.json is gitignored, so checkout_integrity cannot see it
    change. scripts/policy-fingerprint.js records a sha after each sanctioned
    install; a mismatch means the running policy is not the one last blessed.

    Deliberately NOT part of hard_failure_count: this job runs every 5
    minutes, and a legitimate hand-install that skipped the record step would
    otherwise page continuously. It is reported in the metrics detail, and
    `release:check` fails on the same condition, where a human is present.
    """
    policy_path = Path(policy_path) if policy_path else POLICY_PATH
    record_path = Path(record_path) if record_path else Path(
        os.environ.get("RESORT_POLICY_FINGERPRINT_PATH", ROOT / "runtime" / "state" / "policy-fingerprint.json")
    )
    try:
        digest = hashlib.sha256(policy_path.read_bytes()).hexdigest()
    except Exception:
        # A missing/unreadable policy is already runtime_policy_error.
        return {"runtime_policy_unrecorded": 0, "runtime_policy_sha": None}
    try:
        recorded = json.loads(record_path.read_text(encoding="utf-8")).get("sha256")
    except Exception:
        recorded = None
    return {
        "runtime_policy_unrecorded": int(recorded != digest),
        "runtime_policy_sha": digest[:16],
    }


def checkout_integrity(run=subprocess.run):
    """Fail closed when the serving checkout leaves clean local main."""
    metrics = {
        "runtime_git_wrong_branch": 0,
        "runtime_git_dirty": 0,
        "runtime_git_check_error": 0,
    }
    try:
        branch = run(
            ["git", "-C", str(ROOT), "branch", "--show-current"],
            check=True,
            timeout=10,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = run(
            ["git", "-C", str(ROOT), "status", "--porcelain=v1", "--untracked-files=all"],
            check=True,
            timeout=10,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except Exception:
        metrics["runtime_git_check_error"] = 1
        return metrics
    metrics["runtime_git_wrong_branch"] = int(branch != "main")
    metrics["runtime_git_dirty"] = int(bool(status))
    return metrics


def scalar(con, query):
    return con.execute(query).fetchone()[0]


def inspect(con):
    quick = con.execute("PRAGMA quick_check").fetchone()[0]
    if quick != "ok":
        raise RuntimeError(f"CRM quick_check failed: {quick}")
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    effect_columns = {
        row[1] for row in con.execute("PRAGMA table_info(workflow_effects)")
    } if "workflow_effects" in tables else set()
    reviews_available = "workflow_manual_reviews" in tables
    verification_modes_available = {"verification_mode", "verification_deadline_at"}.issubset(effect_columns)
    metrics = {
        "schema_migration_required": int(not reviews_available or not verification_modes_available),
        "queued_runs_over_1m": scalar(con, """SELECT COUNT(*) FROM workflow_runs
            WHERE status='queued' AND julianday(created_at)<julianday('now','-1 minute')"""),
        "stalled_runs": scalar(con, """SELECT COUNT(*) FROM workflow_runs r
            WHERE r.status='running' AND julianday(r.updated_at)<julianday('now','-30 minutes')
              AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id=r.id AND s.status='running')"""),
        "overdue_retries": scalar(con, """SELECT COUNT(*) FROM workflow_steps
            WHERE status='retry' AND julianday(available_at)<julianday('now','-5 minutes')"""),
        "dead_outbox": scalar(con, "SELECT COUNT(*) FROM workflow_outbox WHERE status='dead'"),
        "stale_outbox_leases": scalar(con, """SELECT COUNT(*) FROM workflow_outbox
            WHERE status='leased' AND julianday(lease_expires_at)<julianday('now')"""),
        "stale_step_leases": scalar(con, """SELECT COUNT(*) FROM workflow_steps
            WHERE status='running' AND julianday(lease_expires_at)<julianday('now')"""),
        "open_manual_reviews": scalar(con, "SELECT COUNT(*) FROM workflow_manual_reviews WHERE status='open'")
            if reviews_available else 0,
        "oldest_pending_outbox_minutes": scalar(con, """SELECT COALESCE(CAST(
            (julianday('now')-julianday(MIN(created_at)))*1440 AS INTEGER),0)
            FROM workflow_outbox WHERE status IN ('pending','leased')"""),
    }
    resolved_review_filter = """AND NOT EXISTS (SELECT 1 FROM workflow_manual_reviews mr
        WHERE mr.run_id=r.id AND mr.status='resolved')""" if reviews_available else ""
    email_command_rejection = """r.workflow_name='email.reply.propose'
        AND r.trigger_type='slack_email_reply_command'
        AND r.error_message='no recorded inbound message exists for this Slack thread'
        AND NOT EXISTS (SELECT 1 FROM workflow_effects we WHERE we.run_id=r.id)"""
    metrics["email_command_rejections_24h"] = scalar(con, f"""SELECT COUNT(*) FROM workflow_runs r
        WHERE r.status='failed' AND julianday(r.updated_at)>=julianday('now','-24 hours')
        AND ({email_command_rejection})""")
    metrics["failed_24h"] = scalar(con, f"""SELECT COUNT(*) FROM workflow_runs r
        WHERE r.status='failed' AND julianday(r.updated_at)>=julianday('now','-24 hours')
        AND NOT ({email_command_rejection})
        {resolved_review_filter}""")
    effect_review_filter = """AND NOT EXISTS (SELECT 1 FROM workflow_manual_reviews mr
        WHERE mr.effect_id=workflow_effects.id AND mr.status='resolved')""" if reviews_available else ""
    if verification_modes_available:
        metrics["old_unverified_effects"] = scalar(con, f"""SELECT COUNT(*) FROM workflow_effects
            WHERE status NOT IN ('verified_by_readback','delivered','read','failed','manual_review')
              AND (
                (status='requested' AND julianday(requested_at)<julianday('now','-15 minutes'))
                OR (verification_mode='readback_required'
                  AND julianday(COALESCE(verification_deadline_at, datetime(requested_at,'+15 minutes')))<julianday('now'))
              )
              {effect_review_filter}""")
    else:
        metrics["old_unverified_effects"] = scalar(con, f"""SELECT COUNT(*) FROM workflow_effects
            WHERE julianday(requested_at)<julianday('now','-15 minutes')
              AND status NOT IN ('verified_by_readback','delivered','read','failed','manual_review')
              AND (status='requested' OR provider NOT IN ('twilio','meta'))
              {effect_review_filter}""")
    return metrics


def notify(message):
    if not ALERT_CHANNEL or not SLACK_ACCOUNT:
        return False
    subprocess.run([
        OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
        "--target", f"channel:{ALERT_CHANNEL}", "--message", message, "--json",
    ], check=True, timeout=30, capture_output=True)
    return True


def incident_alert_active(path=ALERT_STATE_PATH):
    try:
        state = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return state.get("active") is True if isinstance(state, dict) else False


def set_incident_alert_active(active, path=ALERT_STATE_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "active": bool(active),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    fd, temporary_path = tempfile.mkstemp(
        prefix=".workflow-health-alert-", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.write("\n")
        os.replace(temporary_path, path)
    finally:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass


def notify_incident_once(message, notify_fn=notify, path=ALERT_STATE_PATH):
    if incident_alert_active(path):
        return False
    if not notify_fn(message):
        return False
    set_incident_alert_active(True, path)
    return True


def hard_failure_count(metrics, alert_config_missing=0):
    return sum([
        metrics.get("runtime_process_missing", 0), metrics.get("runtime_code_drift", 0),
        metrics.get("runtime_process_check_error", 0),
        metrics.get("runtime_git_wrong_branch", 0), metrics.get("runtime_git_dirty", 0),
        metrics.get("runtime_git_check_error", 0),
        metrics.get("runtime_graph_agents_missing", 0), metrics.get("runtime_policy_error", 0),
        metrics.get("scheduled_graph_missing", 0), metrics.get("scheduled_graph_stale", 0),
        metrics.get("scheduled_graph_failed", 0),
        metrics.get("schema_migration_required", 0), metrics.get("queued_runs_over_1m", 0),
        metrics.get("stalled_runs", 0), metrics.get("overdue_retries", 0), metrics.get("dead_outbox", 0),
        metrics.get("stale_outbox_leases", 0), metrics.get("stale_step_leases", 0),
        metrics.get("open_manual_reviews", 0), metrics.get("failed_24h", 0),
        metrics.get("old_unverified_effects", 0),
        int(metrics.get("oldest_pending_outbox_minutes", 0) > 5), int(alert_config_missing),
    ])


def alert_configuration_missing(check_only, alert_channel=ALERT_CHANNEL, slack_account=SLACK_ACCOUNT):
    return int(not check_only and (not alert_channel or not slack_account))


def main(check_only=False):
    if not DB_PATH.is_file():
        raise RuntimeError(f"CRM database missing: {DB_PATH}")
    try:
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    except Exception:
        policy = None
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=20)
    try:
        metrics = inspect(con)
        if policy is not None:
            metrics.update(scheduled_graph_integrity(con, policy))
    finally:
        con.close()
    # An operator-side deployment check may not inherit the LaunchAgent's
    # notification environment. It still enforces every runtime/data metric,
    # but it must not update the scheduled job record or emit a duplicate
    # Slack alert.
    alert_config_missing = alert_configuration_missing(check_only)
    metrics.update(runtime_integrity())
    metrics.update(checkout_integrity())
    metrics.update(policy_fingerprint_integrity())
    try:
        if policy is None:
            raise RuntimeError("workflow policy is unavailable")
        metrics.update(graph_agent_integrity(policy))
    except Exception:
        metrics.update({"runtime_graph_agents_missing": 0, "runtime_policy_error": 1})
    metrics["alert_config_missing"] = alert_config_missing
    hard_failures = hard_failure_count(metrics, alert_config_missing)
    detail = json.dumps({"observed_at": datetime.now(timezone.utc).isoformat(), **metrics}, sort_keys=True)
    if hard_failures:
        if not check_only:
            record(JOB_NAME, False, detail)
            # Slack is edge-triggered; local status and Healthchecks still
            # record every failed interval while the incident remains open.
            notify_incident_once("*Workflow integrity alert*\n```" + detail + "```")
        raise RuntimeError(detail)
    if not check_only:
        record(JOB_NAME, True, detail)
        if incident_alert_active():
            set_incident_alert_active(False)
    print(detail)


if __name__ == "__main__":
    try:
        unknown = [arg for arg in sys.argv[1:] if arg != "--check-only"]
        if unknown:
            raise RuntimeError(f"unknown argument(s): {' '.join(unknown)}")
        main(check_only="--check-only" in sys.argv[1:])
    except Exception as exc:
        print(f"workflow_health: {exc}", file=sys.stderr)
        sys.exit(1)
