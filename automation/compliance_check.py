#!/usr/bin/env python3
"""Resort-specific compliance gate for LP and campaign copy.

The gate is deterministic and conservative. Generated artifacts that fail are
discarded by generators and logged to optimizer_compliance_failures. Human edits
can still be accepted as operator decisions, but the failure remains visible.
"""

import argparse
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RULES_MD = os.path.join(ROOT, "brand", "resort-compliance-rules.md")
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))

NON_COPY_KEYS = {
    "slug", "id", "language", "source", "audience", "status", "type",
    "traffic_weight", "page_slug", "experiment_id", "url", "href", "link",
    "image", "img", "src", "utm_source", "utm_medium", "utm_campaign",
    "utm_content", "created_by", "approved_by", "meta_object_id",
}

SCARCITY_RE = re.compile(r"\b(limited|last chance|only\s+\d+|few dates|spots? left|% off|discount|deal)\b", re.I)
SCARCITY_BASIS_KEYS = {"urgency_basis", "availability_source", "offer_terms"}
CAPACITY_RE = re.compile(r"\b(?:sleeps?|hosts?|for|up to)\s+(\d{2,3})\s*(guests?|people|attendees?|rooms?|bedrooms?)\b", re.I)
CAPACITY_QUALIFIER_RE = re.compile(r"\b(up to|about|approximately|approx\.?|typical|ideal for|best for)\b", re.I)
AIRPORT_DISTANCE_RE = re.compile(r"\b\d+\s*(?:minutes?|mins?)\b", re.I)
AIRPORT_CONTEXT_RE = re.compile(r"\b(Puerto Vallarta|PVR|airport|Riviera Nayarit|Sayulita|San Pancho)\b", re.I)
INSTANT_BOOKING_RE = re.compile(r"\b(instant(?:ly)? confirmed|book(?:ing)? guaranteed|guaranteed confirmation)\b", re.I)


def die(code, msg):
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_hard_blocks(path):
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        die(2, f"compliance_check: rules file not found at {path}")
    in_section = False
    phrases = []
    for raw in lines:
        line = raw.strip()
        if line.lower() == "hard blocks:":
            in_section = True
            continue
        if in_section and line.lower().startswith("positive checks:"):
            break
        if in_section and line.startswith("- "):
            phrases.append(line[2:].strip().lower())
    return phrases


def html_to_text(html):
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    return re.sub(r"\s+", " ", text).strip()


def collect_strings(node, label, out):
    if isinstance(node, str):
        s = node.strip()
        if s and (" " in s or len(s) > 30):
            out.append((label, s))
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if key in NON_COPY_KEYS:
                continue
            collect_strings(value, f"{label}.{key}" if label else key, out)
    elif isinstance(node, list):
        for idx, value in enumerate(node):
            collect_strings(value, f"{label}[{idx}]", out)


def extract_texts(artifact):
    if isinstance(artifact, str):
        return [("html", html_to_text(artifact))]
    out = []
    if isinstance(artifact, dict):
        collect_strings(artifact, "", out)
    return out


def has_basis(artifact):
    if not isinstance(artifact, dict):
        return False
    return any(bool(artifact.get(key)) for key in SCARCITY_BASIS_KEYS)


def check_artifact(artifact, phrases=None, kind=None):
    phrases = phrases if phrases is not None else load_hard_blocks(RULES_MD)
    texts = extract_texts(artifact)
    blob = " \n ".join(text for _, text in texts)
    failures = []

    for label, text in texts:
        for phrase in phrases:
            if re.search(r"\b" + re.escape(phrase) + r"\b", text, re.I):
                failures.append({
                    "rule": "hard_block",
                    "label": label,
                    "text": text,
                    "trigger": phrase,
                })

    if SCARCITY_RE.search(blob) and not has_basis(artifact):
        failures.append({
            "rule": "unsupported_scarcity_or_discount",
            "label": "artifact",
            "text": blob[:240],
            "trigger": "scarcity, urgency, or discount language without a basis key",
        })

    for label, text in texts:
        if CAPACITY_RE.search(text) and not CAPACITY_QUALIFIER_RE.search(text):
            failures.append({
                "rule": "capacity_without_qualifier",
                "label": label,
                "text": text,
                "trigger": "exact capacity claim should be qualified",
            })
        if AIRPORT_DISTANCE_RE.search(text) and not AIRPORT_CONTEXT_RE.search(text):
            failures.append({
                "rule": "travel_distance_without_context",
                "label": label,
                "text": text,
                "trigger": "minutes-away claim needs airport or region context",
            })
        m = INSTANT_BOOKING_RE.search(text)
        if m:
            failures.append({
                "rule": "instant_booking_claim",
                "label": label,
                "text": text,
                "trigger": m.group(0),
            })

    return len(failures) == 0, failures


def log_failures(failures, artifact, source, draft_id=None, channel=None, db_path=DB_PATH):
    if not failures:
        return
    did = draft_id or (artifact.get("slug") if isinstance(artifact, dict) else "<html>")
    try:
        con = sqlite3.connect(db_path, timeout=10)
        con.execute(
            "CREATE TABLE IF NOT EXISTS optimizer_compliance_failures ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), "
            "draft_id TEXT, channel TEXT, failed_check TEXT, details TEXT, source TEXT DEFAULT 'agent_generated')"
        )
        for f in failures:
            con.execute(
                "INSERT INTO optimizer_compliance_failures (draft_id, channel, failed_check, details, source) "
                "VALUES (?, ?, ?, ?, ?)",
                (str(did), str(channel or "unknown"), f"{f['rule']}: {f['trigger']}", f["text"][:1000], source),
            )
        con.commit()
        con.close()
    except sqlite3.Error as e:
        print(f"compliance_check: WARN could not log failure: {e}", file=sys.stderr)


def load_artifact(path):
    if path.lower().endswith((".html", ".htm")):
        try:
            return open(path, encoding="utf-8").read()
        except FileNotFoundError:
            die(2, f"compliance_check: artifact not found: {path}")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        die(2, f"compliance_check: artifact not found: {path}")
    except json.JSONDecodeError as e:
        die(2, f"compliance_check: invalid JSON in {path}: {e}")


def main():
    ap = argparse.ArgumentParser(description="Resort marketing compliance gate")
    ap.add_argument("artifact")
    ap.add_argument("--source")
    ap.add_argument("--draft-id", dest="draft_id")
    ap.add_argument("--channel")
    args = ap.parse_args()

    artifact = load_artifact(args.artifact)
    phrases = load_hard_blocks(RULES_MD)
    ok, failures = check_artifact(artifact, phrases=phrases, kind=args.channel)
    if not ok:
        for f in failures:
            print(f'FAIL [{f["rule"]} @ {f["label"]}]: "{f["text"][:160]}"')
            print(f'  triggered: {f["trigger"]}')
        if args.source:
            log_failures(failures, artifact, args.source, draft_id=args.draft_id, channel=args.channel)
        sys.exit(1)
    aid = artifact.get("slug", "<no-id>") if isinstance(artifact, dict) else "<html>"
    print(f"OK: {aid} passed resort compliance ({len(phrases)} hard blocks + 4 positive checks)")


if __name__ == "__main__":
    main()
