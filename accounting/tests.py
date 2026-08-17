#!/usr/bin/env python3
"""Weekly Kapital accounting integrity control.

Seven checks, every one of which reaches a terminal verdict. The two that used
to stop at `needs_slack_scan` — receipt-channel coverage and the Mayela
checkmark reconciliation — handed prose instructions to an orchestrator that
no longer exists, so they never produced a result at all; they now do the
Slack read themselves and answer.

Verdicts, and what each means for the exit code:

  pass  — the check ran and found nothing
  WARN  — an attribution or review backlog for a human to work through. The
          control itself is healthy, so the job still exits 0 and the counts
          go out with the report.
  FAIL  — an integrity violation: duplicate bookings, or receipts and
          confirmed payments older than the grace window with nothing in the
          books.
  ERROR — the check could not complete.

FAIL or ERROR anywhere exits nonzero and records a job_health failure, so the
watchdog owns the alert instead of launchd recording a success. A failed
Slack post is itself nonzero — a report nobody received is not a report.

QBO access goes through the sanctioned qbo_push.QBOClient, which resolves
secrets via SOCIALSOL_SECRETS_DIR and refreshes under a flock with an atomic
mode-600 write. This module performs no credential writes of its own.

Every QBO query pages to exhaustion rather than silently taking the first
page, and the salary matrix comes from config rather than a copy kept in code.
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "automation"))

from qbo_push import QBOClient  # noqa: E402
from slack_scan import (  # noqa: E402
    CHECKMARK,
    SlackScanError,
    has_reaction,
    message_ts,
    read_channel_since,
    receipt_candidates,
)

ROOT = Path(__file__).resolve().parent.parent
JOB_NAME = "resort-kapital-tests"
PAGE_SIZE = 500
MAX_ROWS = 20000
DEFAULT_GRACE_DAYS = 7
DEFAULT_MONTHS_BACK = 3

# Receipt-ledger statuses, grouped by who the receipt is waiting on.
CLOSED_STATUSES = {"posted", "ignored"}
AWAITING_HUMAN_STATUSES = {"needs_review", "awaiting_payment_source"}


class CheckError(RuntimeError):
    """A check could not reach a verdict."""


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------

def load_config(config_path=None):
    path = Path(config_path or (Path(__file__).resolve().parent / "config.json"))
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def database_path():
    """The CRM database the runtime itself resolves to.

    Honours DB_PATH — the same name the Node runtime honours — rather than
    introducing a third spelling of the path.
    """
    return os.environ.get("DB_PATH") or str(ROOT / "crm" / "data" / "crm.db")


class Context:
    """What the checks share: config, QBO, Slack, and the receipt ledger."""

    def __init__(self, client, config, *, slack_account=None, db_path=None,
                 months_back=DEFAULT_MONTHS_BACK, now=None, runner=subprocess.run):
        self.client = client
        self.config = config
        self.slack_account = slack_account
        self.db_path = db_path or database_path()
        self.months_back = months_back
        self.now = now or datetime.now(timezone.utc)
        self.runner = runner
        self._ledger = None

    @property
    def window_start(self):
        start = self.now.date().replace(day=1) - timedelta(days=self.months_back * 31)
        return start.replace(day=1)

    @property
    def today(self):
        return self.now.date()

    def coverage_settings(self):
        settings = self.config.get("receipt_coverage") or {}
        grace = float(settings.get("grace_days", DEFAULT_GRACE_DAYS))
        start_raw = settings.get("start_date")
        start = None
        if start_raw:
            try:
                start = datetime.fromisoformat(
                    str(start_raw).replace("Z", "+00:00")
                )
            except ValueError as exc:
                raise CheckError(f"receipt_coverage.start_date is not a date: {exc}")
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
        return grace, start

    def receipt_ledger(self):
        """Receipts the pipeline durably recorded, keyed by Slack identity."""
        if self._ledger is None:
            database = Path(self.db_path)
            if not database.is_file():
                raise CheckError(f"receipt ledger database not found at {database}")
            connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
            try:
                connection.row_factory = sqlite3.Row
                rows = connection.execute(
                    "SELECT slack_channel_id, slack_message_id, status, "
                    "qbo_entity_id, amount, currency, submitted_at "
                    "FROM accounting_receipts"
                ).fetchall()
            finally:
                connection.close()
            self._ledger = {
                (row["slack_channel_id"], row["slack_message_id"]): dict(row)
                for row in rows
            }
        return self._ledger

    def ledger_start(self):
        """When the receipt pipeline began recording anything at all.

        Receipts posted before that cannot be a pipeline coverage failure —
        there was no pipeline. They are counted and reported, never failed.
        Resolved to the instant, not the day: the pipeline went live partway
        through its first day, and receipts posted earlier that same morning
        would otherwise read as misses.
        """
        stamps = [
            row.get("submitted_at") for row in self.receipt_ledger().values()
            if row.get("submitted_at")
        ]
        if not stamps:
            return None
        try:
            return datetime.fromisoformat(min(stamps).replace("Z", "+00:00"))
        except ValueError:
            return None

    def scan_channel(self, channel_id, since):
        if not self.slack_account:
            raise CheckError("OPENCLAW_SLACK_ACCOUNT is not set; Slack scan impossible")
        since_ts = datetime(
            since.year, since.month, since.day, tzinfo=timezone.utc
        ).timestamp()
        return read_channel_since(
            channel_id, since_ts,
            account=self.slack_account,
            runner=self.runner,
        )


# ---------------------------------------------------------------------------
# QBO helpers
# ---------------------------------------------------------------------------

def _entities(response):
    query_response = (response or {}).get("QueryResponse") or {}
    for value in query_response.values():
        if isinstance(value, list):
            return value
    return []


def query_all(client, select_clause, where_clause=""):
    """Page a QBO query to exhaustion.

    QBO caps an unqualified query at one page and says nothing about it, so a
    bare SELECT reports a partial window as though it were the whole thing.
    """
    rows = []
    start = 1
    while True:
        sql = " ".join(part for part in (
            select_clause, where_clause,
            f"ORDERBY Id STARTPOSITION {start} MAXRESULTS {PAGE_SIZE}",
        ) if part).strip()
        batch = _entities(client.query(sql))
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        start += PAGE_SIZE
        if len(rows) > MAX_ROWS:
            raise CheckError(
                f"query exceeded {MAX_ROWS} rows without terminating: {select_clause}"
            )


def purchases_in_window(context, fields="*"):
    """Purchases in the window, with full line detail.

    The projection is `*` on purpose: naming fields makes QBO return Line
    objects carrying only DetailType and Id — no account reference, no amount
    — so every account-based check silently matches nothing and reports a
    clean pass it never actually performed.
    """
    return query_all(
        context.client,
        f"SELECT {fields} FROM Purchase",
        f"WHERE TxnDate >= '{context.window_start.isoformat()}' "
        f"AND TxnDate <= '{context.today.isoformat()}'",
    )


def _account_id(config, key):
    accounts = (config.get("qbo_accounts") or {}).get("expenses") or {}
    value = (accounts.get(key) or {}).get("id")
    if not value:
        raise CheckError(f"qbo_accounts.expenses.{key}.id is not configured")
    return str(value)


def _line_accounts(purchase):
    accounts = set()
    for line in purchase.get("Line") or []:
        detail = line.get("AccountBasedExpenseLineDetail") or {}
        reference = (detail.get("AccountRef") or {}).get("value")
        if reference:
            accounts.add(str(reference))
    return accounts


def is_fee_purchase(purchase, bank_fee_id):
    """A standalone bank-fee Purchase raised alongside a SPEI transfer.

    Every transfer raises its own commission and IVA at the same tiny amounts,
    so several land on one day with identical date, amount and vendor and no
    Kapital reference to tell them apart. They are distinct fees for distinct
    transfers, deduplicated by their own parent matcher — grouping them as
    duplicates flags normal activity as a books-integrity failure.

    Recognised by where the money lands, not by the memo: the current pipeline
    writes "SPEI Commission on transfer to X" while the legacy statements
    wrote "Kapital Mexico Bank: [Bank Fees] SPEI Commission/VAT", and a memo
    pattern only ever covers the formats that existed when it was written.
    """
    accounts = _line_accounts(purchase)
    return bool(accounts) and accounts == {bank_fee_id}


ATTRIBUTION_KEYWORDS = (
    "guest", "group", "booking", "client", "wedding",
    "retreat", "villa", "reservation", "airbnb", "ownerrez",
)


def _has_attribution(note, keywords=ATTRIBUTION_KEYWORDS):
    lowered = (note or "").lower()
    return any(keyword in lowered for keyword in keywords)


def _age_days(context, stamp):
    return (context.now - stamp).total_seconds() / 86400.0


# ---------------------------------------------------------------------------
# Check 1 — receipt channel coverage
# ---------------------------------------------------------------------------

def check_receipt_channel_coverage(context):
    """Every receipt posted to a receipt channel reached the books.

    Slack is the authority for what was posted, the durable receipt ledger for
    what the pipeline did with it, and QBO for whether it was booked. A
    receipt with no ledger row is the one the pipeline never saw.
    """
    channels = context.config.get("receipt_channels") or {}
    if not channels:
        raise CheckError("no receipt_channels configured")
    grace_days, configured_start = context.coverage_settings()
    ledger = context.receipt_ledger()
    pipeline_start = configured_start or context.ledger_start()

    not_ingested, not_booked, awaiting_human = [], [], []
    pending = pre_pipeline = scanned = 0

    for channel_id, channel in channels.items():
        messages = context.scan_channel(channel_id, context.window_start)
        for message in receipt_candidates(messages):
            scanned += 1
            posted_at = datetime.fromtimestamp(message_ts(message), tz=timezone.utc)
            if pipeline_start and posted_at < pipeline_start:
                pre_pipeline += 1
                continue
            age = _age_days(context, posted_at)
            if age <= grace_days:
                pending += 1
                continue
            record = {
                "channel": channel.get("name") or channel_id,
                "posted_at": posted_at.date().isoformat(),
                "age_days": round(age, 1),
                "message_ts": message.get("ts"),
            }
            row = ledger.get((channel_id, message.get("ts")))
            if row is None:
                not_ingested.append(record)
            elif row.get("qbo_entity_id") or row.get("status") in CLOSED_STATUSES:
                continue
            elif row.get("status") in AWAITING_HUMAN_STATUSES:
                awaiting_human.append({**record, "status": row.get("status")})
            else:
                not_booked.append({**record, "status": row.get("status")})

    failures = len(not_ingested) + len(not_booked)
    if failures:
        status = "FAIL"
    elif awaiting_human:
        status = "WARN"
    else:
        status = "pass"
    return {
        "test": "receipt_channel_coverage",
        "status": status,
        "channels_scanned": len(channels),
        "receipts_scanned": scanned,
        "receipts_pending_within_grace": pending,
        "receipts_before_pipeline_start": pre_pipeline,
        "pipeline_start": pipeline_start.isoformat() if pipeline_start else None,
        "grace_days": grace_days,
        "not_ingested": not_ingested[:20],
        "not_ingested_count": len(not_ingested),
        "not_booked": not_booked[:20],
        "not_booked_count": len(not_booked),
        "awaiting_human": awaiting_human[:20],
        "awaiting_human_count": len(awaiting_human),
        "action": (
            "Receipts posted to Slack never reached the books — check the accounting inbox workflow"
            if failures else "Work the receipt review queue" if awaiting_human else None
        ),
    }


# ---------------------------------------------------------------------------
# Check 2 — duplicate detection
# ---------------------------------------------------------------------------

def check_duplicates(context):
    """The same date, amount and vendor booked more than once.

    Two kinds of repeat are normal rather than suspicious, and both are
    excluded before grouping: standalone bank fees, and vendors that bill in
    identical increments many times a day — an ad platform charging $4 nine
    times on one date is spend, not a double entry.
    """
    purchases = purchases_in_window(context)
    bank_fee_id = _account_id(context.config, "bank_fee")
    settings = context.config.get("receipt_coverage") or {}
    allowlist = {str(entry) for entry in (settings.get("duplicate_allowlist") or [])}
    exempt_vendors = [
        str(name).strip().lower()
        for name in (settings.get("duplicate_exempt_vendors") or [])
        if str(name).strip()
    ]
    groups = defaultdict(list)
    fees_skipped = exempt_skipped = 0
    for purchase in purchases:
        if is_fee_purchase(purchase, bank_fee_id):
            fees_skipped += 1
            continue
        vendor_name = ((purchase.get("EntityRef") or {}).get("name") or "").lower()
        if vendor_name and any(name in vendor_name for name in exempt_vendors):
            exempt_skipped += 1
            continue
        vendor = (purchase.get("EntityRef") or {}).get("value", "none")
        groups[(purchase.get("TxnDate"), str(purchase.get("TotalAmt")), vendor)].append(purchase)

    duplicates, accepted = [], 0
    for key, items in groups.items():
        if len(items) < 2:
            continue
        references = set()
        for item in items:
            match = re.search(r"Clave:\s*([\d\-/]+)", item.get("PrivateNote") or "")
            if match:
                references.add(match.group(1))
        if len(references) >= len(items):
            continue
        if allowlist and all(str(item.get("Id")) in allowlist for item in items):
            accepted += 1
            continue
        duplicates.append({
            "date": key[0],
            "amount": float(key[1]),
            "vendor": (items[0].get("EntityRef") or {}).get("name", "N/A"),
            "count": len(items),
            "ids": [item.get("Id") for item in items],
            "distinct_references": len(references),
        })

    return {
        "test": "duplicate_detection",
        "status": "pass" if not duplicates else "FAIL",
        "purchases_scanned": len(purchases),
        "bank_fees_excluded": fees_skipped,
        "exempt_vendor_rows_excluded": exempt_skipped,
        "groups_accepted_by_allowlist": accepted,
        "date_range": f"{context.window_start.isoformat()} to {context.today.isoformat()}",
        "duplicates_found": len(duplicates),
        "duplicates": duplicates[:20],
    }


# ---------------------------------------------------------------------------
# Checks 3 and 4 — orphaned expenses
# ---------------------------------------------------------------------------

def _orphan_check(context, *, name, account_key, keywords, action, extra_match=None):
    account_id = _account_id(context.config, account_key)
    purchases = purchases_in_window(context)
    orphans = []
    for purchase in purchases:
        note = purchase.get("PrivateNote") or ""
        in_scope = account_id in _line_accounts(purchase)
        if not in_scope and extra_match:
            in_scope = extra_match(note)
        if not in_scope or _has_attribution(note, keywords):
            continue
        orphans.append({
            "id": purchase.get("Id"),
            "date": purchase.get("TxnDate"),
            "amount": purchase.get("TotalAmt"),
            "note": note[:120],
        })
    return {
        "test": name,
        "status": "pass" if not orphans else "WARN",
        "purchases_scanned": len(purchases),
        "orphans_found": len(orphans),
        "orphans": orphans[:20],
        "action": action if orphans else None,
    }


def check_orphaned_group_activities(context):
    """Group-activity expenses with no client or booking in the memo."""
    return _orphan_check(
        context,
        name="orphaned_group_activities",
        account_key="group_activities",
        keywords=ATTRIBUTION_KEYWORDS,
        action="Ping Mayela to attribute these to a specific group/booking",
    )


FOOD_KEYWORDS = (
    "food", "comida", "groceries", "grocery", "refrigerator", "fridge",
    "kitchen", "cook", "chef", "aliment", "meat", "carne", "pollo",
    "fruit", "fruta",
)


def check_orphaned_food_expenses(context):
    """Food expenses with no guest or booking in the memo."""
    def looks_like_food(note):
        lowered = (note or "").lower()
        return any(keyword in lowered for keyword in FOOD_KEYWORDS)

    return _orphan_check(
        context,
        name="orphaned_food_expenses",
        account_key="supplies_group",
        keywords=("guest", "group", "booking", "client", "villa",
                  "reservation", "airbnb", "ownerrez"),
        action="Ping Mayela/Daniel to attribute to specific guests",
        extra_match=looks_like_food,
    )


# ---------------------------------------------------------------------------
# Check 5 — salary month attribution
# ---------------------------------------------------------------------------

def salary_matrix(config):
    """Who is on salary and how often — from config, not a copy in code.

    A roster hard-coded here drifts away from the config the rest of the
    accounting stack classifies against, and silently stops matching when
    somebody's rate or cadence changes.
    """
    matrix = {}
    for key, pattern in (config.get("salary_patterns") or {}).items():
        payees = [p.strip().upper() for p in str(pattern.get("payee", "")).split("|") if p.strip()]
        if not payees:
            continue
        keyword_text = str(pattern.get("keyword", ""))
        if "expected_amount_per_day" in pattern:
            cadence = "daily"
        elif "weekly" in key.lower() or "WEEKLY" in keyword_text.upper():
            cadence = "weekly"
        else:
            cadence = "monthly"
        matrix[key] = {
            "payees": payees,
            "cadence": cadence,
            "keywords": [k.strip().lower() for k in keyword_text.split("|") if k.strip()],
        }
    if not matrix:
        raise CheckError("no salary_patterns configured")
    return matrix


CADENCE_LIMITS = {"monthly": 1, "weekly": 5, "daily": 31}


def check_salary_month_attribution(context):
    """More salary payments inside one calendar month than the cadence allows."""
    matrix = salary_matrix(context.config)
    purchases = purchases_in_window(context)

    by_pattern_month = defaultdict(list)
    for purchase in purchases:
        vendor = ((purchase.get("EntityRef") or {}).get("name") or "").upper()
        note = (purchase.get("PrivateNote") or "").lower()
        for key, pattern in matrix.items():
            if not any(payee in vendor for payee in pattern["payees"]):
                continue
            if pattern["keywords"] and not any(k in note for k in pattern["keywords"]):
                continue
            by_pattern_month[(key, str(purchase.get("TxnDate", ""))[:7])].append(purchase)
            break

    issues = []
    for (key, month), payments in sorted(by_pattern_month.items()):
        cadence = matrix[key]["cadence"]
        limit = CADENCE_LIMITS[cadence]
        if len(payments) <= limit:
            continue
        issues.append({
            "pattern": key,
            "cadence": cadence,
            "month": month,
            "payment_count": len(payments),
            "expected_max": limit,
            "amounts": [p.get("TotalAmt") for p in payments],
            "dates": [p.get("TxnDate") for p in payments],
            "ids": [p.get("Id") for p in payments],
            "issue": (
                f"{key} has {len(payments)} payments in {month} "
                f"(expected at most {limit} for {cadence})"
            ),
        })

    return {
        "test": "salary_month_attribution",
        "status": "pass" if not issues else "WARN",
        "patterns_from_config": sorted(matrix),
        "purchases_scanned": len(purchases),
        "issues_found": len(issues),
        "issues": issues[:20],
        "action": "Re-attribute the earlier payment to the prior month if the memos confirm" if issues else None,
    }


# ---------------------------------------------------------------------------
# Check 6 — Mayela checkmark reconciliation
# ---------------------------------------------------------------------------

def check_mayela_checkmark(context):
    """Payments marked as made are actually in the books.

    A checkmark is a human asserting the money moved, so a checkmarked receipt
    with nothing booked past the grace window is a real gap, not a queue.
    """
    channels = {
        cid: channel
        for cid, channel in (context.config.get("receipt_channels") or {}).items()
        if "mayela" in str(channel.get("scope", "")).lower()
    }
    if not channels:
        raise CheckError("no receipt channel is scoped to mayela")
    grace_days, configured_start = context.coverage_settings()
    ledger = context.receipt_ledger()
    pipeline_start = configured_start or context.ledger_start()

    unbooked = []
    pending = pre_pipeline = confirmed = 0
    for channel_id, channel in channels.items():
        for message in context.scan_channel(channel_id, context.window_start):
            if not has_reaction(message, CHECKMARK):
                continue
            confirmed += 1
            marked_at = datetime.fromtimestamp(message_ts(message), tz=timezone.utc)
            if pipeline_start and marked_at < pipeline_start:
                pre_pipeline += 1
                continue
            age = _age_days(context, marked_at)
            if age <= grace_days:
                pending += 1
                continue
            row = ledger.get((channel_id, message.get("ts")))
            if row and (row.get("qbo_entity_id") or row.get("status") in CLOSED_STATUSES):
                continue
            unbooked.append({
                "channel": channel.get("name") or channel_id,
                "confirmed_at": marked_at.date().isoformat(),
                "age_days": round(age, 1),
                "message_ts": message.get("ts"),
                "ledger_status": (row or {}).get("status"),
            })

    return {
        "test": "mayela_checkmark_reconciliation",
        "status": "pass" if not unbooked else "FAIL",
        "channels_scanned": len(channels),
        "confirmed_payments": confirmed,
        "pending_within_grace": pending,
        "before_pipeline_start": pre_pipeline,
        "grace_days": grace_days,
        "unbooked_count": len(unbooked),
        "unbooked": unbooked[:20],
        "action": "Confirmed-paid receipts are not booked in QBO" if unbooked else None,
    }


# ---------------------------------------------------------------------------
# Check 7 — uncategorized and split expenses
# ---------------------------------------------------------------------------

def check_uncategorized_expenses(context):
    """Expenses with no category, an unexpected split, or no vendor."""
    uncategorized_id = _account_id(context.config, "uncategorized_expense")
    bank_fee_id = _account_id(context.config, "bank_fee")
    purchases = purchases_in_window(context)

    uncategorized, splits = [], []
    for purchase in purchases:
        note = purchase.get("PrivateNote") or ""
        vendor = (purchase.get("EntityRef") or {}).get("name")

        if uncategorized_id in _line_accounts(purchase):
            uncategorized.append({
                "id": purchase.get("Id"),
                "date": purchase.get("TxnDate"),
                "amount": purchase.get("TotalAmt"),
                "vendor": vendor,
                "note": note[:100],
            })

        expense_lines = [
            line for line in (purchase.get("Line") or [])
            if line.get("DetailType") == "AccountBasedExpenseLineDetail"
        ]
        if len(expense_lines) > 1:
            # Match the fee account by id: QBO does not always populate
            # AccountRef.name on a query, and an absent name used to make
            # every embedded-fee purchase look like an unexpected split.
            accounts = set()
            for line in expense_lines:
                detail = line.get("AccountBasedExpenseLineDetail") or {}
                accounts.add(str((detail.get("AccountRef") or {}).get("value", "")))
            non_fee = accounts - {bank_fee_id}
            if not (bank_fee_id in accounts and len(non_fee) == 1):
                splits.append({
                    "id": purchase.get("Id"),
                    "date": purchase.get("TxnDate"),
                    "amount": purchase.get("TotalAmt"),
                    "vendor": vendor,
                    "line_count": len(expense_lines),
                    "accounts": sorted(accounts),
                    "note": note[:100],
                })

        if not vendor and "MXN" in note and (purchase.get("TotalAmt") or 0) > 1.0:
            uncategorized.append({
                "id": purchase.get("Id"),
                "date": purchase.get("TxnDate"),
                "amount": purchase.get("TotalAmt"),
                "note": note[:100],
                "issue": "No vendor assigned",
            })

    return {
        "test": "uncategorized_expenses",
        "status": "pass" if not (uncategorized or splits) else "WARN",
        "purchases_scanned": len(purchases),
        "uncategorized_count": len(uncategorized),
        "unexpected_splits": len(splits),
        "uncategorized": uncategorized[:20],
        "splits": splits[:20],
        "action": (
            "Assign categories/vendors, or confirm the splits are intended"
            if (uncategorized or splits) else None
        ),
    }


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

CHECKS = (
    ("receipt_coverage", check_receipt_channel_coverage),
    ("duplicates", check_duplicates),
    ("orphaned_group_activities", check_orphaned_group_activities),
    ("orphaned_food_expenses", check_orphaned_food_expenses),
    ("salary_month_attribution", check_salary_month_attribution),
    ("mayela_checkmark", check_mayela_checkmark),
    ("uncategorized", check_uncategorized_expenses),
)

FAILING_STATUSES = {"FAIL", "ERROR"}
ICONS = {"pass": "✅", "WARN": "⚠️", "FAIL": "❌", "ERROR": "❌"}


def evidence_id(run_stamp, name):
    return f"KT-{run_stamp}-{name}"


def run_all_checks(context, run_stamp=None):
    """Run every check. One check failing never stops the others."""
    stamp = run_stamp or context.now.strftime("%Y%m%dT%H%M%SZ")
    results = {}
    for name, check in CHECKS:
        try:
            result = check(context)
        except Exception as exc:  # noqa: BLE001 — a crash is a verdict, not an escape
            result = {"test": name, "status": "ERROR", "error": str(exc)[:300]}
        result["evidence_id"] = evidence_id(stamp, name)
        results[name] = result
    return results


def overall_status(results):
    if any(r.get("status") in FAILING_STATUSES for r in results.values()):
        return "FAIL"
    if any(r.get("status") == "WARN" for r in results.values()):
        return "WARN"
    return "pass"


REPORT_COUNTS = (
    ("not_ingested_count", "posted to Slack, never ingested"),
    ("not_booked_count", "ingested, never booked"),
    ("awaiting_human_count", "waiting on a human"),
    ("unbooked_count", "confirmed paid, not booked"),
    ("duplicates_found", "possible duplicates"),
    ("orphans_found", "unattributed"),
    ("issues_found", "attribution issues"),
    ("uncategorized_count", "uncategorized"),
    ("unexpected_splits", "unexpected splits"),
)


def format_report(results, run_stamp, overall):
    lines = [
        f"{ICONS[overall]} *Kapital accounting — weekly integrity control* (`{run_stamp}`)"
    ]
    for name, result in results.items():
        status = result.get("status", "?")
        label = str(result.get("test", name)).replace("_", " ").title()
        lines.append(
            f"{ICONS.get(status, '•')} *{label}*: {status}  `{result.get('evidence_id', '')}`"
        )
        if status == "ERROR":
            lines.append(f"   • error: {result.get('error', 'unknown')}")
            continue
        for field, caption in REPORT_COUNTS:
            if result.get(field):
                lines.append(f"   • {result[field]} {caption}")
        if result.get("action"):
            lines.append(f"   _→ {result['action']}_")
    return "\n".join(lines)


def post_to_slack(message, *, account, channel, runner=subprocess.run):
    binary = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
    completed = runner(
        [binary, "message", "send", "--channel", "slack", "--account", account,
         "--target", f"channel:{channel}", "--message", message, "--json"],
        capture_output=True, text=True, timeout=60,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"slack post exited {completed.returncode}: "
            f"{(completed.stderr or completed.stdout or '').strip()[:200]}"
        )


def write_run_record(results, run_stamp, overall, path):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(
            {"run": run_stamp, "overall": overall, "checks": results},
            indent=2, sort_keys=True, default=str,
        ) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, target)
    return target


def main(argv=None):
    argv = list(argv if argv is not None else sys.argv[1:])
    months_back = int(argv[0]) if argv else DEFAULT_MONTHS_BACK

    from job_health import record
    from runtime_paths import runtime_state_path

    run_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slack_account = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
    channel = os.environ.get("RESORT_ACCOUNTING_CHANNEL", "")

    context = Context(
        QBOClient(), load_config(),
        slack_account=slack_account,
        months_back=months_back,
    )
    results = run_all_checks(context, run_stamp)
    overall = overall_status(results)
    report = format_report(results, run_stamp, overall)
    record_path = write_run_record(
        results, run_stamp, overall, runtime_state_path("kapital-tests-last-run.json")
    )

    print(report)
    print(f"\nrun record: {record_path}")

    posted, post_error = True, None
    if slack_account and channel:
        try:
            post_to_slack(report, account=slack_account, channel=channel)
        except Exception as exc:  # noqa: BLE001
            posted, post_error = False, str(exc)[:200]
    else:
        posted, post_error = False, "OPENCLAW_SLACK_ACCOUNT/RESORT_ACCOUNTING_CHANNEL not set"

    failed = [n for n, r in results.items() if r.get("status") in FAILING_STATUSES]
    warned = [n for n, r in results.items() if r.get("status") == "WARN"]
    detail = f"{overall}; run {run_stamp}"
    if failed:
        detail += f"; failing: {','.join(failed)}"
    if warned:
        detail += f"; warn: {','.join(warned)}"
    if not posted:
        detail += f"; slack post failed: {post_error}"

    healthy = not failed and posted
    record(JOB_NAME, healthy, detail[:300])
    if not healthy:
        print(f"\nkapital-tests: {detail}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        try:
            from job_health import record
            record(JOB_NAME, False, str(exc)[:300])
        except Exception:  # noqa: BLE001
            pass
        print(f"kapital-tests: {exc}", file=sys.stderr)
        sys.exit(1)
