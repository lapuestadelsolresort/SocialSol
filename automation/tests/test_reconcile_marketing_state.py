import json
import sqlite3
import unittest
from pathlib import Path

from reconcile_marketing_state import (
    RETREATS_ALLOCATION_PASS_ID,
    RETREATS_RECONCILED_ALLOCATION,
    RETREATS_RECONCILIATION,
    ROOT,
    reconcile,
)


SCHEMA = """
CREATE TABLE experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  kind TEXT,
  bucket TEXT,
  funnel_stage TEXT,
  blast_radius TEXT DEFAULT 'low',
  hypothesis TEXT,
  rationale TEXT,
  change_made TEXT,
  primary_metric TEXT NOT NULL,
  guardrail_metrics TEXT,
  baseline_value TEXT,
  target_value TEXT,
  observation_window TEXT,
  review_at TEXT,
  linked_variant_slug TEXT,
  linked_campaign_id TEXT,
  linked_utm_campaign TEXT,
  result TEXT,
  conclusion TEXT,
  source TEXT DEFAULT 'operator',
  created_by TEXT DEFAULT 'sol',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  concluded_at TEXT
);
CREATE TABLE optimizer_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
"""


class MarketingStateReconciliationTests(unittest.TestCase):
    def database(self):
        con = sqlite3.connect(":memory:")
        con.executescript(SCHEMA)
        return con

    def test_retreats_allocation_is_reconciled_honestly_and_idempotently(self):
        con = self.database()
        reconcile(con, [], 80)
        reconcile(con, [], 80)

        row = con.execute(
            """SELECT rationale, change_made, observation_window
               FROM experiments WHERE slug='exp-retreats-challenger-a'"""
        ).fetchone()
        self.assertEqual(row, (
            RETREATS_RECONCILIATION["rationale"],
            RETREATS_RECONCILIATION["change_made"],
            RETREATS_RECONCILIATION["observation_window"],
        ))
        decisions = con.execute(
            """SELECT target_id, before, after FROM decisions
               WHERE pass_id=? AND action='reconcile_weight' ORDER BY target_id""",
            (RETREATS_ALLOCATION_PASS_ID,),
        ).fetchall()
        self.assertEqual(len(decisions), 2)
        self.assertEqual(
            {target: json.loads(after) for target, _before, after in decisions},
            RETREATS_RECONCILED_ALLOCATION,
        )
        self.assertTrue(
            all(
                json.loads(before) == 50
                for _target, before, _after in decisions
            )
        )

    def test_committed_variant_mirrors_match_reconciled_allocation(self):
        for slug, expected in RETREATS_RECONCILED_ALLOCATION.items():
            payload = json.loads(
                (Path(ROOT) / "lp" / "variants" / f"{slug}.json").read_text()
            )
            self.assertEqual(payload["traffic_weight"], expected)


if __name__ == "__main__":
    unittest.main()
