#!/usr/bin/env python3
"""Synthetic end-to-end tracker liveness test for La Puesta del Sol Resort.

Sends a synthetic beacon to /api/track for each active ad destination,
confirms the session lands in the CRM database, cleans up, and runs
cold-start detection (destinations active >24h but with zero real sessions).

Usage:
    python3 scripts/tracker-liveness-test.py            # run + post to Slack
    python3 scripts/tracker-liveness-test.py --dry-run  # print only, no DB writes
    python3 scripts/tracker-liveness-test.py --no-post  # write state, skip Slack
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "automation"))
from campaign_registry import fetch_live_snapshot, graph_api, load_meta_secrets, load_registry  # noqa: E402
from job_health import record  # noqa: E402
from runtime_paths import runtime_state_path  # noqa: E402

DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
STATE_PATH = runtime_state_path("tracker-liveness.json")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("TRACKING_QC_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "ig-drafts")
TRACK_ENDPOINT = os.environ.get("TRACK_ENDPOINT", "https://webhook.lapuestadelsolresort.com/api/track")
JOB_NAME = "resort-tracker-liveness"

# Test SID prefix: matches SID_RE /^[0-9a-z-]{8,64}$/i (no underscores allowed).
# "testlv-" is 7 chars; the full sid (testlv- + uuid4 = 43 chars) comfortably fits.
# Cleanup targets: id LIKE 'testlv-%'
TEST_SID_PREFIX = "testlv-"

# Cold-start: flag destinations active >24h with zero real sessions in last 48h
COLD_START_HOURS = 24
COLD_START_WINDOW_HOURS = 48

# How long to wait between beacon POST and DB read (seconds)
VERIFY_WAIT_SECS = 2.5


# ─── Utilities ────────────────────────────────────────────────────────────────

def la_now():
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/Los_Angeles"))


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(value, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def make_test_sid():
    """Generate a test session ID that passes track.js SID_RE: /^[0-9a-z-]{8,64}$/i"""
    return f"{TEST_SID_PREFIX}{uuid.uuid4()}"


# ─── Beacon ───────────────────────────────────────────────────────────────────

def send_beacon(sid, destination, dry_run=False):
    """
    POST a synthetic pageview event to /api/track exactly as px.js would.

    The CRM's requireBrowserSource middleware checks:
      1. Loopback IP (localhost) — bypasses origin check, OR
      2. Origin header matching /^https://([a-z0-9-]+\\.)?lapuestadelsolresort\\.com$/i

    Since the webhook endpoint goes through Cloudflare, we're not loopback.
    We set Origin to the destination's own origin so it passes the CORS check.
    The User-Agent must NOT match BOT_UA_PATTERNS (no 'HeadlessChrome', etc.).
    """
    url = destination.get("url", "")
    host = destination.get("host", "dining.lapuestadelsolresort.com")
    origin = f"https://{host}"
    page_slug = destination.get("page_slug") or ""

    event = {
        "sid": sid,
        "kind": "pageview",
        "target": url,
        "ts": int(time.time() * 1000),
        "meta": {
            "page": page_slug,
            "utm_source": destination.get("utm_source") or "meta",
            "utm_medium": destination.get("utm_medium") or "paid",
            "utm_campaign": destination.get("utm_campaign") or "",
            "utm_content": destination.get("utm_content") or "",
            "ref": url,
            "dev": "desktop",
            "vw": 1440,
            "vh": 900,
            "lang": "en-US",
        },
    }

    body = json.dumps([event]).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        # Origin header must match ALLOWED_BROWSER_ORIGIN regex on the server
        "Origin": origin,
        # Referer as fallback: server falls back to URL(referer).origin if no Origin
        "Referer": url,
        # Non-bot UA — must not contain 'HeadlessChrome', 'crawler', 'spider', etc.
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }

    if dry_run:
        print(
            f"  [dry-run] Would POST beacon to {TRACK_ENDPOINT}\n"
            f"            sid={sid} origin={origin} utm_campaign={event['meta']['utm_campaign']}"
        )
        return True, 200

    req = urllib.request.Request(TRACK_ENDPOINT, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp_body = resp.read().decode("utf-8", "replace")
            status = resp.status
            ok = status == 200 and '"ok":true' in resp_body
            return ok, status
    except Exception as exc:
        return False, str(exc)


# ─── DB verification ──────────────────────────────────────────────────────────

def verify_session_in_db(sid, wait_secs=VERIFY_WAIT_SECS):
    """Wait briefly, then confirm the session landed in page_sessions."""
    time.sleep(wait_secs)
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=10)
        row = conn.execute(
            "SELECT id, page_slug, utm_campaign, utm_source, created_at FROM page_sessions WHERE id = ?",
            (sid,),
        ).fetchone()
        conn.close()
        if row:
            return True, {"id": row[0], "page_slug": row[1], "utm_campaign": row[2],
                          "utm_source": row[3], "created_at": row[4]}
        return False, None
    except Exception as exc:
        return False, f"db-error: {exc}"


def cleanup_test_sessions():
    """Remove all testlv- sessions and events (cleanup after liveness test)."""
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=10)
        conn.execute(
            "DELETE FROM page_events WHERE session_id LIKE ?",
            (f"{TEST_SID_PREFIX}%",),
        )
        result = conn.execute(
            "DELETE FROM page_sessions WHERE id LIKE ?",
            (f"{TEST_SID_PREFIX}%",),
        )
        deleted = result.rowcount
        conn.commit()
        conn.close()
        return deleted
    except Exception as exc:
        return f"cleanup-error: {exc}"


# ─── Cold-start detection ─────────────────────────────────────────────────────

def get_ad_created_time(secrets, ad_id):
    """Fetch a specific Meta ad's created_time. Returns datetime or None."""
    try:
        ad = graph_api(secrets, ad_id, fields="id,created_time")
        created_str = ad.get("created_time")
        if created_str:
            # Meta returns ISO 8601 with offset, e.g. "2026-07-26T09:00:00+0000"
            # Normalise to +00:00 format for fromisoformat()
            normalised = created_str.replace("+0000", "+00:00").replace("Z", "+00:00")
            return datetime.fromisoformat(normalised)
    except Exception:
        pass
    return None


def cold_start_check(destinations, secrets, now_utc):
    """
    For each unique destination, query page_sessions for non-bot, non-test
    sessions in the last COLD_START_WINDOW_HOURS hours.

    If a destination has been active >COLD_START_HOURS and has ZERO real sessions,
    that's a tracker liveness failure — the script tag is present but silent.

    Returns: list of failure dicts with 'message' key.
    """
    failures = []
    cutoff = (now_utc - timedelta(hours=COLD_START_WINDOW_HOURS)).strftime("%Y-%m-%d %H:%M:%S")

    # Deduplicate by (host, utm_campaign) to avoid re-checking the same LP
    seen = set()
    for dest in destinations:
        key = (dest.get("host", ""), dest.get("utm_campaign", ""))
        if key in seen:
            continue
        seen.add(key)

        utm_campaign = dest.get("utm_campaign")
        utm_source = dest.get("utm_source")
        ad_id = dest.get("ad_id")
        dest_url = dest.get("url", key[0])

        # Determine how long this destination has been active via Meta ad created_time
        created_time = None
        if ad_id and secrets:
            created_time = get_ad_created_time(secrets, ad_id)

        if not created_time:
            # No created_time → skip (conservative: don't false-positive on unknown age)
            continue

        age_hours = (now_utc - created_time).total_seconds() / 3600
        if age_hours < COLD_START_HOURS:
            # Too new to require sessions yet
            continue

        # Build a query for non-bot, non-test sessions in the window matching this destination's UTMs
        where_clauses = [
            "id NOT LIKE ?",          # exclude test sessions
            "created_at >= ?",        # within the window
            "(is_bot IS NULL OR is_bot = 0)",  # exclude bots
        ]
        params = [f"{TEST_SID_PREFIX}%", cutoff]

        if utm_campaign:
            where_clauses.append("utm_campaign = ?")
            params.append(utm_campaign)
        if utm_source:
            where_clauses.append("utm_source = ?")
            params.append(utm_source)

        query = "SELECT COUNT(*) FROM page_sessions WHERE " + " AND ".join(where_clauses)

        try:
            conn = sqlite3.connect(str(DB_PATH), timeout=10)
            (count,) = conn.execute(query, params).fetchone()
            conn.close()
        except Exception as exc:
            failures.append({
                "type": "cold_start_db_error",
                "url": dest_url,
                "message": f"Could not query CRM for cold-start check on {dest_url}: {exc}",
            })
            continue

        if count == 0:
            age_days = age_hours / 24
            failures.append({
                "type": "cold_start",
                "url": dest_url,
                "utm_campaign": utm_campaign,
                "active_hours": round(age_hours, 1),
                "active_days": round(age_days, 1),
                "message": (
                    f"Tracker liveness failure: {dest_url} has been active for "
                    f"{age_days:.1f} day(s) but has zero CRM sessions in the last "
                    f"{COLD_START_WINDOW_HOURS}h"
                ),
            })

    return failures


# ─── Slack ────────────────────────────────────────────────────────────────────

def post_slack(message, dry_run):
    if dry_run:
        print(message)
        return
    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration not configured (TRACKING_QC_CHANNEL / OPENCLAW_SLACK_ACCOUNT)")
    subprocess.run(
        [OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
         "--target", f"channel:{CHANNEL}", "--message", message, "--json"],
        check=True,
        timeout=30,
        capture_output=True,
    )


# ─── Main run ─────────────────────────────────────────────────────────────────

def run(dry_run=False, no_post=False):
    records = load_registry()
    secrets = load_meta_secrets()
    snapshot = fetch_live_snapshot(records, secrets)
    live = {row["campaign_id"]: row for row in snapshot if row["effective_status"] == "ACTIVE"}

    if not live:
        raise RuntimeError("Meta returned no active configured campaigns")

    if not DB_PATH.exists():
        raise RuntimeError(f"CRM database unavailable at {DB_PATH}")

    # Collect all unique active destinations across campaigns
    all_destinations = []
    seen_urls: set = set()
    for row in live.values():
        for dest in row.get("destinations", []):
            url = dest.get("url")
            if url and url not in seen_urls:
                seen_urls.add(url)
                all_destinations.append(dest)

    now_utc = datetime.now(timezone.utc)
    beacon_results = []
    all_failures = []

    # ── Phase 1: Synthetic beacon → DB round-trip ─────────────────────────────
    for dest in all_destinations:
        sid = make_test_sid()
        dest_url = dest.get("url", "unknown")

        beacon_ok, beacon_status = send_beacon(sid, dest, dry_run=dry_run)

        if not beacon_ok:
            beacon_results.append({
                "url": dest_url, "sid": sid,
                "beacon_ok": False, "verified": False,
                "beacon_status": str(beacon_status),
            })
            all_failures.append(f"Beacon POST failed for {dest_url}: {beacon_status}")
            continue

        if dry_run:
            # Dry-run: skip DB verification — just record as assumed-pass
            beacon_results.append({
                "url": dest_url, "sid": sid,
                "beacon_ok": True, "verified": True,
                "note": "dry-run: DB verification skipped",
            })
            continue

        # ── Phase 2: Verify session landed in page_sessions ───────────────────
        verified, db_row = verify_session_in_db(sid)
        beacon_results.append({
            "url": dest_url, "sid": sid,
            "beacon_ok": True, "verified": verified,
            "db_row": db_row if isinstance(db_row, dict) else None,
            "db_error": db_row if isinstance(db_row, str) else None,
        })
        if not verified:
            all_failures.append(
                f"Beacon fired (HTTP 200) but session NOT in CRM for {dest_url} — "
                f"tracker pipeline is broken (sid={sid[:20]}...)"
            )

    # ── Phase 3: Cold-start detection ─────────────────────────────────────────
    cold_failures = []
    if not dry_run:
        cold_failures = cold_start_check(all_destinations, secrets, now_utc)
        for cf in cold_failures:
            all_failures.append(cf["message"])
    else:
        print("  [dry-run] Cold-start detection skipped (requires live DB + Meta API)")

    # ── Phase 4: Cleanup test sessions ────────────────────────────────────────
    deleted_count: int | str = 0
    if not dry_run:
        deleted_count = cleanup_test_sessions()

    # ── Build report ──────────────────────────────────────────────────────────
    healthy = not all_failures
    icon = "✅" if healthy else "🔴"
    ts_str = now_utc.strftime("%Y-%m-%d %H:%M UTC")

    passed_beacons = sum(1 for r in beacon_results if r.get("verified"))
    total_beacons = len(beacon_results)

    lines = [
        f"{icon} *Tracker Liveness — {ts_str}*",
        f"{total_beacons} active destination(s) tested with synthetic beacons.",
    ]

    if total_beacons:
        lines.append(f"Beacon→DB round-trip: {passed_beacons}/{total_beacons} passed.")

    if cold_failures:
        lines.append(f"Cold-start failures: {len(cold_failures)}")

    for failure in all_failures:
        lines.append(f"• {failure}")

    if healthy:
        lines.append(
            "All synthetic beacons confirmed in CRM. Tracker pipeline is live end-to-end."
        )

    if not dry_run:
        lines.append(f"_(Test sessions cleaned up: {deleted_count} row(s) removed)_")

    state = {
        "timestamp": now_utc.isoformat(),
        "healthy": healthy,
        "failure_count": len(all_failures),
        "failures": all_failures,
        "destinations_tested": len(all_destinations),
        "beacon_results": beacon_results,
        "cold_start_failures": cold_failures,
        "test_sessions_cleaned": deleted_count if not dry_run else None,
    }

    if not dry_run:
        atomic_json(STATE_PATH, state)

    message = "\n".join(lines)
    print(message)
    if not no_post:
        post_slack(message, dry_run)

    return state


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Synthetic end-to-end tracker liveness test for La Puesta del Sol Resort."
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would happen without sending beacons, touching the DB, or posting to Slack.",
    )
    parser.add_argument(
        "--no-post", action="store_true",
        help="Run the full test and write state, but skip the Slack post.",
    )
    args = parser.parse_args()

    state = run(args.dry_run, args.no_post)

    if not args.dry_run:
        record(
            JOB_NAME,
            state["healthy"],
            f"{state['failure_count']} failure(s), {state['destinations_tested']} destination(s) tested",
        )

    raise SystemExit(0 if state["healthy"] else 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"tracker-liveness: {exc}", file=sys.stderr)
        raise SystemExit(2)
