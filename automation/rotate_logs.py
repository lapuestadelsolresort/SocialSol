#!/usr/bin/env python3
"""Compress oversized resort logs in place and retain a bounded history."""

import gzip
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from job_health import record

ROOT = Path(__file__).resolve().parent.parent
LOG_DIRS = [ROOT / "logs", ROOT / "crm" / "logs"]
MIN_BYTES = 10 * 1024 * 1024
KEEP = 14
JOB_NAME = "resort-log-rotation"


def rotate(path):
    if path.stat().st_size < MIN_BYTES:
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = path.with_name(f"{path.name}.{stamp}.gz")
    with path.open("rb+") as source, gzip.open(archive, "wb", compresslevel=6) as target:
        shutil.copyfileobj(source, target, length=1024 * 1024)
        source.seek(0)
        source.truncate()
    os.chmod(archive, 0o600)
    archives = sorted(path.parent.glob(f"{path.name}.*.gz"), reverse=True)
    for old in archives[KEEP:]:
        old.unlink()
    return archive


def main():
    rotated = []
    for directory in LOG_DIRS:
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if path.is_file() and not path.name.endswith(".gz"):
                archive = rotate(path)
                if archive:
                    rotated.append(str(archive))
    record(JOB_NAME, True, f"rotated:{len(rotated)}")
    print(f"rotated {len(rotated)} log(s)")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        raise
