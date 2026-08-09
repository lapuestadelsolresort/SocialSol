#!/usr/bin/env python3
"""Read-only health summary for durable Meta CAPI deliveries."""

from __future__ import annotations

import sqlite3


def meta_capi_delivery_health(db_path, pending_grace_minutes=15):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        tables = {
            row[0]
            for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "conversion_deliveries" not in tables:
            return {
                "ok": False,
                "failed": 0,
                "stale_pending": 0,
                "detail": "conversion_deliveries table is missing",
            }
        row = con.execute(
            """SELECT
                   SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                   SUM(CASE WHEN status='pending'
                                  AND updated_at < datetime('now', ?)
                            THEN 1 ELSE 0 END) AS stale_pending,
                   MIN(CASE WHEN status IN ('failed','pending') THEN updated_at END) AS oldest_problem
               FROM conversion_deliveries
               WHERE provider='meta-capi'""",
            (f"-{int(pending_grace_minutes)} minutes",),
        ).fetchone()
        failed = int(row["failed"] or 0)
        stale_pending = int(row["stale_pending"] or 0)
        return {
            "ok": failed == 0 and stale_pending == 0,
            "failed": failed,
            "stale_pending": stale_pending,
            "oldest_problem": row["oldest_problem"],
        }
    finally:
        con.close()


def meta_capi_failure_message(health):
    parts = []
    if health.get("failed"):
        parts.append(f"{health['failed']} failed")
    if health.get("stale_pending"):
        parts.append(f"{health['stale_pending']} stale pending")
    if not parts and health.get("detail"):
        parts.append(str(health["detail"]))
    return "Meta CAPI delivery unhealthy: " + ", ".join(parts or ["unknown state"])
