#!/usr/bin/env python3
"""Alert #social-sol when expected resort jobs are failed or stale, or when the
loaded launchd set diverges from the service manifest (producer resurrection,
F-041). The expected-job list and stale thresholds come from
deploy/launchagents/service-manifest.json — never a hand-kept copy here."""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from job_health import STATE_PATH

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MANIFEST_PATH = os.path.join(ROOT, "deploy", "launchagents", "service-manifest.json")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")

# Last-resort staleness coverage if the manifest is unreadable — the watchdog
# must keep alerting on its historical core set while also reporting the
# manifest problem itself.
FALLBACK_EXPECTED = {
    "resort-tracking-health": timedelta(hours=30),
    "resort-weekly-tracking-audit": timedelta(days=8),
    "resort-marketing-reconcile": timedelta(hours=30),
    "resort-lp-phase-gate": timedelta(hours=30),
    "resort-crm-backup": timedelta(hours=30),
    "resort-crm-restore-drill": timedelta(days=8),
    "resort-workflow-health": timedelta(minutes=15),
    "resort-log-rotation": timedelta(days=8),
}


def load_manifest(path=MANIFEST_PATH):
    with open(path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("version") != 1 or "services" not in manifest:
        raise ValueError("service manifest must be version 1 with services")
    return manifest


def expected_from_manifest(manifest):
    expected = {}
    for slug, entry in (manifest.get("watchdog") or {}).items():
        expected[slug] = timedelta(hours=float(entry["max_age_hours"]))
    if not expected:
        raise ValueError("service manifest has no watchdog entries")
    return expected


def loaded_resort_labels(prefix):
    """Labels in our namespace currently loaded in the gui domain. The domain
    dump alone is not proof of loadedness (its disabled section also names
    labels), so each candidate is probed individually."""
    domain = f"gui/{os.getuid()}"
    dump = subprocess.run(
        ["/bin/launchctl", "print", domain],
        capture_output=True, text=True, timeout=60, check=True,
    ).stdout
    candidates = set()
    for token in dump.replace('"', " ").split():
        cleaned = token.strip("{}();,=>")
        if cleaned.startswith(prefix):
            candidates.add(cleaned.split("/")[-1])
    loaded = set()
    for label in sorted(candidates):
        probe = subprocess.run(
            ["/bin/launchctl", "print", f"{domain}/{label}"],
            capture_output=True, text=True, timeout=30,
        )
        if probe.returncode == 0:
            loaded.add(label)
    return loaded


def convergence_problems(manifest, loaded):
    """Loaded-set vs manifest comparison: resurrected retired/disabled
    producers and missing expected services are both alertable drift."""
    prefix = manifest.get("label_prefix", "")
    services = manifest.get("services", {})
    expected_loaded = {f"{prefix}{name}" for name, entry in services.items() if entry.get("state") == "loaded"}
    known = {f"{prefix}{name}" for name in services}
    problems = []
    for label in sorted(loaded - expected_loaded):
        if label in known:
            state = services[label[len(prefix):]]["state"]
            problems.append(f"`{label}` is LOADED but the service manifest says {state} — legacy producer resurrection?")
        else:
            problems.append(f"`{label}` is LOADED but absent from the service manifest")
    for label in sorted(expected_loaded - loaded):
        problems.append(f"`{label}` is expected loaded but is not loaded")
    return problems


def staleness_problems(expected, state, now):
    problems = []
    for job, max_age in expected.items():
        entry = state.get(job)
        if not entry:
            problems.append(f"`{job}` has never reported")
            continue
        try:
            last_run = datetime.fromisoformat(entry["last_run_at"])
        except (KeyError, TypeError, ValueError):
            problems.append(f"`{job}` has invalid status data")
            continue
        age = now - last_run
        if entry.get("status") != "ok":
            problems.append(f"`{job}` failed: {entry.get('detail') or 'no detail'}")
        elif age > max_age:
            problems.append(f"`{job}` is stale ({age.total_seconds() / 3600:.1f}h)")
    return problems


def main():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, json.JSONDecodeError):
        state = {}

    problems = []
    manifest = None
    try:
        manifest = load_manifest()
        expected = expected_from_manifest(manifest)
    except Exception as exc:  # manifest problems must surface, not crash alerting
        expected = FALLBACK_EXPECTED
        problems.append(f"service manifest unreadable ({exc}); using fallback expectations")

    now = datetime.now(timezone.utc)
    problems.extend(staleness_problems(expected, state, now))

    if manifest is not None:
        try:
            loaded = loaded_resort_labels(manifest.get("label_prefix", ""))
            problems.extend(convergence_problems(manifest, loaded))
        except Exception as exc:
            problems.append(f"loaded-set convergence check errored: {exc}")

    if not problems:
        print("job watchdog: all expected jobs healthy; loaded set matches manifest")
        return

    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration is not configured")
    message = "*⚠️ Resort automation health alert*\n" + "\n".join(f"• {item}" for item in problems)
    subprocess.run(
        [
            OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
            "--target", f"channel:{CHANNEL}", "--message", message, "--json",
        ],
        check=True,
        timeout=30,
        capture_output=True,
    )
    print(f"job watchdog: alerted on {len(problems)} problem(s)")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"job_watchdog: {exc}", file=sys.stderr)
        sys.exit(1)
