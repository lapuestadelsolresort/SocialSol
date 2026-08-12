#!/usr/bin/env python3
"""Decrypt the latest offsite-format CRM backup into a temp dir and verify it."""

import gzip
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from job_health import record

ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = Path(os.environ.get("CRM_BACKUP_DIR", ROOT / "backups" / "resort-crm"))
SECRETS_DIR = Path(os.environ.get("SOCIALSOL_SECRETS_DIR", ROOT / "secrets"))
CONFIG_PATH = Path(os.environ.get("CRM_BACKUP_CONFIG", SECRETS_DIR / "resort-backup.json"))
OPENSSL = "/opt/homebrew/bin/openssl"
JOB_NAME = "resort-crm-restore-drill"
MAX_BACKUP_AGE_HOURS = float(os.environ.get("CRM_BACKUP_MAX_AGE_HOURS", "26"))


def main():
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    passphrase = Path(config.get("passphrase_file") or "")
    if not passphrase.is_file():
        raise RuntimeError("backup encryption passphrase is not configured")
    backups = sorted(BACKUP_DIR.glob("crm-*.db.gz.enc"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not backups:
        raise RuntimeError("no encrypted CRM backup is available for restore drill")
    latest = backups[0]
    backup_age_hours = max(0.0, (time.time() - latest.stat().st_mtime) / 3600)
    if backup_age_hours > MAX_BACKUP_AGE_HOURS:
        raise RuntimeError(
            f"latest encrypted CRM backup is stale: {backup_age_hours:.1f}h > {MAX_BACKUP_AGE_HOURS:.1f}h"
        )
    with tempfile.TemporaryDirectory(prefix="socialsol-restore-drill-") as directory:
        gz_path = Path(directory) / "restore.db.gz"
        db_path = Path(directory) / "restore.db"
        subprocess.run([
            OPENSSL, "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
            "-in", str(latest), "-out", str(gz_path), "-pass", f"file:{passphrase}",
        ], check=True, timeout=180, capture_output=True)
        with gzip.open(gz_path, "rb") as source, db_path.open("wb") as target:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            quick = con.execute("PRAGMA quick_check").fetchone()[0]
            if quick != "ok":
                raise RuntimeError(f"restored database quick_check failed: {quick}")
            tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            required = {
                "contacts", "leads", "meta_messages", "ownerrez_events",
                "workflow_runs", "workflow_steps", "workflow_events",
                "workflow_effects", "workflow_evidence", "workflow_outbox",
                "workflow_manual_reviews", "ownerrez_mutation_proposals",
                "accounting_receipts", "accounting_reconciliations",
                "accounting_bank_transactions", "social_content",
            }
            missing = sorted(required - tables)
            if missing:
                raise RuntimeError(f"restored database is missing critical tables: {missing}")
            required_columns = {
                "workflow_runs": {"input_hash", "policy_snapshot_hash", "serialization_key"},
                "workflow_steps": {"lease_token", "lease_version"},
                "workflow_effects": {
                    "manual_review_at", "verification_mode", "verification_deadline_at",
                },
                "workflow_manual_reviews": {
                    "resolution_provider_ref", "review_channel_id",
                },
                "workflow_outbox": {"lease_token", "lease_version"},
            }
            for table, expected_columns in required_columns.items():
                restored_columns = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
                missing_columns = sorted(expected_columns - restored_columns)
                if missing_columns:
                    raise RuntimeError(
                        f"restored database table {table} is missing critical columns: {missing_columns}"
                    )
            counts = {table: con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in sorted(required)}
            foreign_key_failures = list(con.execute("PRAGMA foreign_key_check"))
            if foreign_key_failures:
                raise RuntimeError(f"restored database has {len(foreign_key_failures)} foreign-key violation(s)")
            orphan_effects = con.execute("""SELECT COUNT(*) FROM workflow_effects e
                LEFT JOIN workflow_runs r ON r.id=e.run_id WHERE r.id IS NULL""").fetchone()[0]
            orphan_steps = con.execute("""SELECT COUNT(*) FROM workflow_steps s
                LEFT JOIN workflow_runs r ON r.id=s.run_id WHERE r.id IS NULL""").fetchone()[0]
            if orphan_effects or orphan_steps:
                raise RuntimeError(f"restored workflow ledger has orphans: effects={orphan_effects}, steps={orphan_steps}")
        finally:
            con.close()
    detail = json.dumps({
        "backup": latest.name,
        "backup_age_hours": round(backup_age_hours, 2),
        "quick_check": "ok",
        "counts": counts,
    }, sort_keys=True)
    record(JOB_NAME, True, detail)
    print(detail)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"backup_restore_drill: {exc}", file=sys.stderr)
        sys.exit(1)
