#!/usr/bin/env python3
"""Parse every LaunchAgent template and enforce portable deployment paths."""

from pathlib import Path
import plistlib

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "deploy" / "launchagents" / "templates"
labels = set()
count = 0

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
    count += 1

if count == 0:
    raise RuntimeError("no LaunchAgent templates found")

print(f"LaunchAgent template checks passed ({count} definitions).")
