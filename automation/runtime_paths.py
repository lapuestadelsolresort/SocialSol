#!/usr/bin/env python3
"""Central paths for mutable SocialSol runtime state."""

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def runtime_state_dir(root=ROOT):
    """Return the ignored directory used for generated cross-job state."""
    base = Path(root).expanduser().resolve()
    configured = os.environ.get("SOCIALSOL_RUNTIME_STATE_DIR")
    if not configured:
        return base / "runtime" / "state"
    candidate = Path(configured).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.resolve()


def runtime_state_path(filename, root=ROOT):
    """Resolve one flat runtime-state filename without permitting traversal."""
    name = str(filename or "")
    if not name or Path(name).name != name or name in {".", ".."}:
        raise ValueError("runtime state filename must be a plain filename")
    return runtime_state_dir(root) / name
