#!/usr/bin/env python3
"""Parse every LaunchAgent template and enforce portable deployment paths."""

from pathlib import Path
import plistlib

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "deploy" / "launchagents" / "templates"
labels = set()
count = 0
calendar_by_label = {}
interval_by_label = {}

for template in sorted(TEMPLATES.glob("*.plist.template")):
    raw = template.read_text(encoding="utf-8")
    forbidden = ("/Users/", ".openclaw", "workspace-resort")
    hits = [value for value in forbidden if value in raw]
    if hits:
        raise RuntimeError(f"{template.name}: legacy/private path marker: {hits}")

    rendered = (
        raw.replace("__SOCIALSOL_ROOT__", "/tmp/socialsol")
        .replace("__NODE_BIN__", "/usr/bin/node")
        .replace("__PYTHON_BIN__", "/usr/bin/python3")
    )
    data = plistlib.loads(rendered.encode("utf-8"))
    label = data.get("Label")
    arguments = data.get("ProgramArguments")
    if not label or label in labels:
        raise RuntimeError(f"{template.name}: missing or duplicate Label {label!r}")
    if not isinstance(arguments, list) or len(arguments) < 2:
        raise RuntimeError(f"{template.name}: invalid ProgramArguments")
    if label == "com.lapuestadelsolresort.workflow-health":
        runtime_path = data.get("EnvironmentVariables", {}).get("PATH", "")
        if "/opt/homebrew/bin" not in runtime_path:
            raise RuntimeError(f"{template.name}: workflow alerts require Homebrew Node on PATH")
    labels.add(label)
    calendar_by_label[label] = data.get("StartCalendarInterval")
    interval_by_label[label] = data.get("StartInterval")
    count += 1

if count == 0:
    raise RuntimeError("no LaunchAgent templates found")

# F-064: the graphs that write the shared CRM database on an interval must be
# de-phased. StartInterval fires every one of them at the same second (the
# phase is the deploy's load time), which is how paulina.daily,
# squarespace.crm.sync and ownerrez.crm.sync came to collide on the write lock.
# Each grid member therefore declares explicit wall-clock minutes, the minute
# sets are pairwise disjoint, and :00/:30 stay free for the daily calendar
# jobs that already cluster there.
GRID_LABELS = {
    "com.lapuestadelsolresort.graph-paulina",
    "com.lapuestadelsolresort.graph-squarespace-sync",
    "com.lapuestadelsolresort.graph-social-publish",
    "com.lapuestadelsolresort.graph-accounting-inbox",
    "com.lapuestadelsolresort.graph-crm-sync",
    "com.lapuestadelsolresort.graph-receipt-reconcile",
}
RESERVED_MINUTES = {0, 30}
minutes_by_label = {}
for label in sorted(GRID_LABELS):
    if label not in calendar_by_label:
        raise RuntimeError(f"{label}: grid template missing")
    if interval_by_label.get(label) is not None:
        raise RuntimeError(f"{label}: StartInterval is phase-aligned at load; declare StartCalendarInterval minutes (F-064)")
    calendar = calendar_by_label[label]
    entries = calendar if isinstance(calendar, list) else [calendar]
    minutes = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"Minute"}:
            raise RuntimeError(f"{label}: grid schedules must be Minute-only StartCalendarInterval entries")
        minute = int(entry["Minute"])
        if not 0 <= minute <= 59:
            raise RuntimeError(f"{label}: minute {minute} is out of range")
        minutes.add(minute)
    if not minutes:
        raise RuntimeError(f"{label}: grid schedule declares no minutes")
    if minutes & RESERVED_MINUTES:
        raise RuntimeError(f"{label}: minutes {sorted(minutes & RESERVED_MINUTES)} are reserved for the daily calendar jobs")
    for other, other_minutes in minutes_by_label.items():
        shared = minutes & other_minutes
        if shared:
            raise RuntimeError(f"{label} and {other} both fire at minute(s) {sorted(shared)} — grid must stay de-phased (F-064)")
    minutes_by_label[label] = minutes

print(f"LaunchAgent template checks passed ({count} definitions; {len(minutes_by_label)} de-phased CRM grid graphs).")
