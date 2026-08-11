#!/usr/bin/env python3
"""Fail closed on stalled durable workflows, dead outbox rows, or DB damage."""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from job_health import record

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm" / "data" / "crm.db"))
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
ALERT_CHANNEL = os.environ.get("RESORT_OPS_ALERTS_CHANNEL", "")
JOB_NAME = "resort-workflow-health"


def scalar(con, query):
    return con.execute(query).fetchone()[0]


def inspect(con):
    quick = con.execute("PRAGMA quick_check").fetchone()[0]
    if quick != "ok":
        raise RuntimeError(f"CRM quick_check failed: {quick}")
    metrics = {
        "stalled_runs": scalar(con, """SELECT COUNT(*) FROM workflow_runs
            WHERE status IN ('running','retry')
              AND julianday(updated_at)<julianday('now','-30 minutes')"""),
        "dead_outbox": scalar(con, "SELECT COUNT(*) FROM workflow_outbox WHERE status='dead'"),
        "stale_leases": scalar(con, """SELECT COUNT(*) FROM workflow_outbox
            WHERE status='leased' AND julianday(lease_expires_at)<julianday('now')"""),
        "failed_24h": scalar(con, """SELECT COUNT(*) FROM workflow_runs
            WHERE status='failed' AND julianday(updated_at)>=julianday('now','-24 hours')"""),
        "unverified_effects_24h": scalar(con, """SELECT COUNT(*) FROM workflow_effects
            WHERE julianday(requested_at)>=julianday('now','-24 hours')
              AND status NOT IN ('verified_by_readback','delivered','read','failed')"""),
    }
    return metrics


def notify(message):
    if not ALERT_CHANNEL or not SLACK_ACCOUNT:
        return False
    subprocess.run([
        OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
        "--target", f"channel:{ALERT_CHANNEL}", "--message", message, "--json",
    ], check=True, timeout=30, capture_output=True)
    return True


def main():
    if not DB_PATH.is_file():
        raise RuntimeError(f"CRM database missing: {DB_PATH}")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=20)
    try:
        metrics = inspect(con)
    finally:
        con.close()
    hard_failures = metrics["stalled_runs"] + metrics["dead_outbox"] + metrics["stale_leases"]
    detail = json.dumps({"observed_at": datetime.now(timezone.utc).isoformat(), **metrics}, sort_keys=True)
    if hard_failures:
        record(JOB_NAME, False, detail)
        notify("*Workflow integrity alert*\n```" + detail + "```")
        raise RuntimeError(detail)
    record(JOB_NAME, True, detail)
    print(detail)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"workflow_health: {exc}", file=sys.stderr)
        sys.exit(1)
