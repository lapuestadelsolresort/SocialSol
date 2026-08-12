import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import crm_audience_sync as audience


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b'{"data":[]}'


class CrmAudienceSyncTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db_path = Path(self.directory.name) / "crm.db"
        self.previous_db = audience.DB_PATH
        self.previous_legacy_state = audience.LEGACY_STATE_PATH
        audience.DB_PATH = str(self.db_path)
        audience.LEGACY_STATE_PATH = str(Path(self.directory.name) / "legacy-audience-state.json")
        con = sqlite3.connect(self.db_path)
        con.executescript("""
          CREATE TABLE contacts (
            id INTEGER PRIMARY KEY, email TEXT, status TEXT, do_not_contact INTEGER,
            ownerrez_guest_id INTEGER, airbnb_account_id INTEGER,
            relationship_type TEXT, source_query TEXT
          );
          CREATE TABLE leads (id INTEGER PRIMARY KEY, email TEXT);
          CREATE TABLE suppressions (email TEXT);
          CREATE TABLE outreach_campaigns (id INTEGER PRIMARY KEY, persona TEXT);
          CREATE TABLE campaign_contacts (campaign_id INTEGER, contact_id INTEGER);
        """)
        con.executemany(
            """INSERT INTO contacts
              (id,email,status,do_not_contact,ownerrez_guest_id,airbnb_account_id,relationship_type,source_query)
              VALUES (?,?,?,?,?,?,?,?)""",
            [
                (1, "planner@example.test", "new", 0, None, None, "prospect_planner", None),
                (2, "guest@example.test", "booked", 0, 20, None, "past_guest", None),
                (3, "dnc@example.test", "new", 1, None, None, "prospect_planner", None),
                (4, "random@example.test", "new", 0, None, None, None, None),
                (5, "suppressed@example.test", "new", 0, None, None, "prospect_b2b", None),
                (6, "campaign@example.test", "new", 0, None, None, None, None),
            ],
        )
        con.execute("INSERT INTO suppressions(email) VALUES ('suppressed@example.test')")
        con.execute("INSERT INTO outreach_campaigns(id,persona) VALUES (7,'wedding_planner')")
        con.execute("INSERT INTO campaign_contacts(campaign_id,contact_id) VALUES (7,6)")
        con.commit()
        con.close()

    def tearDown(self):
        audience.DB_PATH = self.previous_db
        audience.LEGACY_STATE_PATH = self.previous_legacy_state
        self.directory.cleanup()

    def test_planner_segment_is_structurally_scoped_and_suppressed(self):
        emails = audience.get_crm_emails(audience.AUDIENCES["planners"]["query"])
        self.assertEqual(emails, {"planner@example.test", "campaign@example.test"})

    def test_provider_tokens_use_authorization_headers_not_urls(self):
        captured = []

        def open_url(request, timeout):
            captured.append(request)
            return Response()

        with mock.patch("urllib.request.urlopen", side_effect=open_url):
            audience.api_get("act_1/customaudiences", "secret-token", fields="id,name")
            audience.api_post("audience-1/users", "secret-token", {"payload": "{}"})
        self.assertNotIn("access_token", captured[0].full_url)
        self.assertNotIn(b"access_token", captured[1].data)
        self.assertEqual(captured[0].get_header("Authorization"), "Bearer secret-token")
        self.assertEqual(captured[1].get_header("Authorization"), "Bearer secret-token")

    def test_audience_state_lives_in_the_backed_up_crm_database(self):
        state = {
            "planners": {
                "audience_id": "aud-1", "audience_name": "Planner audience",
                "email_count": 1, "hashed_emails": ["abc"],
                "last_synced_at": "2026-08-12T00:00:00+00:00",
            }
        }
        with mock.patch.dict(os.environ, {"WORKFLOW_RUN_ID": "run-1"}):
            audience.save_state(state, {"planners": {"id": "aud-1"}})
        loaded = audience.load_state()
        self.assertEqual(loaded["planners"]["audience_id"], "aud-1")
        con = sqlite3.connect(self.db_path)
        row = con.execute(
            "SELECT last_workflow_run_id, provider_readback_json FROM marketing_audience_state"
        ).fetchone()
        con.close()
        self.assertEqual(row[0], "run-1")
        self.assertEqual(json.loads(row[1]), {"id": "aud-1"})

    def test_legacy_membership_ledger_is_migrated_before_reconciliation(self):
        Path(audience.LEGACY_STATE_PATH).write_text(json.dumps({
            "planners": {
                "audience_id": "aud-old", "audience_name": "Planner audience",
                "email_count": 1, "hashed_emails": ["old-hash"],
                "last_synced_at": "2026-08-01T00:00:00+00:00",
            }
        }))
        loaded = audience.load_state()
        self.assertEqual(loaded["planners"]["hashed_emails"], ["old-hash"])
        con = sqlite3.connect(self.db_path)
        count = con.execute("SELECT COUNT(*) FROM marketing_audience_state").fetchone()[0]
        con.close()
        self.assertEqual(count, 1)

    def test_provider_readback_does_not_clear_originating_workflow_id(self):
        state = {
            "planners": {
                "audience_id": "aud-1", "audience_name": "Planner audience",
                "email_count": 1, "hashed_emails": ["abc"],
                "last_synced_at": "2026-08-12T00:00:00+00:00",
            }
        }
        with mock.patch.dict(os.environ, {"WORKFLOW_RUN_ID": "run-1"}):
            audience.save_state(state)
        with mock.patch.dict(os.environ, {}, clear=True):
            audience.save_state(state, {"planners": {"id": "aud-1"}})
        con = sqlite3.connect(self.db_path)
        workflow_id = con.execute(
            "SELECT last_workflow_run_id FROM marketing_audience_state"
        ).fetchone()[0]
        con.close()
        self.assertEqual(workflow_id, "run-1")


if __name__ == "__main__":
    unittest.main()
