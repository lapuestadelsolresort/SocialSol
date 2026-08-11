#!/usr/bin/env python3
"""Decrypt the latest offsite-format CRM backup into a temp dir and verify it."""

import gzip
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from job_health import record

ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = Path(os.environ.get("CRM_BACKUP_DIR", ROOT / "backups" / "resort-crm"))
SECRETS_DIR = Path(os.environ.get("SOCIALSOL_SECRETS_DIR", ROOT / "secrets"))
CONFIG_PATH = Path(os.environ.get("CRM_BACKUP_CONFIG", SECRETS_DIR / "resort-backup.json"))
OPENSSL = "/opt/homebrew/bin/openssl"
JOB_NAME = "resort-crm-restore-drill"


def main():
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    passphrase = Path(config.get("passphrase_file") or "")
    if not passphrase.is_file():
        raise RuntimeError("backup encryption passphrase is not configured")
    backups = sorted(BACKUP_DIR.glob("crm-*.db.gz.enc"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not backups:
        raise RuntimeError("no encrypted CRM backup is available for restore drill")
    latest = backups[0]
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
            required = {"contacts", "leads", "workflow_runs", "workflow_outbox"}
            missing = sorted(required - tables)
            if missing:
                raise RuntimeError(f"restored database is missing critical tables: {missing}")
            counts = {table: con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in sorted(required)}
        finally:
            con.close()
    detail = json.dumps({"backup": latest.name, "quick_check": "ok", "counts": counts}, sort_keys=True)
    record(JOB_NAME, True, detail)
    print(detail)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"backup_restore_drill: {exc}", file=sys.stderr)
        sys.exit(1)
