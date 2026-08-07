#!/usr/bin/env python3
"""Fail-closed daily tracking integrity check using live Meta destinations."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "automation"))
from campaign_measurement import crm_metrics, meta_metrics  # noqa: E402
from campaign_registry import fetch_live_snapshot, group_registry, load_meta_secrets, load_registry  # noqa: E402
from job_health import record  # noqa: E402

DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "crm/data/crm.db"))
STATE_PATH = ROOT / "state/tracking-health.json"
VERIFICATION_PATH = ROOT / "state/tracking-verification.json"
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("TRACKING_QC_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "ig-drafts")
TRACK_ENDPOINT = os.environ.get("TRACK_ENDPOINT", "https://webhook.lapuestadelsolresort.com/api/track")
JOB_NAME = "resort-tracking-health"
SESSION_RATIO_MIN = 0.30


def la_now():
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


def http_check(url, origin=None, method="GET", body=None):
    headers = {"User-Agent": "LPDS-Tracking-Health/2.0"}
    if origin:
        headers["Origin"] = origin
    if method == "OPTIONS":
        headers.update({
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        normalized = {key.lower(): value for key, value in response.headers.items()}
        return response.status, normalized, response.read().decode("utf-8", "replace")


def infrastructure_checks(destinations):
    failures, details = [], []
    status, headers, body = http_check(TRACK_ENDPOINT, "https://planners.lapuestadelsolresort.com", "OPTIONS")
    cors_ok = (
        status in (200, 204)
        and headers.get("access-control-allow-credentials", "").lower() == "true"
        and headers.get("access-control-allow-origin") == "https://planners.lapuestadelsolresort.com"
    )
    details.append({"name": "cors_preflight", "ok": cors_ok, "status": status})
    if not cors_ok:
        failures.append("credentialed /api/track CORS preflight is invalid")

    status, headers, body = http_check(
        TRACK_ENDPOINT,
        "https://planners.lapuestadelsolresort.com",
        "POST",
        b"[]",
    )
    post_ok = status == 200 and headers.get("access-control-allow-credentials", "").lower() == "true"
    details.append({"name": "cors_credentialed_post", "ok": post_ok, "status": status})
    if not post_ok:
        failures.append("credentialed /api/track POST is invalid")

    checked_urls = set()
    for destination in destinations:
        url = destination.get("url")
        if not url or url in checked_urls:
            continue
        checked_urls.add(url)
        try:
            status, _, html = http_check(url)
            expected = "/lp/sq-tracker.js" if destination.get("tracker") == "sq-tracker" else "/lp/px.js"
            ok = status == 200 and expected in html
            details.append({"name": "destination_tracker", "url": url, "expected": expected, "ok": ok})
            if not ok:
                failures.append(f"destination does not load {expected}: {url}")
        except Exception as exc:
            details.append({"name": "destination_tracker", "url": url, "ok": False, "error": str(exc)})
            failures.append(f"destination could not be verified: {url}")
    return failures, details


def update_verification(campaigns, per_campaign, now):
    state = read_json(VERIFICATION_PATH, {}) or {}
    output = {"updated_at": now, "campaigns": state.get("campaigns", {})}
    for campaign in campaigns:
        cid = campaign["campaign_id"]
        previous = output["campaigns"].get(cid, {})
        healthy = bool(per_campaign[cid]["healthy"])
        output["campaigns"][cid] = {
            "campaign_name": campaign["campaign_name"],
            "utm_tags": campaign.get("utm_tags") or [],
            "healthy": healthy,
            "verified_since": previous.get("verified_since") if healthy and previous.get("healthy") else (now if healthy else None),
            "last_verified_at": now if healthy else previous.get("last_verified_at"),
            "last_failure_at": now if not healthy else previous.get("last_failure_at"),
        }
    atomic_json(VERIFICATION_PATH, output)


def post_slack(message, dry_run):
    if dry_run:
        print(message)
        return
    if not CHANNEL or not SLACK_ACCOUNT:
        raise RuntimeError("Slack integration is not configured")
    subprocess.run([
        OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
        "--target", f"channel:{CHANNEL}", "--message", message, "--json",
    ], check=True, timeout=30, capture_output=True)


def run(day, dry_run=False, no_post=False):
    records = load_registry()
    secrets = load_meta_secrets()
    snapshot = fetch_live_snapshot(records, secrets)
    live = {row["campaign_id"]: row for row in snapshot if row["effective_status"] == "ACTIVE"}
    campaigns = [row for row in group_registry(records) if row["campaign_id"] in live]
    if not campaigns:
        raise RuntimeError("Meta returned no active configured campaigns")
    destinations = []
    for campaign in campaigns:
        row = live[campaign["campaign_id"]]
        campaign["utm_tags"] = row["utm_tags"]
        campaign["destinations"] = row["destinations"]
        destinations.extend(row["destinations"])
        if not row["utm_tags"]:
            raise RuntimeError(f"active campaign has no measurable UTM: {campaign['campaign_name']}")
    if not DB_PATH.exists():
        raise RuntimeError("CRM database unavailable")

    meta, crm = meta_metrics(secrets, campaigns, day), crm_metrics(DB_PATH, campaigns, day)
    infra_failures, infra = infrastructure_checks(destinations)
    failures = list(infra_failures)
    per_campaign = {}
    for campaign in campaigns:
        cid = campaign["campaign_id"]
        mm, cm = meta[cid], crm[cid]
        clicks = mm["link_clicks"]
        ratio = cm["sessions"] / clicks if clicks else None
        problems = []
        if clicks >= 10 and ratio < SESSION_RATIO_MIN:
            problems.append(f"{cm['sessions']} sessions / {clicks} link clicks ({ratio:.0%})")
        if cm["sessions"] >= 10 and cm["sessions_with_behavior"] == 0:
            problems.append(f"{cm['sessions']} sessions but zero behavioral events")
        if cm["sessions"] >= 10 and cm["cta_reached"] == 0 and any(
            d.get("tracker") == "px" for d in campaign["destinations"]
        ):
            problems.append(f"{cm['sessions']} custom-LP sessions but zero CTA views")
        per_campaign[cid] = {
            "campaign_name": campaign["campaign_name"],
            "utm_tags": campaign["utm_tags"],
            "meta_link_clicks": clicks,
            **cm,
            "session_click_ratio": round(ratio, 4) if ratio is not None else None,
            "healthy": not problems and not infra_failures,
            "failures": problems,
        }
        failures.extend(f"{campaign['campaign_name']}: {problem}" for problem in problems)

    now = datetime.now(timezone.utc).isoformat()
    state = {
        "timestamp": now,
        "measurement_date": day,
        "healthy": not failures,
        "failure_count": len(failures),
        "failures": failures,
        "campaigns": per_campaign,
        "infrastructure": infra,
        "source_of_truth": "live Meta campaign state and active ad destinations",
    }
    if not dry_run:
        atomic_json(STATE_PATH, state)
        update_verification(campaigns, per_campaign, now)
    status = "✅" if state["healthy"] else "🔴"
    lines = [f"{status} *Tracking Integrity — {day}*", f"{len(campaigns)} active campaigns checked against live Meta destinations."]
    lines.extend(f"• {failure}" for failure in failures)
    if not failures:
        lines.append("Credentialed CORS, destination scripts, UTM session ratios, and event flow passed.")
    if not no_post:
        post_slack("\n".join(lines), dry_run)
    elif dry_run:
        print("\n".join(lines))
    return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-post", action="store_true", help="update local state without Slack")
    args = parser.parse_args()
    day = args.date or (la_now().date() - timedelta(days=1)).isoformat()
    state = run(day, args.dry_run, args.no_post)
    if not args.dry_run:
        record(JOB_NAME, state["healthy"], f"{day}: {state['failure_count']} failure(s)")
    raise SystemExit(0 if state["healthy"] else 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        record(JOB_NAME, False, str(exc)[:300])
        print(f"tracking health: {exc}", file=sys.stderr)
        raise SystemExit(2)
