"""Regression tests for the weekly Kapital accounting integrity control.

Everything here runs against disposable SQLite databases, a stubbed QBO client
and a stubbed `openclaw` runner. No provider is contacted and no credential is
read or written.
"""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "automation"))

import slack_scan
import tests as control

NOW = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
CHANNEL_GENERAL = "C0GENERAL"
CHANNEL_MAYELA = "C0MAYELA"


def ts_for(days_ago):
    return f"{(NOW - timedelta(days=days_ago)).timestamp():.6f}"


def base_config(**overrides):
    config = {
        "receipt_channels": {
            CHANNEL_GENERAL: {"name": "receipts-general", "scope": "general"},
            CHANNEL_MAYELA: {"name": "receipts-mayela", "scope": "mayela"},
        },
        "qbo_accounts": {
            "expenses": {
                "group_activities": {"id": "40", "name": "Group Activities"},
                "supplies_group": {"id": "41", "name": "Supplies (Group)"},
                "uncategorized_expense": {"id": "42", "name": "Uncategorized Expense"},
                "contract_labor": {"id": "43", "name": "Contract Labor"},
                "bank_fee": {"id": "44", "name": "Bank Fee"},
            }
        },
        "salary_patterns": {
            "daniel_monthly": {
                "payee": "DANIEL BUSINESS",
                "keyword": "MONTHLY SALARY",
                "expected_amount": 25000,
            },
            "sergio_weekly": {
                "payee": "SERGIO GRACIA",
                "keyword": "WEEKLY PAYMENT",
                "expected_amount_new": 5000,
            },
            "susy_cleaning": {
                "payee": "SUSY",
                "keyword": "CLEANING",
                "expected_amount_per_day": 500,
            },
        },
    }
    config.update(overrides)
    return config


class StubQBO:
    """Returns canned pages and remembers every SQL statement it was given."""

    def __init__(self, rows=None, entity="Purchase"):
        self.rows = list(rows or [])
        self.entity = entity
        self.queries = []

    def query(self, sql):
        self.queries.append(sql)
        start = int(sql.split("STARTPOSITION")[1].split()[0])
        size = int(sql.split("MAXRESULTS")[1].split()[0])
        page = self.rows[start - 1: start - 1 + size]
        return {"QueryResponse": {self.entity: page} if page else {}}


def stub_runner(pages_by_channel, *, fail=False, via_file=False):
    """Stands in for subprocess.run over the openclaw CLI.

    With via_file, it behaves like the real CLI does under the production call
    shape — writing to the caller's stdout file and leaving CompletedProcess
    .stdout empty — which is what keeps large pages from being truncated.
    """
    calls = []
    kwarg_log = []

    def run(args, **kwargs):
        calls.append(args)
        kwarg_log.append(kwargs)
        if fail:
            return subprocess.CompletedProcess(args, 1, "", "boom")
        channel = next(a for a in args if a.startswith("channel:")).split(":", 1)[1]
        before = args[args.index("--before") + 1] if "--before" in args else None
        pages = pages_by_channel.get(channel, [[]])
        index = 0
        if before is not None:
            for position, page in enumerate(pages):
                if page and page[-1]["ts"] == before:
                    index = position + 1
                    break
        page = pages[index] if index < len(pages) else []
        body = json.dumps({
            "payload": {"ok": True, "messages": page, "hasMore": index + 1 < len(pages)}
        })
        if via_file and hasattr(kwargs.get("stdout"), "write"):
            kwargs["stdout"].write(body)
            kwargs["stdout"].flush()
            return subprocess.CompletedProcess(args, 0, None, "")
        return subprocess.CompletedProcess(args, 0, body, "")

    run.calls = calls
    run.kwargs = kwarg_log
    return run


def make_ledger(directory, rows):
    path = Path(directory) / "crm.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE accounting_receipts ("
        "slack_channel_id TEXT, slack_message_id TEXT, status TEXT, "
        "qbo_entity_id TEXT, amount REAL, currency TEXT, submitted_at TEXT)"
    )
    connection.executemany(
        "INSERT INTO accounting_receipts VALUES (?,?,?,?,?,?,?)", rows
    )
    connection.commit()
    connection.close()
    return str(path)


def receipt_message(days_ago, *, bot=False, files=True, reactions=None):
    message = {"ts": ts_for(days_ago), "text": "receipt"}
    if bot:
        message["bot_id"] = "B1"
    if files:
        message["files"] = [{"id": "F1"}]
    if reactions:
        message["reactions"] = [{"name": name, "count": 1} for name in reactions]
    return message


def make_context(config=None, *, qbo=None, runner=None, db_path=None, months_back=3):
    return control.Context(
        qbo or StubQBO(),
        config or base_config(),
        slack_account="A1",
        db_path=db_path,
        months_back=months_back,
        now=NOW,
        runner=runner or stub_runner({}),
    )


# ---------------------------------------------------------------------------
# Pagination — F-014(e)
# ---------------------------------------------------------------------------

class PaginationTests(unittest.TestCase):
    def test_query_all_pages_past_the_first_page(self):
        rows = [{"Id": str(i)} for i in range(1, 1201)]
        client = StubQBO(rows)
        result = control.query_all(client, "SELECT Id FROM Purchase")
        self.assertEqual(len(result), 1200)
        self.assertEqual(len(client.queries), 3)
        self.assertIn("STARTPOSITION 1 ", client.queries[0] + " ")
        self.assertIn("STARTPOSITION 501", client.queries[1])
        self.assertIn("STARTPOSITION 1001", client.queries[2])

    def test_every_query_carries_explicit_paging(self):
        client = StubQBO([{"Id": "1"}])
        control.query_all(client, "SELECT Id FROM Purchase", "WHERE TxnDate >= '2026-01-01'")
        self.assertIn("MAXRESULTS", client.queries[0])
        self.assertIn("STARTPOSITION", client.queries[0])
        self.assertLess(
            client.queries[0].index("ORDERBY"), client.queries[0].index("STARTPOSITION")
        )

    def test_runaway_query_raises_rather_than_looping(self):
        client = StubQBO([{"Id": str(i)} for i in range(30000)])
        with self.assertRaises(control.CheckError):
            control.query_all(client, "SELECT Id FROM Purchase")

    def test_window_query_is_bounded_by_the_configured_months(self):
        client = StubQBO([])
        context = make_context(qbo=client, months_back=1)
        control.purchases_in_window(context)
        self.assertIn("TxnDate >= '2026-07-01'", client.queries[0])
        self.assertIn("TxnDate <= '2026-08-17'", client.queries[0])

    def test_purchases_are_fetched_whole_so_line_detail_survives(self):
        """Naming fields makes QBO return Line stubs with no account reference,
        which turns every account-based check into a silent no-op."""
        client = StubQBO([])
        control.purchases_in_window(make_context(qbo=client))
        self.assertIn("SELECT * FROM Purchase", client.queries[0])

    def test_line_based_checks_all_use_the_full_projection(self):
        for check in (control.check_orphaned_group_activities,
                      control.check_orphaned_food_expenses,
                      control.check_uncategorized_expenses):
            client = StubQBO([])
            check(make_context(qbo=client))
            self.assertTrue(
                all("SELECT * FROM Purchase" in q for q in client.queries),
                f"{check.__name__} did not request full rows",
            )


# ---------------------------------------------------------------------------
# Slack scanning
# ---------------------------------------------------------------------------

class SlackScanTests(unittest.TestCase):
    def test_scan_pages_until_it_passes_the_window(self):
        pages = [
            [receipt_message(1), receipt_message(2)],
            [receipt_message(3), receipt_message(400)],
        ]
        runner = stub_runner({CHANNEL_GENERAL: pages})
        since = (NOW - timedelta(days=90)).timestamp()
        messages = slack_scan.read_channel_since(
            CHANNEL_GENERAL, since, account="A1", runner=runner
        )
        self.assertEqual(len(messages), 3)
        self.assertIn("--before", runner.calls[1])

    def test_scan_refuses_to_report_a_truncated_window_as_complete(self):
        pages = [[receipt_message(i)] for i in range(1, 6)]
        runner = stub_runner({CHANNEL_GENERAL: pages})
        with self.assertRaises(slack_scan.SlackScanError):
            slack_scan.read_channel_since(
                CHANNEL_GENERAL, (NOW - timedelta(days=90)).timestamp(),
                account="A1", runner=runner, max_pages=2,
            )

    def test_failed_read_raises(self):
        runner = stub_runner({}, fail=True)
        with self.assertRaises(slack_scan.SlackScanError):
            slack_scan.read_channel_since(
                CHANNEL_GENERAL, 0, account="A1", runner=runner
            )

    def test_output_is_captured_via_file_not_a_pipe(self):
        """The CLI exits without draining a pipe, truncating pages over ~64KB."""
        runner = stub_runner({CHANNEL_GENERAL: [[receipt_message(1)]]}, via_file=True)
        messages = slack_scan.read_channel_since(
            CHANNEL_GENERAL, (NOW - timedelta(days=90)).timestamp(),
            account="A1", runner=runner,
        )
        self.assertEqual(len(messages), 1)
        self.assertNotIn("capture_output", runner.kwargs[0])
        self.assertTrue(hasattr(runner.kwargs[0]["stdout"], "write"))

    def test_a_page_far_larger_than_the_pipe_buffer_survives(self):
        big = [
            {"ts": ts_for(1 + i / 100), "text": "x" * 4000, "files": [{"id": "F"}]}
            for i in range(200)
        ]
        runner = stub_runner({CHANNEL_GENERAL: [big]}, via_file=True)
        messages = slack_scan.read_channel_since(
            CHANNEL_GENERAL, (NOW - timedelta(days=90)).timestamp(),
            account="A1", runner=runner,
        )
        self.assertEqual(len(messages), 200)

    def test_truncated_json_is_an_error_never_a_short_result(self):
        def truncating(args, **kwargs):
            if hasattr(kwargs.get("stdout"), "write"):
                kwargs["stdout"].write('{"payload": {"ok": true, "messages": [{"ts"')
                kwargs["stdout"].flush()
            return subprocess.CompletedProcess(args, 0, None, "")

        with self.assertRaises(slack_scan.SlackScanError):
            slack_scan.read_channel_since(
                CHANNEL_GENERAL, 0, account="A1", runner=truncating
            )

    def test_only_human_attachments_count_as_receipts(self):
        messages = [
            receipt_message(1),
            receipt_message(1, bot=True),
            receipt_message(1, files=False),
        ]
        self.assertEqual(len(slack_scan.receipt_candidates(messages)), 1)

    def test_reactions_are_read_inline(self):
        self.assertTrue(
            slack_scan.has_reaction(receipt_message(1, reactions=["white_check_mark"]))
        )
        self.assertFalse(slack_scan.has_reaction(receipt_message(1, reactions=["eyes"])))


# ---------------------------------------------------------------------------
# Check 1 — receipt coverage reaches a terminal verdict (F-014a)
# ---------------------------------------------------------------------------

class ReceiptCoverageTests(unittest.TestCase):
    def scan(self, messages, ledger_rows, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            db_path = make_ledger(directory, ledger_rows)
            context = make_context(
                runner=stub_runner({CHANNEL_GENERAL: [messages], CHANNEL_MAYELA: [[]]}),
                db_path=db_path,
                **kwargs,
            )
            return control.check_receipt_channel_coverage(context)

    def test_verdict_is_never_needs_slack_scan(self):
        result = self.scan(
            [receipt_message(30)],
            [(CHANNEL_GENERAL, ts_for(30), "posted", "2529", 100.0, "MXN", "2026-07-01T00:00:00Z")],
        )
        self.assertIn(result["status"], {"pass", "WARN", "FAIL"})
        self.assertNotIn("instructions", result)

    def test_receipt_never_ingested_fails(self):
        result = self.scan([receipt_message(30)], [
            (CHANNEL_GENERAL, ts_for(60), "posted", "1", 1.0, "MXN", "2026-06-01T00:00:00Z"),
        ])
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["not_ingested_count"], 1)

    def test_receipt_inside_the_grace_window_is_pending_not_failed(self):
        result = self.scan([receipt_message(2)], [
            (CHANNEL_GENERAL, ts_for(60), "posted", "1", 1.0, "MXN", "2026-06-01T00:00:00Z"),
        ])
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["receipts_pending_within_grace"], 1)
        self.assertEqual(result["not_ingested_count"], 0)

    def test_receipt_posted_before_the_pipeline_existed_is_out_of_scope(self):
        result = self.scan([receipt_message(60)], [
            (CHANNEL_GENERAL, ts_for(10), "posted", "1", 1.0, "MXN", "2026-08-06T00:00:00Z"),
        ])
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["receipts_before_pipeline_start"], 1)
        self.assertEqual(result["not_ingested_count"], 0)

    def test_ingested_but_stalled_in_the_pipeline_fails(self):
        result = self.scan([receipt_message(30)], [
            (CHANNEL_GENERAL, ts_for(30), "received", None, 1.0, "MXN", "2026-07-01T00:00:00Z"),
        ])
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["not_booked_count"], 1)

    def test_waiting_on_a_human_warns_rather_than_failing(self):
        result = self.scan([receipt_message(30)], [
            (CHANNEL_GENERAL, ts_for(30), "needs_review", None, 1.0, "MXN", "2026-07-01T00:00:00Z"),
        ])
        self.assertEqual(result["status"], "WARN")
        self.assertEqual(result["awaiting_human_count"], 1)
        self.assertEqual(result["not_booked_count"], 0)

    def test_ignored_receipts_are_closed_not_failures(self):
        result = self.scan([receipt_message(30)], [
            (CHANNEL_GENERAL, ts_for(30), "ignored", None, 1.0, "MXN", "2026-07-01T00:00:00Z"),
        ])
        self.assertEqual(result["status"], "pass")

    def test_a_receipt_posted_earlier_on_the_pipelines_first_day_is_out_of_scope(self):
        """The pipeline went live mid-morning; comparing whole days alone made
        every receipt posted earlier that same day read as a miss."""
        first_ledger_row = (NOW - timedelta(days=11)).replace(hour=19, minute=42)
        result = self.scan(
            [receipt_message(11.1)],  # ~17:30 the same day, before the first row
            [(CHANNEL_GENERAL, ts_for(1), "posted", "1", 1.0, "MXN",
              first_ledger_row.isoformat().replace("+00:00", "Z"))],
        )
        self.assertEqual(result["receipts_before_pipeline_start"], 1)
        self.assertEqual(result["not_ingested_count"], 0)
        self.assertEqual(result["status"], "pass")

    def test_a_receipt_after_the_pipeline_went_live_still_fails(self):
        first_ledger_row = (NOW - timedelta(days=11)).replace(hour=19, minute=42)
        result = self.scan(
            [receipt_message(9)],
            [(CHANNEL_GENERAL, ts_for(1), "posted", "1", 1.0, "MXN",
              first_ledger_row.isoformat().replace("+00:00", "Z"))],
        )
        self.assertEqual(result["not_ingested_count"], 1)
        self.assertEqual(result["status"], "FAIL")

    def test_configured_start_date_overrides_the_ledger(self):
        config = base_config(receipt_coverage={"grace_days": 7, "start_date": "2026-08-01"})
        result = self.scan(
            [receipt_message(30)],
            [(CHANNEL_GENERAL, ts_for(10), "posted", "1", 1.0, "MXN", "2026-07-01T00:00:00Z")],
            config=config,
        )
        self.assertEqual(result["receipts_before_pipeline_start"], 1)
        self.assertEqual(result["status"], "pass")

    def test_grace_days_are_configurable(self):
        config = base_config(receipt_coverage={"grace_days": 45})
        result = self.scan(
            [receipt_message(30)],
            [(CHANNEL_GENERAL, ts_for(60), "posted", "1", 1.0, "MXN", "2026-06-01T00:00:00Z")],
            config=config,
        )
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["receipts_pending_within_grace"], 1)


# ---------------------------------------------------------------------------
# Check 6 — checkmark reconciliation reaches a terminal verdict (F-014a)
# ---------------------------------------------------------------------------

class CheckmarkTests(unittest.TestCase):
    def scan(self, messages, ledger_rows):
        with tempfile.TemporaryDirectory() as directory:
            db_path = make_ledger(directory, ledger_rows)
            context = make_context(
                runner=stub_runner({CHANNEL_MAYELA: [messages], CHANNEL_GENERAL: [[]]}),
                db_path=db_path,
            )
            return control.check_mayela_checkmark(context)

    def test_confirmed_but_unbooked_fails(self):
        result = self.scan(
            [receipt_message(30, reactions=["white_check_mark"])],
            [(CHANNEL_MAYELA, ts_for(30), "needs_review", None, 1.0, "MXN", "2026-07-01T00:00:00Z")],
        )
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["unbooked_count"], 1)

    def test_confirmed_and_booked_passes(self):
        result = self.scan(
            [receipt_message(30, reactions=["white_check_mark"])],
            [(CHANNEL_MAYELA, ts_for(30), "posted", "2529", 1.0, "MXN", "2026-07-01T00:00:00Z")],
        )
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["confirmed_payments"], 1)

    def test_a_human_queue_does_not_excuse_a_confirmed_payment(self):
        """Unlike coverage, a checkmark asserts the money already moved."""
        result = self.scan(
            [receipt_message(30, reactions=["white_check_mark"])],
            [(CHANNEL_MAYELA, ts_for(30), "awaiting_payment_source", None, 1.0, "MXN", "2026-07-01T00:00:00Z")],
        )
        self.assertEqual(result["status"], "FAIL")

    def test_messages_without_a_checkmark_are_ignored(self):
        result = self.scan(
            [receipt_message(30), receipt_message(30, reactions=["eyes"])],
            [],
        )
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["confirmed_payments"], 0)

    def test_only_mayela_scoped_channels_are_scanned(self):
        runner = stub_runner({
            CHANNEL_MAYELA: [[receipt_message(30, reactions=["white_check_mark"])]],
            CHANNEL_GENERAL: [[receipt_message(30, reactions=["white_check_mark"])]],
        })
        with tempfile.TemporaryDirectory() as directory:
            db_path = make_ledger(directory, [])
            context = make_context(runner=runner, db_path=db_path)
            result = control.check_mayela_checkmark(context)
        self.assertEqual(result["channels_scanned"], 1)
        self.assertEqual(result["confirmed_payments"], 1)


# ---------------------------------------------------------------------------
# Check 5 — salary matrix comes from config (F-014f)
# ---------------------------------------------------------------------------

class SalaryMatrixTests(unittest.TestCase):
    def test_matrix_is_built_from_config_patterns(self):
        matrix = control.salary_matrix(base_config())
        self.assertEqual(sorted(matrix), ["daniel_monthly", "sergio_weekly", "susy_cleaning"])
        self.assertEqual(matrix["daniel_monthly"]["cadence"], "monthly")
        self.assertEqual(matrix["sergio_weekly"]["cadence"], "weekly")
        self.assertEqual(matrix["susy_cleaning"]["cadence"], "daily")

    def test_a_new_config_payee_is_picked_up_without_a_code_change(self):
        config = base_config(salary_patterns={
            "nadia_monthly": {"payee": "NADIA LOPEZ", "keyword": "SALARY", "expected_amount": 12000},
        })
        matrix = control.salary_matrix(config)
        self.assertIn("nadia_monthly", matrix)
        self.assertEqual(matrix["nadia_monthly"]["payees"], ["NADIA LOPEZ"])

    def test_missing_salary_patterns_is_an_error_not_a_silent_pass(self):
        with self.assertRaises(control.CheckError):
            control.salary_matrix(base_config(salary_patterns={}))

    def test_double_monthly_salary_is_flagged(self):
        rows = [
            {"Id": "1", "TxnDate": "2026-07-05", "TotalAmt": 1400.0,
             "EntityRef": {"name": "Daniel Business"}, "PrivateNote": "Monthly salary June"},
            {"Id": "2", "TxnDate": "2026-07-28", "TotalAmt": 1400.0,
             "EntityRef": {"name": "Daniel Business"}, "PrivateNote": "Monthly salary July"},
        ]
        result = control.check_salary_month_attribution(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "WARN")
        self.assertEqual(result["issues_found"], 1)
        self.assertEqual(result["issues"][0]["pattern"], "daniel_monthly")

    def test_weekly_cadence_tolerates_five_payments(self):
        rows = [
            {"Id": str(i), "TxnDate": f"2026-07-{day:02d}", "TotalAmt": 280.0,
             "EntityRef": {"name": "Sergio Gracia"}, "PrivateNote": "weekly payment"}
            for i, day in enumerate((1, 8, 15, 22, 29), start=1)
        ]
        result = control.check_salary_month_attribution(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")

    def test_config_patterns_are_reported_with_the_result(self):
        result = control.check_salary_month_attribution(make_context(qbo=StubQBO([])))
        self.assertEqual(
            result["patterns_from_config"],
            ["daniel_monthly", "sergio_weekly", "susy_cleaning"],
        )


# ---------------------------------------------------------------------------
# Remaining checks
# ---------------------------------------------------------------------------

class OtherCheckTests(unittest.TestCase):
    def test_duplicates_without_distinct_references_fail(self):
        rows = [
            {"Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 100.0,
             "EntityRef": {"value": "9", "name": "Costco"}, "PrivateNote": ""},
            {"Id": "2", "TxnDate": "2026-07-02", "TotalAmt": 100.0,
             "EntityRef": {"value": "9", "name": "Costco"}, "PrivateNote": ""},
        ]
        result = control.check_duplicates(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["duplicates_found"], 1)
        self.assertEqual(result["purchases_scanned"], 2)

    def test_spei_fees_on_the_same_day_are_not_duplicates(self):
        """Each transfer raises its own commission and IVA at identical amounts."""
        rows = [
            {"Id": str(2488 + i), "TxnDate": "2026-08-13", "TotalAmt": 0.23,
             "EntityRef": {"value": "7", "name": "Kapital Mexico"},
             "PrivateNote": "SPEI Commission on transfer to Sergio Gracia | FX: 17.06"}
            for i in range(9)
        ]
        result = control.check_duplicates(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["spei_fees_excluded"], 9)

    def test_spei_iva_lines_are_excluded_too(self):
        rows = [
            {"Id": str(i), "TxnDate": "2026-08-13", "TotalAmt": 0.04,
             "EntityRef": {"value": "7"},
             "PrivateNote": "SPEI IVA on transfer to Sergio Gracia"}
            for i in (1, 2, 3)
        ]
        result = control.check_duplicates(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")

    def test_a_real_duplicate_is_still_caught_alongside_fees(self):
        rows = [
            {"Id": "1", "TxnDate": "2026-08-13", "TotalAmt": 0.23,
             "EntityRef": {"value": "7"}, "PrivateNote": "SPEI Commission on transfer to X"},
            {"Id": "2", "TxnDate": "2026-08-13", "TotalAmt": 0.23,
             "EntityRef": {"value": "7"}, "PrivateNote": "SPEI Commission on transfer to X"},
            {"Id": "3", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
            {"Id": "4", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
        ]
        result = control.check_duplicates(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["duplicates_found"], 1)
        self.assertEqual(result["duplicates"][0]["ids"], ["3", "4"])

    def test_a_reviewed_pair_can_be_accepted_by_allowlist(self):
        rows = [
            {"Id": "3", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
            {"Id": "4", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
        ]
        config = base_config(receipt_coverage={"duplicate_allowlist": ["3", "4"]})
        result = control.check_duplicates(make_context(config=config, qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["groups_accepted_by_allowlist"], 1)

    def test_allowlist_does_not_cover_a_group_it_only_partly_names(self):
        rows = [
            {"Id": "3", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
            {"Id": "4", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
            {"Id": "5", "TxnDate": "2026-07-31", "TotalAmt": 10.02,
             "EntityRef": {}, "PrivateNote": "ANTHROPIC"},
        ]
        config = base_config(receipt_coverage={"duplicate_allowlist": ["3", "4"]})
        result = control.check_duplicates(make_context(config=config, qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "FAIL")

    def test_distinct_kapital_references_are_not_duplicates(self):
        rows = [
            {"Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 100.0,
             "EntityRef": {"value": "9"}, "PrivateNote": "Clave: 111"},
            {"Id": "2", "TxnDate": "2026-07-02", "TotalAmt": 100.0,
             "EntityRef": {"value": "9"}, "PrivateNote": "Clave: 222"},
        ]
        result = control.check_duplicates(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")

    def test_unattributed_group_activity_warns(self):
        rows = [{
            "Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 50.0,
            "EntityRef": {}, "PrivateNote": "misc supplies",
            "Line": [{"DetailType": "AccountBasedExpenseLineDetail",
                      "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "40"}}}],
        }]
        result = control.check_orphaned_group_activities(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "WARN")
        self.assertEqual(result["orphans_found"], 1)

    def test_attributed_group_activity_passes(self):
        rows = [{
            "Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 50.0,
            "EntityRef": {}, "PrivateNote": "supplies for the Ramirez wedding",
            "Line": [{"DetailType": "AccountBasedExpenseLineDetail",
                      "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "40"}}}],
        }]
        result = control.check_orphaned_group_activities(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")

    def test_food_memo_without_attribution_warns(self):
        rows = [{
            "Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 50.0,
            "EntityRef": {}, "PrivateNote": "groceries run", "Line": [],
        }]
        result = control.check_orphaned_food_expenses(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "WARN")

    def test_spei_fee_split_is_expected_and_passes(self):
        rows = [{
            "Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 50.0,
            "EntityRef": {"name": "Vendor"}, "PrivateNote": "",
            "Line": [
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "43", "name": "Contract Labor"}}},
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "44", "name": "Bank Fee"}}},
            ],
        }]
        result = control.check_uncategorized_expenses(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "pass")

    def test_embedded_fee_split_is_recognised_without_account_names(self):
        """QBO omits AccountRef.name on queries; matching on it flagged every
        commission+IVA purchase as an unexpected split."""
        rows = [{
            "Id": "2365", "TxnDate": "2026-07-02", "TotalAmt": 1451.37,
            "EntityRef": {"name": "Daniel Business"}, "PrivateNote": "Daniel monthly salary",
            "Line": [
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "43"}}},
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "44"}}},
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "44"}}},
            ],
        }]
        result = control.check_uncategorized_expenses(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["unexpected_splits"], 0)

    def test_a_genuine_multi_category_split_is_still_flagged(self):
        rows = [{
            "Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 100.0,
            "EntityRef": {"name": "Vendor"}, "PrivateNote": "",
            "Line": [
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "40"}}},
                {"DetailType": "AccountBasedExpenseLineDetail",
                 "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "41"}}},
            ],
        }]
        result = control.check_uncategorized_expenses(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["unexpected_splits"], 1)

    def test_uncategorized_account_warns(self):
        rows = [{
            "Id": "1", "TxnDate": "2026-07-02", "TotalAmt": 50.0,
            "EntityRef": {"name": "Vendor"}, "PrivateNote": "",
            "Line": [{"DetailType": "AccountBasedExpenseLineDetail",
                      "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "42"}}}],
        }]
        result = control.check_uncategorized_expenses(make_context(qbo=StubQBO(rows)))
        self.assertEqual(result["status"], "WARN")
        self.assertEqual(result["uncategorized_count"], 1)

    def test_missing_account_config_is_an_error(self):
        config = base_config(qbo_accounts={"expenses": {}})
        with self.assertRaises(control.CheckError):
            control.check_uncategorized_expenses(make_context(config=config))


# ---------------------------------------------------------------------------
# Runner: terminal results, evidence ids, exit semantics (F-014a/b/c)
# ---------------------------------------------------------------------------

class RunnerTests(unittest.TestCase):
    def test_all_seven_checks_report_a_terminal_status_with_an_evidence_id(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = make_ledger(directory, [])
            context = make_context(
                runner=stub_runner({CHANNEL_GENERAL: [[]], CHANNEL_MAYELA: [[]]}),
                db_path=db_path,
            )
            results = control.run_all_checks(context, "RUN1")
        self.assertEqual(len(results), 7)
        for name, result in results.items():
            self.assertIn(result["status"], {"pass", "WARN", "FAIL", "ERROR"}, name)
            self.assertEqual(result["evidence_id"], f"KT-RUN1-{name}")

    def test_a_crashing_check_becomes_an_error_and_the_rest_still_run(self):
        context = make_context(db_path="/nonexistent/crm.db")
        results = control.run_all_checks(context, "RUN2")
        self.assertEqual(results["receipt_coverage"]["status"], "ERROR")
        self.assertEqual(results["duplicates"]["status"], "pass")
        self.assertEqual(len(results), 7)

    def test_overall_status_escalates_fail_over_warn(self):
        self.assertEqual(control.overall_status({"a": {"status": "pass"}}), "pass")
        self.assertEqual(
            control.overall_status({"a": {"status": "WARN"}, "b": {"status": "pass"}}), "WARN"
        )
        self.assertEqual(
            control.overall_status({"a": {"status": "WARN"}, "b": {"status": "FAIL"}}), "FAIL"
        )
        self.assertEqual(control.overall_status({"a": {"status": "ERROR"}}), "FAIL")

    def test_report_carries_every_evidence_id(self):
        results = {
            "duplicates": {"test": "duplicate_detection", "status": "FAIL",
                           "duplicates_found": 2, "evidence_id": "KT-RUN3-duplicates"},
            "uncategorized": {"test": "uncategorized_expenses", "status": "pass",
                              "evidence_id": "KT-RUN3-uncategorized"},
        }
        report = control.format_report(results, "RUN3", "FAIL")
        self.assertIn("KT-RUN3-duplicates", report)
        self.assertIn("KT-RUN3-uncategorized", report)
        self.assertIn("2 possible duplicates", report)

    def test_run_record_is_written_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state" / "kapital-tests-last-run.json"
            control.write_run_record({"a": {"status": "pass"}}, "RUN4", "pass", target)
            written = json.loads(target.read_text())
        self.assertEqual(written["run"], "RUN4")
        self.assertEqual(written["overall"], "pass")
        self.assertFalse(target.with_suffix(".tmp").exists())


class ExitSemanticsTests(unittest.TestCase):
    """The old control always exited 0, so launchd recorded failures as success."""

    def run_main(self, results, *, post_fails=False, env=None):
        recorded = {}

        def fake_record(job, success, detail=None):
            recorded.update({"job": job, "success": success, "detail": detail})

        def fake_post(*args, **kwargs):
            if post_fails:
                raise RuntimeError("slack down")

        environment = {
            "OPENCLAW_SLACK_ACCOUNT": "A1",
            "RESORT_ACCOUNTING_CHANNEL": "C1",
        }
        environment.update(env or {})

        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict("os.environ", environment, clear=False), \
                 mock.patch.object(control, "QBOClient", lambda *a, **k: StubQBO()), \
                 mock.patch.object(control, "load_config", base_config), \
                 mock.patch.object(control, "run_all_checks", lambda *a, **k: results), \
                 mock.patch.object(control, "post_to_slack", fake_post), \
                 mock.patch.dict(sys.modules, {
                     "job_health": mock.Mock(record=fake_record),
                     "runtime_paths": mock.Mock(
                         runtime_state_path=lambda name: Path(directory) / name
                     ),
                 }):
                code = control.main([])
        return code, recorded

    def test_a_clean_run_exits_zero_and_records_healthy(self):
        code, recorded = self.run_main({"duplicates": {"status": "pass", "test": "d"}})
        self.assertEqual(code, 0)
        self.assertTrue(recorded["success"])
        self.assertEqual(recorded["job"], "resort-kapital-tests")

    def test_a_failing_check_exits_nonzero_and_records_failure(self):
        code, recorded = self.run_main({"duplicates": {"status": "FAIL", "test": "d"}})
        self.assertEqual(code, 1)
        self.assertFalse(recorded["success"])
        self.assertIn("failing: duplicates", recorded["detail"])

    def test_an_errored_check_exits_nonzero(self):
        code, recorded = self.run_main({"receipt_coverage": {"status": "ERROR", "test": "r"}})
        self.assertEqual(code, 1)
        self.assertFalse(recorded["success"])

    def test_a_warning_stays_green_but_is_reported(self):
        code, recorded = self.run_main({"orphans": {"status": "WARN", "test": "o"}})
        self.assertEqual(code, 0)
        self.assertTrue(recorded["success"])
        self.assertIn("warn: orphans", recorded["detail"])

    def test_a_report_nobody_received_is_a_failure(self):
        code, recorded = self.run_main(
            {"duplicates": {"status": "pass", "test": "d"}}, post_fails=True
        )
        self.assertEqual(code, 1)
        self.assertFalse(recorded["success"])
        self.assertIn("slack post failed", recorded["detail"])

    def test_missing_slack_configuration_is_a_failure(self):
        code, recorded = self.run_main(
            {"duplicates": {"status": "pass", "test": "d"}},
            env={"RESORT_ACCOUNTING_CHANNEL": ""},
        )
        self.assertEqual(code, 1)
        self.assertIn("slack post failed", recorded["detail"])


# ---------------------------------------------------------------------------
# Credentials — F-014(d) / F-036 writer #4
# ---------------------------------------------------------------------------

class CredentialHandlingTests(unittest.TestCase):
    def test_the_control_defines_no_token_refresh_of_its_own(self):
        source = Path(control.__file__).read_text(encoding="utf-8")
        self.assertNotIn("oauth.platform.intuit.com", source)
        self.assertNotIn("grant_type=refresh_token", source)
        self.assertNotIn("refresh_token", source)

    def test_the_control_never_opens_the_secrets_store_for_writing(self):
        source = Path(control.__file__).read_text(encoding="utf-8")
        self.assertNotIn("quickbooks.json", source)

    def test_qbo_access_goes_through_the_sanctioned_client(self):
        self.assertIs(control.QBOClient, __import__("qbo_push").QBOClient)

    def test_the_sanctioned_client_locks_and_writes_atomically(self):
        source = (Path(control.__file__).parent / "qbo_push.py").read_text(encoding="utf-8")
        self.assertIn(".refresh.lock", source)
        self.assertIn("flock", source)
        self.assertIn("os.replace", source)
        self.assertIn("SOCIALSOL_SECRETS_DIR", source)


# ---------------------------------------------------------------------------
# Schedule and watchdog coverage
# ---------------------------------------------------------------------------

class ScheduleTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def manifest(self):
        return json.loads(
            (self.ROOT / "deploy" / "launchagents" / "service-manifest.json")
            .read_text(encoding="utf-8")
        )

    def test_the_job_is_watchdog_covered(self):
        watchdog = self.manifest()["watchdog"]
        self.assertIn(control.JOB_NAME, watchdog)
        self.assertGreaterEqual(watchdog[control.JOB_NAME]["max_age_hours"], 168)

    def test_the_job_is_a_loaded_manifest_service(self):
        self.assertEqual(self.manifest()["services"]["kapital-tests"]["state"], "loaded")

    def test_the_template_carries_the_env_the_control_needs(self):
        template = (
            self.ROOT / "deploy" / "launchagents" / "templates"
            / "com.lapuestadelsolresort.kapital-tests.plist.template"
        ).read_text(encoding="utf-8")
        for key in ("SOCIALSOL_SECRETS_DIR", "OPENCLAW_SLACK_ACCOUNT",
                    "RESORT_ACCOUNTING_CHANNEL", "WorkingDirectory"):
            self.assertIn(key, template)

    def test_the_template_logs_inside_the_repo_not_tmp(self):
        template = (
            self.ROOT / "deploy" / "launchagents" / "templates"
            / "com.lapuestadelsolresort.kapital-tests.plist.template"
        ).read_text(encoding="utf-8")
        self.assertNotIn("/tmp/", template)
        self.assertIn("__SOCIALSOL_ROOT__/logs/kapital-tests.log", template)


if __name__ == "__main__":
    unittest.main()
