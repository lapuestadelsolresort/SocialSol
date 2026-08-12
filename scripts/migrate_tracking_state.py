#!/usr/bin/env python3
"""Copy legacy tracked tracking snapshots into ignored runtime storage."""

import argparse
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "automation"))

from runtime_paths import runtime_state_dir  # noqa: E402


SNAPSHOTS = (
    "tracker-liveness.json",
    "tracking-health.json",
    "tracking-verification.json",
)


def atomic_copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and source.read_bytes() == destination.read_bytes():
        return {"status": "unchanged", "backup": None}
    backup = None
    if destination.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = destination.with_name(f"{destination.name}.{stamp}.bak")
        counter = 1
        while backup.exists():
            backup = destination.with_name(f"{destination.name}.{stamp}.{counter}.bak")
            counter += 1
        shutil.copy2(destination, backup)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}-", suffix=".tmp", dir=destination.parent
    )
    os.close(fd)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return {"status": "copied", "backup": str(backup) if backup else None}


def migrate(source_root=ROOT, destination=None):
    source_dir = Path(source_root).expanduser().resolve() / "state"
    destination_dir = (
        Path(destination).expanduser().resolve()
        if destination
        else runtime_state_dir(source_root)
    )
    results = []
    for filename in SNAPSHOTS:
        source = source_dir / filename
        target = destination_dir / filename
        if not source.is_file():
            results.append({"filename": filename, "status": "missing", "destination": str(target)})
            continue
        outcome = atomic_copy(source, target)
        results.append({
            "filename": filename,
            "status": outcome["status"],
            "destination": str(target),
            "backup": outcome["backup"],
        })
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default=str(ROOT))
    parser.add_argument("--destination")
    args = parser.parse_args()
    results = migrate(args.source_root, args.destination)
    print(json.dumps({"ok": True, "results": results}, indent=2))


if __name__ == "__main__":
    main()
