#!/usr/bin/env python3
"""Checksum verification of the owner-maintained offline media-originals copy
(F-032e; PIPELINE.md mandates a checksum-verified offline backup).

Weekly behavior:
- offline copy configured + mounted → compare the local originals tree against
  the copy (presence + size for every file; sha256 for new/changed files and a
  random sample) and refresh the verification state.
- not mounted / not yet configured → OK within the grace window since the last
  successful verification (or the owner's attestation date), FAILED beyond it,
  so an unverified backup cannot stay silently green forever.

Config lives in secrets/resort-backup.json:
  "media_offline": { "mount_root": "/Volumes/<drive>/<originals-root>",
                     "attested_at": "2026-08-17" }
"""

import hashlib
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from crm_backup import load_config
from job_health import record
from runtime_paths import runtime_state_path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = Path(os.environ.get("MEDIA_ORIGINALS_DIR", ROOT / "media" / "originals"))
STATE_PATH = Path(runtime_state_path("media-backup-verify.json"))
JOB_NAME = "resort-media-backup-verify"
GRACE_DAYS = 35
HASH_SAMPLE = 20


def read_state():
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_when(value):
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def source_files():
    files = []
    for path in sorted(SOURCE_ROOT.rglob("*")):
        if path.is_file() and not path.name.startswith("._"):
            files.append(path)
    return files


def verify_against_mount(mount_root, last_verified):
    problems = []
    hashed = 0
    files = source_files()
    changed = []
    for path in files:
        relative = path.relative_to(SOURCE_ROOT)
        copy = mount_root / relative
        if not copy.is_file():
            problems.append(f"missing on offline copy: {relative}")
            continue
        size = path.stat().st_size
        if copy.stat().st_size != size:
            problems.append(f"size mismatch: {relative}")
            continue
        if last_verified is None or datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc) > last_verified:
            changed.append((path, copy, relative))
    unchanged = [
        (path, mount_root / path.relative_to(SOURCE_ROOT), path.relative_to(SOURCE_ROOT))
        for path in files
        if path.is_file() and (mount_root / path.relative_to(SOURCE_ROOT)).is_file()
    ]
    sample = changed + random.sample(unchanged, min(HASH_SAMPLE, len(unchanged)))
    for path, copy, relative in sample:
        if sha256_file(path) != sha256_file(copy):
            problems.append(f"sha256 mismatch: {relative}")
        hashed += 1
    return problems, len(files), hashed


def main():
    config = (load_config() or {}).get("media_offline") or {}
    state = read_state()
    now = datetime.now(timezone.utc)
    last_verified = parse_when(state.get("last_verified_at"))
    attested = parse_when(config.get("attested_at"))
    baseline = last_verified or attested
    grace_ok = baseline is not None and (now - baseline) <= timedelta(days=GRACE_DAYS)

    mount_root = Path(config["mount_root"]) if config.get("mount_root") else None
    if mount_root is None or not mount_root.is_dir():
        reason = "offline copy not configured" if mount_root is None else f"offline copy not mounted at {mount_root}"
        if grace_ok:
            due = (baseline + timedelta(days=GRACE_DAYS)).date().isoformat()
            record(JOB_NAME, True, f"{reason}; within grace, verification due by {due}")
            print(f"media-backup-verify: {reason}; within grace (due {due})")
            return
        record(JOB_NAME, False, f"{reason}; no successful verification within {GRACE_DAYS}d")
        print(f"media-backup-verify: {reason}; grace expired", file=sys.stderr)
        sys.exit(1)

    problems, total, hashed = verify_against_mount(mount_root, last_verified)
    if problems:
        detail = f"{len(problems)} problem(s) across {total} file(s); first: {problems[0]}"
        record(JOB_NAME, False, detail[:300])
        print("media-backup-verify FAILED:")
        for problem in problems[:20]:
            print(f"  - {problem}")
        sys.exit(1)

    state.update({
        "last_verified_at": now.isoformat(),
        "files_checked": total,
        "files_hashed": hashed,
        "mount_root": str(mount_root),
    })
    write_state(state)
    record(JOB_NAME, True, f"verified {total} file(s), hashed {hashed}")
    print(f"media-backup-verify: verified {total} file(s) against {mount_root} (hashed {hashed})")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"media_backup_verify: {exc}", file=sys.stderr)
        sys.exit(1)
