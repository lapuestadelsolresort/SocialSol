#!/usr/bin/env python3
"""Small shared health/status helper for resort LaunchAgent jobs."""

import json
import os
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATE_PATH = os.path.join(ROOT, "memory", "job-status.json")
SECRETS_DIR = os.environ.get("SOCIALSOL_SECRETS_DIR", os.path.join(ROOT, "secrets"))
HEALTHCHECKS_PATH = os.path.join(SECRETS_DIR, "healthchecks.json")


def _load(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def get_status(job):
    return _load(STATE_PATH, {}).get(job, {})


def _ping(job, success):
    cfg = _load(HEALTHCHECKS_PATH, {})
    check_id = (cfg.get("checks") or {}).get(job)
    base = str(cfg.get("base_url") or "").rstrip("/")
    if not base or not check_id:
        return False
    suffix = "" if success else "/fail"
    try:
        with urllib.request.urlopen(f"{base}/{check_id}{suffix}", timeout=8):
            return True
    except (OSError, urllib.error.URLError):
        return False


def record(job, success, detail=None):
    state = _load(STATE_PATH, {})
    now = datetime.now(timezone.utc).isoformat()
    previous = state.get(job, {})
    entry = {
        "status": "ok" if success else "failed",
        "last_run_at": now,
        "last_success_at": now if success else previous.get("last_success_at"),
        "detail": detail,
    }
    state[job] = entry
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".job-status-", dir=os.path.dirname(STATE_PATH))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, STATE_PATH)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    _ping(job, success)
