#!/usr/bin/env python3
"""lp_phase_gate.py — watch landing-page telemetry and announce the review gate.

Phase A (telemetry + variant serving) is live for the resort WhatsApp-click
funnel. Once we have enough real sessions to make a decision, post a one-time
kickoff message to #social-sol and record that it fired in
memory/lp-phase-gate.json so it never nags twice. Below threshold it stays
silent on Slack (just prints progress to the log).

Gate (both must hold):
  - total page_sessions               >= MIN_TOTAL
  - the busiest live variant has       >= MIN_PER_VARIANT sessions

Defensive: missing DB / tables yield zeros, never a crash.

Usage:
    lp_phase_gate.py [--dry-run] [--force]
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from job_health import record

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
DB_PATH = os.path.join(ROOT, "crm", "data", "crm.db")
STATE_PATH = os.path.join(ROOT, "memory", "lp-phase-gate.json")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("LP_SOCIAL_CHANNEL") or os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
JOB_NAME = "resort-lp-phase-gate"

MIN_TOTAL = 100        # total sessions before a review is worth it
MIN_PER_VARIANT = 100  # the leading live variant must clear this on its own
NOT_BOT = "is_bot=0"


def la_now():
    try:
        from zoneinfo import ZoneInfo  # py3.9+
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-7)))


def q1(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row and row[0] is not None else 0
    except sqlite3.Error:
        return 0


def qall(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    except sqlite3.Error:
        return []


def gather(db_path):
    """Return (total_sessions, [(page_slug, slug, sessions, conversions), ...])."""
    if not os.path.exists(db_path):
        return 0, []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        total = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT}")
        per_variant = qall(cur, f"""
            SELECT v.page_slug, v.slug,
                   COUNT(ps.id) AS n,
                   COALESCE(SUM(ps.converted), 0) AS conv
            FROM lp_variants v
            LEFT JOIN page_sessions ps ON ps.variant_id = v.id AND ps.{NOT_BOT}
            WHERE v.status = 'live'
            GROUP BY v.id
            ORDER BY n DESC
        """)
        return total, per_variant
    finally:
        con.close()


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    os.replace(tmp, STATE_PATH)


def build_message(total, per_variant):
    lead = per_variant[0] if per_variant else None
    lines = [
        "*:white_check_mark: Resort LP — review gate reached*",
        f"We've collected *{total}* landing-page sessions"
        + (f" — top live variant `{lead[1]}` has *{lead[2]}*." if lead else "."),
        "",
        "Phase A telemetry is producing clean funnel data. Time to review and "
        "design challengers (different hero / CTA copy / WhatsApp prefill at ~15% weight).",
        "",
        "Per-variant WhatsApp-click funnel (sessions → conversions):",
    ]
    for page_slug, slug, n, conv in per_variant:
        rate = f"{(100.0 * conv / n):.0f}%" if n else "—"
        lines.append(f"  • `{slug}` ({page_slug}) — {n} sessions, {conv} wa-clicks ({rate})")
    lines += [
        "",
        ":information_source: *converted* = clicked the WhatsApp button. "
        "When the visitor keeps the LPDS reference in the prefilled message, "
        "the Twilio bridge now links the resulting CRM lead back to this session.",
        "",
        "Reply here to pick the next variant test.",
    ]
    return "\n".join(lines)


def post_to_slack(message):
    if not CHANNEL or not SLACK_ACCOUNT:
        sys.stderr.write("lp_phase_gate: Slack integration is not configured\n")
        return False
    args = [
        OPENCLAW, "message", "send",
        "--channel", "slack",
        "--account", SLACK_ACCOUNT,
        "--target", f"channel:{CHANNEL}",
        "--message", message,
        "--json",
    ]
    try:
        subprocess.run(args, check=True, timeout=30, capture_output=True)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        sys.stderr.write(f"lp_phase_gate: Slack post failed: {e}\n")
        return False


def main():
    ap = argparse.ArgumentParser(description="Announce the LP review gate when the session gate is reached.")
    ap.add_argument("--dry-run", action="store_true", help="Print status; never post or write state.")
    ap.add_argument("--force", action="store_true", help="Re-post even if already fired.")
    args = ap.parse_args()

    total, per_variant = gather(DB_PATH)
    top = per_variant[0][2] if per_variant else 0
    gate_met = total >= MIN_TOTAL and top >= MIN_PER_VARIANT
    state = load_state()
    already = bool(state.get("fired_at"))

    print(f"[lp_phase_gate] total={total} top_variant={top} "
          f"gate(total>={MIN_TOTAL},variant>={MIN_PER_VARIANT})={'MET' if gate_met else 'not met'} "
          f"already_fired={already}")

    if args.dry_run:
        if gate_met:
            print("--- would post ---")
            print(build_message(total, per_variant))
        return

    if not gate_met:
        record(JOB_NAME, True, f"below-threshold:{total}/{top}")
        return  # stay quiet below threshold — the log line above is enough

    if already and not args.force:
        record(JOB_NAME, True, "already-fired")
        return  # one-time announcement

    if post_to_slack(build_message(total, per_variant)):
        state.update({
            "fired_at": la_now().isoformat(),
            "total_sessions_at_fire": total,
            "top_variant_sessions_at_fire": top,
        })
        save_state(state)
        record(JOB_NAME, True, "gate-posted")
    else:
        record(JOB_NAME, False, "slack-post-failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
