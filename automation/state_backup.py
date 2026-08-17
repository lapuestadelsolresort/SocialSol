#!/usr/bin/env python3
"""Nightly encrypted backup of the small non-CRM state stores (F-032a/b):
paloma/data/tasks.db, workflow/policy.json, and the OpenClaw gateway config.
Rides the crm_backup pipeline: same passphrase file, same offsite Drive
folder, same job_health/watchdog wiring."""

import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from crm_backup import encrypt, load_config, upload
from job_health import get_status, record

ROOT = Path(__file__).resolve().parent.parent
TASKS_DB = Path(os.environ.get("PALOMA_TASKS_DB", ROOT / "paloma" / "data" / "tasks.db"))
POLICY_PATH = Path(os.environ.get("RESORT_WORKFLOW_POLICY_PATH", ROOT / "workflow" / "policy.json"))
OPENCLAW_CONFIG = Path(os.environ.get(
    "OPENCLAW_CONFIG_PATH",
    Path.home() / ".openclaw" / "openclaw.json",
))
BACKUP_DIR = Path(os.environ.get("STATE_BACKUP_DIR", ROOT / "backups" / "resort-state"))
JOB_NAME = "resort-state-backup"
KEEP = 30


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_tasks_db(destination):
    """Consistent copy of the hot tasks.db via the SQLite online backup API —
    never a file copy while WAL may be active (§4.4)."""
    source = sqlite3.connect(f"file:{TASKS_DB}?mode=ro", uri=True)
    target = sqlite3.connect(str(destination))
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    check = sqlite3.connect(f"file:{destination}?mode=ro", uri=True)
    try:
        result = check.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"tasks.db snapshot integrity check failed: {result}")
    finally:
        check.close()


def prune_local(keep=KEEP):
    files = sorted(BACKUP_DIR.glob("state-*.tar.gz.enc"), reverse=True)
    for old in files[keep:]:
        old.unlink()


def main():
    for required in (TASKS_DB, POLICY_PATH, OPENCLAW_CONFIG):
        if not required.exists():
            raise RuntimeError(f"state store missing: {required}")
    config = load_config()
    passphrase_file = Path(config.get("passphrase_file") or "")
    if not passphrase_file.is_file():
        raise RuntimeError("backup encryption passphrase is not configured")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o700)
    force = "--force" in sys.argv[1:]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ" if force else "%Y-%m-%d")
    encrypted = BACKUP_DIR / f"state-{stamp}.tar.gz.enc"
    previous = get_status(JOB_NAME)
    if not force and previous.get("status") == "ok" and previous.get("detail") == encrypted.name and encrypted.is_file():
        print(f"state backup already completed today: {encrypted}")
        return

    with tempfile.TemporaryDirectory(dir=BACKUP_DIR) as workdir:
        work = Path(workdir)
        db_snapshot = work / "tasks.db"
        snapshot_tasks_db(db_snapshot)
        members = {
            "tasks.db": db_snapshot,
            "policy.json": POLICY_PATH,
            "openclaw.json": OPENCLAW_CONFIG,
        }
        metadata = {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "sources": {
                "tasks.db": str(TASKS_DB),
                "policy.json": str(POLICY_PATH),
                "openclaw.json": str(OPENCLAW_CONFIG),
            },
            "sha256": {name: sha256_file(path) for name, path in members.items()},
            "bytes": {name: path.stat().st_size for name, path in members.items()},
        }
        metadata_path = work / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        plain_tar = work / "state.tar"
        with tarfile.open(plain_tar, "w") as archive:
            for name, path in {**members, "metadata.json": metadata_path}.items():
                archive.add(path, arcname=name)
        compressed = work / "state.tar.gz"
        with plain_tar.open("rb") as src, gzip.open(compressed, "wb", compresslevel=6) as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
        encrypt(compressed, encrypted, passphrase_file)

    upload(encrypted, config)
    prune_local()
    record(JOB_NAME, True, encrypted.name)
    print(f"verified encrypted state backup uploaded: {encrypted}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"state_backup: {exc}", file=sys.stderr)
        sys.exit(1)
