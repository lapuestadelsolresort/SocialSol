#!/usr/bin/env python3
"""Cut Paulina over from the legacy booking ask to the planner partner program.

Dry-run is the default. ``--apply`` performs one transaction that:
  * creates/activates ``planner_partner_program_v1``;
  * pauses ``planner_outreach_v1``;
  * cancels exactly the expected approved legacy drafts; and
  * attaches eligible planner contacts to the new campaign.

The existing draft text is retained for auditability. Cancellation is a state
change, not a delete. The script never sends email.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


NEW_SLUG = "planner_partner_program_v1"
OLD_SLUG = "planner_outreach_v1"
NEW_URL = (
    "https://planners.lapuestadelsolresort.com/"
    "?utm_source=paulina&utm_medium=email&utm_campaign=planner_partner_program_v1"
)


def scalar(con: sqlite3.Connection, query: str, params: tuple = ()):
    row = con.execute(query, params).fetchone()
    return row[0] if row else None


def snapshot(con: sqlite3.Connection) -> dict:
    old_id = scalar(con, "SELECT id FROM outreach_campaigns WHERE slug=?", (OLD_SLUG,))
    new_id = scalar(con, "SELECT id FROM outreach_campaigns WHERE slug=?", (NEW_SLUG,))
    approved = 0
    old_contacts = 0
    if old_id:
        approved = scalar(
            con,
            "SELECT COUNT(*) FROM outreach_sends WHERE campaign_id=? AND status='approved'",
            (old_id,),
        ) or 0
        old_contacts = scalar(
            con,
            "SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id=?",
            (old_id,),
        ) or 0
    new_contacts = 0
    if new_id:
        new_contacts = scalar(
            con,
            "SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id=?",
            (new_id,),
        ) or 0
    return {
        "old_campaign_id": old_id,
        "new_campaign_id": new_id,
        "approved_legacy_drafts": approved,
        "old_campaign_contacts": old_contacts,
        "new_campaign_contacts": new_contacts,
    }


def apply_cutover(con: sqlite3.Connection, expected_approved: int) -> dict:
    before = snapshot(con)
    old_id = before["old_campaign_id"]
    if not old_id:
        raise RuntimeError(f"legacy campaign {OLD_SLUG!r} was not found")

    already_applied = bool(before["new_campaign_id"] and before["approved_legacy_drafts"] == 0)
    if not already_applied and before["approved_legacy_drafts"] != expected_approved:
        raise RuntimeError(
            "approved legacy draft count changed: "
            f"expected {expected_approved}, found {before['approved_legacy_drafts']}"
        )

    con.execute("BEGIN IMMEDIATE")
    try:
        con.execute(
            """
            INSERT INTO outreach_campaigns
              (name, slug, persona, landing_page_url, status, persona_brief_path,
               description, created_by, campaign_kind, owning_agent)
            VALUES (?, ?, 'wedding_planner', ?, 'active', ?, ?, ?, 'cold_outreach', 'paulina')
            ON CONFLICT(name) DO UPDATE SET
              slug=excluded.slug,
              persona=excluded.persona,
              landing_page_url=excluded.landing_page_url,
              status='active',
              persona_brief_path=excluded.persona_brief_path,
              description=excluded.description,
              owning_agent='paulina'
            """,
            (
                "Planner Partner Program v1",
                NEW_SLUG,
                NEW_URL,
                "prospector/library/personas/wedding-planner.md",
                "Planner-only outreach: partner page -> Meta retargeting -> Sarah -> documented referral.",
                "strategy_cutover_2026-07-31",
            ),
        )
        new_id = scalar(con, "SELECT id FROM outreach_campaigns WHERE slug=?", (NEW_SLUG,))
        if not new_id:
            raise RuntimeError("new campaign insert did not produce a campaign id")

        con.execute(
            """
            INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, attached_by)
            SELECT ?, c.id, 'partner_program_cutover_2026-07-31'
            FROM contacts c
            WHERE c.email IS NOT NULL AND trim(c.email) <> ''
              AND COALESCE(c.do_not_contact, 0) = 0
              AND COALESCE(c.status, 'new') NOT IN ('replied', 'converted', 'dead')
              AND (
                EXISTS (
                  SELECT 1 FROM campaign_contacts cc
                  WHERE cc.campaign_id=? AND cc.contact_id=c.id
                )
                OR c.source_query LIKE '%_wedding_planner'
                OR c.source_query LIKE '%_houston_wedding_planner'
              )
              AND NOT EXISTS (
                SELECT 1 FROM suppressions s WHERE lower(s.email)=lower(c.email)
              )
              AND NOT EXISTS (
                SELECT 1 FROM outreach_sends os
                WHERE os.contact_id=c.id
                  AND (os.reply_detected_at IS NOT NULL OR os.status='replied')
              )
            """,
            (new_id, old_id),
        )
        attached = scalar(con, "SELECT changes()") or 0

        con.execute(
            """
            UPDATE outreach_sends
            SET status='cancelled',
                cancelled_at=datetime('now'),
                error='superseded_by_planner_partner_program_v1',
                skip_reason='strategy_rewrite_partner_program'
            WHERE campaign_id=? AND status='approved'
            """,
            (old_id,),
        )
        cancelled = scalar(con, "SELECT changes()") or 0
        if not already_applied and cancelled != expected_approved:
            raise RuntimeError(
                f"cancellation count changed inside transaction: expected {expected_approved}, got {cancelled}"
            )

        con.execute("UPDATE outreach_campaigns SET status='paused' WHERE id=?", (old_id,))
        con.execute("UPDATE outreach_campaigns SET status='active', landing_page_url=? WHERE id=?", (NEW_URL, new_id))
        con.commit()
    except Exception:
        con.rollback()
        raise

    after = snapshot(con)
    return {
        "already_applied": already_applied,
        "cancelled_legacy_drafts": cancelled,
        "new_contacts_attached_this_run": attached,
        "before": before,
        "after": after,
    }


def resume_if_strategy_hold(root: Path) -> dict:
    state_path = root / "prospector" / "state.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        state = {"paused": False}

    if state.get("paused") and state.get("paused_by") != "p0_stale_partner_rewrite_hold":
        return {"resumed": False, "reason": "different_pause_owner", "paused_by": state.get("paused_by")}

    previous_pause = {
        "paused_by": state.pop("paused_by", None),
        "paused_at": state.pop("paused_at", None),
        "pause_reason": state.pop("pause_reason", None),
    }
    state.update(
        {
            "paused": False,
            "resumed_by": "planner_partner_program_cutover",
            "resumed_at": datetime.now(timezone.utc).isoformat(),
            "resume_reason": "legacy drafts cancelled and planner partner-program strategy activated",
        }
    )
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return {"resumed": True, "previous_pause": previous_pause}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-approved", type=int, default=25)
    args = parser.parse_args()

    root = Path(os.environ.get("SOCIALSOL_ROOT", Path(__file__).resolve().parents[2]))
    db_path = Path(os.environ.get("DB_PATH", root / "crm" / "data" / "crm.db"))
    uri = f"file:{db_path}?mode={'rw' if args.apply else 'ro'}"
    con = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        if not args.apply:
            print(json.dumps({"mode": "dry-run", "db": str(db_path), "snapshot": snapshot(con)}, indent=2))
            return
        result = apply_cutover(con, args.expected_approved)
    finally:
        con.close()

    result["state"] = resume_if_strategy_hold(root)
    print(json.dumps({"mode": "applied", **result}, indent=2))


if __name__ == "__main__":
    main()
