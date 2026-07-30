#!/usr/bin/env python3
"""Create, verify, encrypt, and optionally upload a daily CRM backup."""

import gzip
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from job_health import get_status, record

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(os.environ.get("CRM_DB_PATH", ROOT / "crm" / "data" / "crm.db"))
BACKUP_DIR = Path(os.environ.get("CRM_BACKUP_DIR", ROOT / "backups" / "resort-crm"))
SECRETS_DIR = Path(os.environ.get("SOCIALSOL_SECRETS_DIR", ROOT / "secrets"))
CONFIG_PATH = Path(os.environ.get(
    "CRM_BACKUP_CONFIG",
    SECRETS_DIR / "resort-backup.json",
))
OPENSSL = "/opt/homebrew/bin/openssl"
GOG = "/opt/homebrew/bin/gog"
JOB_NAME = "resort-crm-backup"


def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def verify(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        result = con.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"backup integrity check failed: {result}")
    finally:
        con.close()


def make_backup(destination):
    source = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    os.chmod(destination, 0o600)
    verify(destination)


def encrypt(source, destination, passphrase_file):
    subprocess.run(
        [
            OPENSSL, "enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-iter", "200000",
            "-in", str(source), "-out", str(destination), "-pass", f"file:{passphrase_file}",
        ],
        check=True,
        timeout=180,
        capture_output=True,
    )
    os.chmod(destination, 0o600)


def upload(path, config):
    folder = config.get("drive_folder_id")
    account = config.get("drive_account")
    if not folder:
        raise RuntimeError("offsite Drive folder is not configured")
    cmd = [GOG, "drive", "upload", str(path), "--parent", folder, "--name", path.name, "--json", "--no-input"]
    if account:
        cmd.extend(["--account", account])
    subprocess.run(cmd, check=True, timeout=300, capture_output=True, text=True)


def prune_local(keep=30):
    files = sorted(BACKUP_DIR.glob("crm-*.db.gz.enc"), reverse=True)
    for old in files[keep:]:
        old.unlink()


def main():
    if not SOURCE.exists():
        raise RuntimeError(f"CRM database missing: {SOURCE}")
    config = load_config()
    passphrase_file = Path(config.get("passphrase_file") or "")
    if not passphrase_file.is_file():
        raise RuntimeError("backup encryption passphrase is not configured")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    plain = BACKUP_DIR / f".crm-{stamp}.db.tmp"
    compressed = BACKUP_DIR / f".crm-{stamp}.db.gz.tmp"
    encrypted = BACKUP_DIR / f"crm-{stamp}.db.gz.enc"
    previous = get_status(JOB_NAME)
    if previous.get("status") == "ok" and previous.get("detail") == encrypted.name and encrypted.is_file():
        print(f"backup already completed today: {encrypted}")
        return

    try:
        make_backup(plain)
        with plain.open("rb") as src, gzip.open(compressed, "wb", compresslevel=6) as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
        encrypt(compressed, encrypted, passphrase_file)
        upload(encrypted, config)
        prune_local()
        record(JOB_NAME, True, encrypted.name)
        print(f"verified encrypted backup uploaded: {encrypted}")
    finally:
        for tmp in (
            plain,
            Path(str(plain) + "-wal"),
            Path(str(plain) + "-shm"),
            compressed,
        ):
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"crm_backup: {exc}", file=sys.stderr)
        sys.exit(1)
