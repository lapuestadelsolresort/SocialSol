#!/usr/bin/env python3
"""Sync CRM contacts and leads to Meta Custom Audiences for paid retargeting.

Creates/updates two Custom Audiences from CRM data:
  1. "LPDS — CRM Past Guests & Inquiries" — emails from `leads` table
     (people who actually inquired or booked via email/WhatsApp/direct)
  2. "LPDS — CRM B2B Planners & Partners"  — emails from `contacts` table
     (outbound prospects: wedding planners, event companies, venues)

Emails are SHA-256 hashed client-side per Meta's requirements. Audiences are
created once, then updated incrementally (new emails added, removed emails
purged). A Lookalike can be built from either seed audience once it reaches
sufficient size (Meta recommends 1,000+, but smaller lists still work).

The production schedule runs this behind ``meta.audience.sync`` so provider
effects, readback, and Slack notification are durable. Direct execution remains
available for an explicit dry run or emergency operator recovery.

Usage:
    python3 crm_audience_sync.py [--dry-run] [--verbose]
"""

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from job_health import record

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
SECRETS_DIR = os.environ.get("SOCIALSOL_SECRETS_DIR", os.path.join(ROOT, "secrets"))
SECRETS = os.path.join(SECRETS_DIR, "meta.json")
LEGACY_STATE_PATH = os.path.join(ROOT, "memory", "crm-audience-state.json")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
G = "https://graph.facebook.com/v21.0"
JOB_NAME = "resort-crm-audience-sync"

# Audience definitions
AUDIENCES = {
    "guests": {
        "name": "LPDS — CRM Past Guests & Inquiries",
        "description": "Emails from leads + OwnerRez guest contacts (Airbnb, VRBO, direct)",
        "query": """
            WITH candidates(email) AS (
              SELECT email FROM leads
              WHERE email IS NOT NULL AND email != '' AND TRIM(email) != ''
              UNION
              SELECT email FROM contacts
              WHERE email IS NOT NULL AND email != '' AND TRIM(email) != ''
                AND ownerrez_guest_id IS NOT NULL
                AND COALESCE(do_not_contact, 0) = 0
            )
            SELECT DISTINCT LOWER(TRIM(c.email))
            FROM candidates c
            WHERE NOT EXISTS (
              SELECT 1 FROM suppressions s WHERE LOWER(TRIM(s.email))=LOWER(TRIM(c.email))
            )
        """,
    },
    "planners": {
        "name": "LPDS — CRM B2B Planners & Partners",
        "description": "Emails from CRM contacts table — outbound prospects (planners, venues)",
        "query": """
            SELECT DISTINCT LOWER(TRIM(email))
            FROM contacts c
            WHERE c.email IS NOT NULL AND c.email != ''
              AND TRIM(c.email) != ''
              AND COALESCE(c.status, 'new') != 'dead'
              AND COALESCE(c.do_not_contact, 0) = 0
              AND c.ownerrez_guest_id IS NULL
              AND c.airbnb_account_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM suppressions s
                WHERE LOWER(TRIM(s.email))=LOWER(TRIM(c.email))
              )
              AND (
                c.relationship_type IN ('prospect_planner', 'prospect_b2b')
                OR c.source_query LIKE '%_wedding_planner'
                OR c.source_query LIKE '%_houston_wedding_planner'
                OR EXISTS (
                  SELECT 1
                  FROM campaign_contacts cc
                  JOIN outreach_campaigns oc ON oc.id=cc.campaign_id
                  WHERE cc.contact_id=c.id
                    AND oc.persona IN ('wedding_planner', 'event_planner')
                )
              )
        """,
    },
}


def la_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-7)))


def sha256_email(email: str) -> str:
    """Hash an email per Meta's normalization rules: lowercase, stripped, SHA-256."""
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def api_get(endpoint, token, **params):
    qs = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    url = f"{G}/{endpoint}?{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Meta API GET {endpoint}: {exc}") from exc
    if payload.get("error"):
        raise RuntimeError(f"Meta API error: {payload['error'].get('message', 'unknown')}")
    return payload


def api_post(endpoint, token, data: dict):
    body = urllib.parse.urlencode(data, quote_via=urllib.parse.quote).encode("utf-8")
    url = f"{G}/{endpoint}"
    req = urllib.request.Request(
        url, data=body, method="POST", headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Meta API POST {endpoint} ({exc.code}): {err_body}") from exc
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Meta API POST {endpoint}: {exc}") from exc
    if payload.get("error"):
        raise RuntimeError(f"Meta API error: {payload['error'].get('message', 'unknown')}")
    return payload


def ensure_state_table(con):
    con.execute("""CREATE TABLE IF NOT EXISTS marketing_audience_state (
        audience_key TEXT PRIMARY KEY,
        audience_id TEXT NOT NULL,
        audience_name TEXT NOT NULL,
        email_count INTEGER NOT NULL DEFAULT 0,
        hashed_emails_json TEXT NOT NULL DEFAULT '[]',
        provider_readback_json TEXT,
        last_workflow_run_id TEXT,
        last_synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )""")


def load_state() -> dict:
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.row_factory = sqlite3.Row
    try:
        ensure_state_table(con)
        rows = con.execute("SELECT * FROM marketing_audience_state").fetchall()
        state = {
            row["audience_key"]: {
                "audience_id": row["audience_id"],
                "audience_name": row["audience_name"],
                "email_count": row["email_count"],
                "hashed_emails": json.loads(row["hashed_emails_json"] or "[]"),
                "last_synced_at": row["last_synced_at"],
            }
            for row in rows
        }
    finally:
        con.close()
    if state:
        return state
    try:
        with open(LEGACY_STATE_PATH, "r", encoding="utf-8") as fh:
            legacy = json.load(fh)
    except (OSError, json.JSONDecodeError):
        legacy = {}
    migrated = {
        key: value for key, value in legacy.items()
        if key in AUDIENCES and isinstance(value, dict) and value.get("audience_id")
    }
    if migrated:
        save_state(migrated)
    return migrated


def save_state(state: dict, provider_readbacks=None):
    con = sqlite3.connect(DB_PATH, timeout=20)
    try:
        con.execute("PRAGMA busy_timeout=20000")
        ensure_state_table(con)
        workflow_run_id = os.environ.get("WORKFLOW_RUN_ID")
        for key, value in state.items():
            if not value.get("audience_id"):
                continue
            con.execute("""INSERT INTO marketing_audience_state (
                audience_key, audience_id, audience_name, email_count, hashed_emails_json,
                provider_readback_json, last_workflow_run_id, last_synced_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(audience_key) DO UPDATE SET
                audience_id=excluded.audience_id,
                audience_name=excluded.audience_name,
                email_count=excluded.email_count,
                hashed_emails_json=excluded.hashed_emails_json,
                provider_readback_json=COALESCE(excluded.provider_readback_json, marketing_audience_state.provider_readback_json),
                last_workflow_run_id=COALESCE(excluded.last_workflow_run_id, marketing_audience_state.last_workflow_run_id),
                last_synced_at=excluded.last_synced_at,
                updated_at=datetime('now')""", (
                key,
                value["audience_id"],
                value.get("audience_name") or AUDIENCES[key]["name"],
                int(value.get("email_count") or 0),
                json.dumps(value.get("hashed_emails") or [], separators=(",", ":")),
                json.dumps((provider_readbacks or {}).get(key), separators=(",", ":"))
                if (provider_readbacks or {}).get(key) else None,
                workflow_run_id,
                value.get("last_synced_at") or datetime.now(timezone.utc).isoformat(),
            ))
        con.commit()
    finally:
        con.close()


def get_crm_emails(query: str) -> set:
    """Pull distinct emails from the CRM."""
    if not os.path.exists(DB_PATH):
        raise RuntimeError(f"CRM database not found at {DB_PATH}")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        cur.execute(query)
        return {row[0] for row in cur.fetchall() if row[0] and "@" in row[0]}
    finally:
        con.close()


def find_existing_audience(act: str, token: str, name: str) -> str | None:
    """Check if a Custom Audience with this name already exists."""
    data = api_get(f"{act}/customaudiences", token, fields="id,name", limit="100")
    for aud in data.get("data", []):
        if aud.get("name") == name:
            return aud["id"]
    return None


def create_audience(act: str, token: str, name: str, description: str) -> str:
    """Create a new CUSTOMER_FILE Custom Audience. Returns the audience ID."""
    result = api_post(f"{act}/customaudiences", token, {
        "name": name,
        "subtype": "CUSTOM",
        "description": description,
        "customer_file_source": "USER_PROVIDED_ONLY",
    })
    return result["id"]


def upload_audience_users(audience_id: str, token: str, hashed_emails: list[str]):
    """Upload hashed emails to the audience via POST /{audience_id}/users.

    Meta's /users endpoint expects data as a list of single-element lists
    (each row = one user). Schema is a list of column names.
    For small lists (<10k) this is a single call with no session needed.
    """
    if not hashed_emails:
        return {"num_received": 0}
    # Meta format: schema=["EMAIL"], data=[[hash1],[hash2],...]
    # When pre-hashed, use is_raw=true so Meta doesn't double-hash
    payload = {
        "schema": ["EMAIL"],
        "is_raw": True,
        "data": [[h] for h in hashed_emails],
    }
    return api_post(f"{audience_id}/users", token, {
        "payload": json.dumps(payload),
    })


def remove_audience_users(audience_id: str, token: str, hashed_emails: list[str]):
    """Remove hashed emails from the audience."""
    if not hashed_emails:
        return {"num_received": 0}
    payload = {
        "schema": ["EMAIL"],
        "is_raw": True,
        "data": [[h] for h in hashed_emails],
    }
    # DELETE method with payload
    data = {"payload": json.dumps(payload)}
    body = urllib.parse.urlencode(data, quote_via=urllib.parse.quote).encode("utf-8")
    url = f"{G}/{audience_id}/users"
    req = urllib.request.Request(
        url, data=body, method="DELETE", headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Meta API DELETE {audience_id}/users ({exc.code}): {err_body}") from exc


def post_slack(msg: str, dry_run: bool = False):
    if dry_run:
        print(msg)
        return
    if not CHANNEL or not SLACK_ACCOUNT:
        print(msg)
        return
    cmd = [
        OPENCLAW, "message", "send",
        "--channel", "slack",
        "--account", SLACK_ACCOUNT,
        "--target", f"channel:{CHANNEL}",
        "--message", msg,
        "--json",
    ]
    try:
        subprocess.run(cmd, check=True, timeout=30, capture_output=True, text=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(f"Slack post failed: {exc}", file=sys.stderr)


def sync_audience(key: str, config: dict, act: str, token: str,
                  state: dict, dry_run: bool, verbose: bool) -> dict:
    """Sync one audience. Returns a summary dict."""
    name = config["name"]
    description = config["description"]

    # 1. Pull emails from CRM
    emails = get_crm_emails(config["query"])
    if verbose:
        print(f"  {key}: {len(emails)} emails from CRM")

    if not emails:
        return {"key": key, "name": name, "emails": 0, "action": "skipped", "reason": "no emails"}

    # 2. Hash emails
    hashed = sorted(sha256_email(e) for e in emails)

    # 3. Find or create audience
    prev = state.get(key, {})
    audience_id = prev.get("audience_id")

    # Verify the audience still exists
    if audience_id:
        try:
            api_get(audience_id, token, fields="id,name")
        except RuntimeError:
            audience_id = None  # Audience was deleted, recreate

    if not audience_id:
        audience_id = find_existing_audience(act, token, name)
        if audience_id and not prev:
            raise RuntimeError(
                f"found existing audience {audience_id} without a membership ledger; "
                "refusing an additive-only sync that could retain suppressed contacts"
            )

    action = "updated"
    if not audience_id:
        if dry_run:
            return {"key": key, "name": name, "emails": len(emails),
                    "action": "would_create", "hashes": len(hashed)}
        audience_id = create_audience(act, token, name, description)
        action = "created"
        if verbose:
            print(f"  Created audience {audience_id}: {name}")

    # 4. Check if anything changed
    prev_hashes = set(prev.get("hashed_emails", []))
    curr_hashes = set(hashed)

    if prev_hashes == curr_hashes and action != "created":
        if verbose:
            print(f"  {key}: no changes, skipping upload")
        return {"key": key, "name": name, "audience_id": audience_id,
                "emails": len(emails), "action": "unchanged"}

    added = curr_hashes - prev_hashes
    removed = prev_hashes - curr_hashes

    if dry_run:
        return {"key": key, "name": name, "audience_id": audience_id,
                "emails": len(emails), "action": f"would_update (+{len(added)}/-{len(removed)})"}

    # 5. Incremental sync: add new, remove gone
    receipts = {}
    if removed:
        receipts["remove"] = remove_audience_users(audience_id, token, sorted(removed))
    if added or action == "created":
        receipts["add"] = upload_audience_users(
            audience_id, token, hashed if action == "created" else sorted(added)
        )
    if verbose:
        print(f"  {key}: synced {len(hashed)} users (+{len(added)}/-{len(removed)})")

    # 6. Update state
    state[key] = {
        "audience_id": audience_id,
        "audience_name": name,
        "email_count": len(emails),
        "hashed_emails": hashed,
        "last_synced_at": datetime.now(timezone.utc).isoformat(),
    }

    return {"key": key, "name": name, "audience_id": audience_id,
            "emails": len(emails), "action": action,
            "added": len(added), "removed": len(removed),
            "provider_receipts": receipts}


def verify_state(token):
    state = load_state()
    if not state:
        raise RuntimeError("audience state is empty")
    readbacks = {}
    for key, value in state.items():
        audience_id = value.get("audience_id")
        if not audience_id:
            raise RuntimeError(f"audience state is missing an id for {key}")
        provider = api_get(audience_id, token, fields="id,name")
        if str(provider.get("id") or "") != str(audience_id):
            raise RuntimeError(f"Meta readback did not return audience {audience_id}")
        if provider.get("name") != AUDIENCES[key]["name"]:
            raise RuntimeError(f"Meta audience name drift for {key}")
        readbacks[key] = provider
    save_state(state, provider_readbacks=readbacks)
    return {
        "verified": True,
        "audiences": [
            {
                "key": key,
                "audience_id": value["audience_id"],
                "audience_name": value["audience_name"],
                "email_count": value["email_count"],
                "provider": readbacks[key],
            }
            for key, value in sorted(state.items())
        ],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--workflow-managed", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    with open(SECRETS) as f:
        creds = json.load(f)
    token = creds["access_token"]
    act = creds["ad_account_act"]

    if args.verify:
        result = verify_state(token)
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
        return

    state = load_state()
    results = []

    for key, config in AUDIENCES.items():
        try:
            result = sync_audience(key, config, act, token, state, args.dry_run, args.verbose)
            results.append(result)
        except Exception as exc:
            results.append({"key": key, "name": config["name"], "action": "error", "error": str(exc)})
            print(f"Error syncing {key}: {exc}", file=sys.stderr)

    if not args.dry_run:
        save_state(state)

    # Build Slack summary (only post if something changed)
    changes = [r for r in results if r["action"] not in ("unchanged", "skipped")]
    if changes or args.dry_run:
        today = la_now().strftime("%Y-%m-%d")
        lines = [f"*CRM → Meta Audience sync — {today}*"]
        for r in results:
            action = r["action"]
            emoji = {"created": "🆕", "updated": "🔄", "unchanged": "✅",
                     "skipped": "⏭️", "error": "❌"}.get(action, "📋")
            line = f"  {emoji} *{r['name']}*: {r.get('emails', 0)} emails"
            if action == "created":
                line += f" — audience created (id: {r.get('audience_id', '?')})"
            elif action == "updated":
                line += f" — +{r.get('added', 0)} added, -{r.get('removed', 0)} removed"
            elif action == "error":
                line += f" — error: {r.get('error', 'unknown')}"
            elif action.startswith("would_"):
                line += f" — {action} (dry run)"
            lines.append(line)

        lines.append("")
        lines.append("_These audiences are available for retargeting campaigns and Lookalike generation._")
        if not args.workflow_managed:
            post_slack("\n".join(lines), args.dry_run)

    if not args.dry_run and not args.workflow_managed:
        ok = all(r["action"] != "error" for r in results)
        detail = "; ".join(f"{r['key']}={r['action']}" for r in results)
        record(JOB_NAME, ok, detail)

    if args.workflow_managed and any(row["action"] == "error" for row in results):
        raise RuntimeError("one or more audience mutations failed; inspect provider state before retry")
    if args.verbose or args.dry_run or args.json or args.workflow_managed:
        payload = {
            "ok": all(row["action"] != "error" for row in results),
            "results": results,
            "changed": len(changes),
        }
        print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        if "--workflow-managed" not in sys.argv:
            record(JOB_NAME, False, str(exc)[:300])
        print(f"crm_audience_sync: {exc}", file=sys.stderr)
        sys.exit(1)
