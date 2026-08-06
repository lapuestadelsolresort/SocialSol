#!/usr/bin/env python3
"""
Kapital Accounting Integration Tests

Runs 7 audit checks against QBO + Slack receipt channels to ensure
the accounting infrastructure is solid. Designed to run periodically
(weekly or on-demand).

Tests:
  1. Receipt channel coverage — unmatched Slack receipts vs QBO
  2. Duplicate detection — same date+amount+vendor in QBO
  3. Orphaned group activities — no client/booking attribution
  4. Orphaned food expenses — no client/booking attribution
  5. Salary month attribution — double salary in same month
  6. Mayela ✅ reconciliation — confirmed payments without QBO match
  7. Uncategorized/split expenses — missing categories or multi-line splits
"""

import json
import re
import sys
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from collections import defaultdict


# ---------------------------------------------------------------------------
# QBO helpers
# ---------------------------------------------------------------------------

def _qbo_auth() -> Tuple[str, str]:
    """Return (access_token, base_url) after refreshing if needed."""
    secrets_path = Path(__file__).parent.parent / 'secrets' / 'quickbooks.json'
    with open(secrets_path) as f:
        data = json.load(f)

    realm = data['realm_id']
    token = data['tokens']['access_token']
    base = f"https://quickbooks.api.intuit.com/v3/company/{realm}"

    # Quick check if token works
    try:
        _qbo_get(base, token, "query?query=SELECT%20count(*)%20FROM%20Purchase%20MAXRESULTS%201&minorversion=75")
        return token, base
    except Exception:
        pass

    # Refresh
    client_id = data['production']['client_id']
    client_secret = data['production']['client_secret']
    refresh = data['tokens']['refresh_token']

    body = (
        f"grant_type=refresh_token"
        f"&refresh_token={refresh}"
        f"&client_id={client_id}"
        f"&client_secret={client_secret}"
    ).encode()
    req = urllib.request.Request(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode())

    new_access = result['access_token']
    new_refresh = result.get('refresh_token', refresh)
    data['tokens']['access_token'] = new_access
    data['tokens']['refresh_token'] = new_refresh
    with open(secrets_path, 'w') as f:
        json.dump(data, f, indent=2)
    import os
    os.chmod(str(secrets_path), 0o600)

    return new_access, base


def _qbo_get(base: str, token: str, endpoint: str) -> dict:
    url = f"{base}/{endpoint}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _qbo_query(token: str, base: str, sql: str) -> list:
    """Run a QBO query and return all result rows."""
    import urllib.parse
    encoded = urllib.parse.quote(sql)
    result = _qbo_get(base, token, f"query?query={encoded}&minorversion=75")
    qr = result.get('QueryResponse', {})
    # QBO returns entity name as key (Purchase, Deposit, etc)
    for key in ('Purchase', 'Deposit', 'Transfer', 'Account', 'Vendor'):
        if key in qr:
            return qr[key]
    return []


# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------

def _load_config() -> dict:
    config_path = Path(__file__).parent / 'config.json'
    with open(config_path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Test 1: Receipt Channel Coverage
# ---------------------------------------------------------------------------

def test_receipt_channel_coverage(token: str, base: str, months_back: int = 2) -> dict:
    """
    Check if there are receipt channel messages with amounts that
    don't correspond to any QBO expense in the same date range.

    NOTE: This is a structural test — it can't read Slack directly.
    It returns the test definition + instructions for the orchestrator
    (Sol) to run via Slack message reads.
    """
    config = _load_config()
    channels = config.get('receipt_channels', {})

    # Get date range
    today = date.today()
    start = today.replace(day=1) - timedelta(days=months_back * 31)
    start = start.replace(day=1)

    # Get all QBO purchases in range
    sql = (
        f"SELECT Id, TxnDate, TotalAmt, EntityRef, PrivateNote "
        f"FROM Purchase "
        f"WHERE TxnDate >= '{start.isoformat()}' "
        f"AND TxnDate <= '{today.isoformat()}' "
        f"ORDERBY TxnDate"
    )
    purchases = _qbo_query(token, base, sql)

    return {
        'test': 'receipt_channel_coverage',
        'status': 'needs_slack_scan',
        'channels_to_scan': list(channels.keys()),
        'channel_names': {cid: ch['name'] for cid, ch in channels.items()},
        'date_range': f"{start.isoformat()} to {today.isoformat()}",
        'qbo_purchases_in_range': len(purchases),
        'instructions': (
            'Orchestrator: read each receipt channel for messages in the date range. '
            'Extract amounts from messages/attachments. Cross-reference with QBO purchases '
            'by date (±3 days) and amount (±5%). Flag unmatched receipts.'
        ),
    }


# ---------------------------------------------------------------------------
# Test 2: Duplicate Detection
# ---------------------------------------------------------------------------

def test_duplicates(token: str, base: str, months_back: int = 3) -> dict:
    """
    Find potential duplicate QBO entries: same date + amount + vendor.
    These happen when overlapping CSVs are uploaded.
    """
    today = date.today()
    start = today.replace(day=1) - timedelta(days=months_back * 31)
    start = start.replace(day=1)

    sql = (
        f"SELECT Id, TxnDate, TotalAmt, EntityRef, PrivateNote "
        f"FROM Purchase "
        f"WHERE TxnDate >= '{start.isoformat()}' "
        f"AND TxnDate <= '{today.isoformat()}' "
        f"ORDERBY TxnDate"
    )
    purchases = _qbo_query(token, base, sql)

    # Group by (date, amount, vendor_id)
    groups = defaultdict(list)
    for p in purchases:
        vendor_id = p.get('EntityRef', {}).get('value', 'none')
        key = (p['TxnDate'], str(p['TotalAmt']), vendor_id)
        groups[key].append(p)

    duplicates = []
    for key, items in groups.items():
        if len(items) > 1:
            # Check if they have different references (legit same-day same-amount)
            notes = [i.get('PrivateNote', '') for i in items]
            # Extract Kapital reference (Clave) from memo to distinguish
            refs = set()
            for note in notes:
                ref_match = re.search(r'Clave:\s*([\d\-/]+)', note)
                if ref_match:
                    refs.add(ref_match.group(1))

            if len(refs) < len(items):
                # Possible true duplicates (same or missing refs)
                duplicates.append({
                    'date': key[0],
                    'amount': float(key[1]),
                    'vendor': items[0].get('EntityRef', {}).get('name', 'N/A'),
                    'count': len(items),
                    'ids': [i['Id'] for i in items],
                    'refs_found': list(refs),
                    'likely_duplicate': len(refs) == 0 or len(refs) < len(items),
                })

    return {
        'test': 'duplicate_detection',
        'status': 'pass' if not duplicates else 'FAIL',
        'total_purchases_scanned': len(purchases),
        'date_range': f"{start.isoformat()} to {today.isoformat()}",
        'duplicates_found': len(duplicates),
        'duplicates': duplicates[:20],  # Cap output
    }


# ---------------------------------------------------------------------------
# Test 3: Orphaned Group Activities
# ---------------------------------------------------------------------------

def test_orphaned_group_activities(token: str, base: str) -> dict:
    """
    Find Group Activities expenses that don't mention a client/group
    name in the memo. They should always be attributed.
    """
    config = _load_config()
    group_account_id = config['qbo_accounts']['expenses']['group_activities']['id']

    sql = (
        f"SELECT Id, TxnDate, TotalAmt, PrivateNote, Line "
        f"FROM Purchase "
        f"ORDERBY TxnDate DESC "
        f"MAXRESULTS 200"
    )
    purchases = _qbo_query(token, base, sql)

    orphans = []
    for p in purchases:
        # Check if any line hits the group activities account
        is_group = False
        for line in p.get('Line', []):
            detail = line.get('AccountBasedExpenseLineDetail', {})
            acct = detail.get('AccountRef', {}).get('value', '')
            if acct == group_account_id:
                is_group = True
                break

        if not is_group:
            continue

        # Check if memo mentions a client/group/booking
        note = (p.get('PrivateNote') or '').lower()
        has_attribution = any(kw in note for kw in [
            'guest', 'group', 'booking', 'client', 'wedding',
            'retreat', 'villa', 'reservation', 'airbnb', 'ownerrez',
        ])

        if not has_attribution:
            orphans.append({
                'id': p['Id'],
                'date': p['TxnDate'],
                'amount': p['TotalAmt'],
                'note': (p.get('PrivateNote') or '')[:120],
            })

    return {
        'test': 'orphaned_group_activities',
        'status': 'pass' if not orphans else 'WARN',
        'orphans_found': len(orphans),
        'orphans': orphans[:20],
        'action': 'Ping Mayela to attribute these to a specific group/booking' if orphans else None,
    }


# ---------------------------------------------------------------------------
# Test 4: Orphaned Food Expenses
# ---------------------------------------------------------------------------

def test_orphaned_food_expenses(token: str, base: str) -> dict:
    """
    Find food-related expenses (Supplies & Materials Group, or memos
    mentioning food/groceries) that aren't attributed to a client.
    """
    config = _load_config()
    group_supplies_id = config['qbo_accounts']['expenses']['supplies_group']['id']

    sql = (
        f"SELECT Id, TxnDate, TotalAmt, PrivateNote, Line "
        f"FROM Purchase "
        f"ORDERBY TxnDate DESC "
        f"MAXRESULTS 200"
    )
    purchases = _qbo_query(token, base, sql)

    orphans = []
    food_keywords = ['food', 'comida', 'groceries', 'grocery', 'refrigerator',
                     'fridge', 'kitchen', 'cook', 'chef', 'aliment', 'meat',
                     'carne', 'pollo', 'fruit', 'fruta', 'costco food']

    for p in purchases:
        note = (p.get('PrivateNote') or '').lower()

        # Check if it's food-related by memo content
        is_food = any(kw in note for kw in food_keywords)

        # Or if it hits the Supplies & Materials (Group) account
        for line in p.get('Line', []):
            detail = line.get('AccountBasedExpenseLineDetail', {})
            acct = detail.get('AccountRef', {}).get('value', '')
            if acct == group_supplies_id:
                is_food = True
                break

        if not is_food:
            continue

        # Check attribution
        has_attribution = any(kw in note for kw in [
            'guest', 'group', 'booking', 'client', 'villa',
            'reservation', 'airbnb', 'ownerrez',
        ])

        if not has_attribution:
            orphans.append({
                'id': p['Id'],
                'date': p['TxnDate'],
                'amount': p['TotalAmt'],
                'note': note[:120],
            })

    return {
        'test': 'orphaned_food_expenses',
        'status': 'pass' if not orphans else 'WARN',
        'orphans_found': len(orphans),
        'orphans': orphans[:20],
        'action': 'Ping Mayela/Daniel to attribute to specific guests' if orphans else None,
    }


# ---------------------------------------------------------------------------
# Test 5: Salary Month Attribution
# ---------------------------------------------------------------------------

def test_salary_month_attribution(token: str, base: str) -> dict:
    """
    Detect when 2 salary payments to the same person land in the same
    calendar month. The memo should indicate which month each covers
    (e.g., "July salary" vs "June salary"), and if both are booked
    in July, one should be re-attributed.
    """
    config = _load_config()
    labor_id = config['qbo_accounts']['expenses']['contract_labor']['id']

    # Known salary workers and their expected amounts (USD approx)
    salary_workers = {
        'Daniel Business': {'expected_monthly_mxn': 25000, 'frequency': 'monthly'},
        'Mayela Gomez': {'expected_monthly_mxn': 30000, 'frequency': 'monthly'},
        'Sergio Gracia': {'expected_weekly_mxn': 8000, 'frequency': 'weekly'},
    }

    sql = (
        f"SELECT Id, TxnDate, TotalAmt, EntityRef, PrivateNote "
        f"FROM Purchase "
        f"ORDERBY TxnDate DESC "
        f"MAXRESULTS 500"
    )
    purchases = _qbo_query(token, base, sql)

    issues = []

    # Group salary payments by (vendor, year-month)
    salary_by_month = defaultdict(list)
    for p in purchases:
        vendor_name = p.get('EntityRef', {}).get('name', '')
        if vendor_name not in salary_workers:
            continue

        # Check if it's a salary payment (not cleaning, petty cash, etc.)
        note = (p.get('PrivateNote') or '').lower()
        is_salary = any(kw in note for kw in ['salary', 'monthly', 'weekly payment'])

        if not is_salary:
            continue

        txn_date = p['TxnDate']  # YYYY-MM-DD
        month_key = txn_date[:7]  # YYYY-MM
        salary_by_month[(vendor_name, month_key)].append(p)

    # Check for monthly workers with > 1 salary in same month
    for (vendor, month), payments in salary_by_month.items():
        worker_info = salary_workers.get(vendor, {})

        if worker_info.get('frequency') == 'monthly' and len(payments) > 1:
            # Two monthly salaries in same calendar month — flag
            notes = [(p.get('PrivateNote') or '')[:100] for p in payments]
            issues.append({
                'vendor': vendor,
                'month': month,
                'payment_count': len(payments),
                'amounts': [p['TotalAmt'] for p in payments],
                'dates': [p['TxnDate'] for p in payments],
                'ids': [p['Id'] for p in payments],
                'notes': notes,
                'issue': f'{vendor} has {len(payments)} monthly salary payments in {month}. '
                         f'Check if one covers a prior month.',
            })

        if worker_info.get('frequency') == 'weekly' and len(payments) > 5:
            # More than 5 weekly payments in one month — unusual
            issues.append({
                'vendor': vendor,
                'month': month,
                'payment_count': len(payments),
                'amounts': [p['TotalAmt'] for p in payments],
                'dates': [p['TxnDate'] for p in payments],
                'ids': [p['Id'] for p in payments],
                'issue': f'{vendor} has {len(payments)} weekly payments in {month} (expected 4-5).',
            })

    return {
        'test': 'salary_month_attribution',
        'status': 'pass' if not issues else 'WARN',
        'issues_found': len(issues),
        'issues': issues,
        'action': 'Re-attribute the earlier payment to the prior month if memos confirm' if issues else None,
    }


# ---------------------------------------------------------------------------
# Test 6: Mayela ✅ Reconciliation
# ---------------------------------------------------------------------------

def test_mayela_checkmark_reconciliation(token: str, base: str) -> dict:
    """
    Structural test: check if ✅ reactions in Mayela's receipt channel
    correspond to QBO expenses.

    Returns instructions for the orchestrator (Sol) since we can't
    read Slack reactions directly from Python.
    """
    config = _load_config()
    mayela_channels = []
    for cid, ch in config.get('receipt_channels', {}).items():
        if 'U06AWTZH1V1' in ch.get('people', []) or 'mayela' in ch.get('scope', ''):
            mayela_channels.append({'id': cid, 'name': ch['name']})

    return {
        'test': 'mayela_checkmark_reconciliation',
        'status': 'needs_slack_scan',
        'channels_to_scan': mayela_channels,
        'instructions': (
            'Orchestrator: read each Mayela receipt channel. Find messages with '
            ':white_check_mark: reactions. For each, extract the payment amount and date. '
            'Query QBO for a matching Purchase (±3 days, ±5% amount, vendor=Mayela Gomez). '
            'Flag any ✅ messages WITHOUT a QBO match — these are confirmed-paid but not yet booked. '
            'Also flag any ✅ messages that DO match but the QBO record has a different category.'
        ),
    }


# ---------------------------------------------------------------------------
# Test 7: Uncategorized / Split Expenses
# ---------------------------------------------------------------------------

def test_uncategorized_expenses(token: str, base: str) -> dict:
    """
    Find QBO expenses that:
    a) Hit the 'Uncategorized Expense' account
    b) Have multiple line items (show as 'Split' in QBO UI)
    c) Have no vendor assigned
    """
    config = _load_config()
    uncategorized_id = '2'  # QBO default Uncategorized Expense

    sql = (
        f"SELECT Id, TxnDate, TotalAmt, EntityRef, PrivateNote, Line "
        f"FROM Purchase "
        f"ORDERBY TxnDate DESC "
        f"MAXRESULTS 500"
    )
    purchases = _qbo_query(token, base, sql)

    uncategorized = []
    splits = []
    no_vendor = []

    for p in purchases:
        lines = p.get('Line', [])
        note = (p.get('PrivateNote') or '')
        vendor = p.get('EntityRef', {}).get('name')

        # Check for uncategorized
        for line in lines:
            detail = line.get('AccountBasedExpenseLineDetail', {})
            acct = detail.get('AccountRef', {}).get('value', '')
            if acct == uncategorized_id:
                uncategorized.append({
                    'id': p['Id'],
                    'date': p['TxnDate'],
                    'amount': p['TotalAmt'],
                    'vendor': vendor,
                    'note': note[:100],
                })
                break

        # Check for splits (>1 expense line — SPEI fees create these)
        expense_lines = [l for l in lines if l.get('DetailType') == 'AccountBasedExpenseLineDetail']
        if len(expense_lines) > 1:
            # Check if split is just SPEI fees (expected) vs real split (unexpected)
            accounts_used = set()
            for line in expense_lines:
                detail = line.get('AccountBasedExpenseLineDetail', {})
                acct_name = detail.get('AccountRef', {}).get('name', '')
                accounts_used.add(acct_name)

            is_spei_split = 'Bank Fee' in accounts_used and len(accounts_used) == 2
            if not is_spei_split:
                splits.append({
                    'id': p['Id'],
                    'date': p['TxnDate'],
                    'amount': p['TotalAmt'],
                    'vendor': vendor,
                    'line_count': len(expense_lines),
                    'accounts': list(accounts_used),
                    'note': note[:100],
                })

        # Check for no vendor (on Kapital records only)
        if not vendor and 'MXN' in note and p['TotalAmt'] > 1.0:
            uncategorized.append({
                'id': p['Id'],
                'date': p['TxnDate'],
                'amount': p['TotalAmt'],
                'note': note[:100],
                'issue': 'No vendor assigned',
            })

    return {
        'test': 'uncategorized_expenses',
        'status': 'pass' if not (uncategorized or splits) else 'WARN',
        'uncategorized_count': len(uncategorized),
        'unexpected_splits': len(splits),
        'uncategorized': uncategorized[:20],
        'splits': splits[:20],
    }


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_all_tests(months_back: int = 3) -> dict:
    """Run all tests and return combined results."""
    print("🔐 Authenticating with QBO...")
    token, base = _qbo_auth()

    results = {}

    tests = [
        ('receipt_coverage', lambda: test_receipt_channel_coverage(token, base, months_back)),
        ('duplicates', lambda: test_duplicates(token, base, months_back)),
        ('orphaned_group_activities', lambda: test_orphaned_group_activities(token, base)),
        ('orphaned_food_expenses', lambda: test_orphaned_food_expenses(token, base)),
        ('salary_month_attribution', lambda: test_salary_month_attribution(token, base)),
        ('mayela_checkmark', lambda: test_mayela_checkmark_reconciliation(token, base)),
        ('uncategorized', lambda: test_uncategorized_expenses(token, base)),
    ]

    for name, test_fn in tests:
        print(f"\n🧪 Running: {name}...")
        try:
            result = test_fn()
            results[name] = result
            status = result.get('status', '?')
            icon = '✅' if status == 'pass' else '⚠️' if status in ('WARN', 'needs_slack_scan') else '❌'
            print(f"   {icon} {status}")
            if result.get('duplicates_found'):
                print(f"   Found {result['duplicates_found']} potential duplicates")
            if result.get('orphans_found'):
                print(f"   Found {result['orphans_found']} orphaned records")
            if result.get('issues_found'):
                print(f"   Found {result['issues_found']} salary attribution issues")
            if result.get('uncategorized_count'):
                print(f"   Found {result['uncategorized_count']} uncategorized records")
        except Exception as e:
            results[name] = {'test': name, 'status': 'ERROR', 'error': str(e)}
            print(f"   ❌ ERROR: {e}")

    return results


def format_test_report(results: dict) -> str:
    """Format test results as a Slack-friendly report."""
    lines = ["📋 *Kapital Accounting — Integrity Tests*\n"]

    for name, result in results.items():
        status = result.get('status', '?')
        icon = '✅' if status == 'pass' else '⚠️' if status in ('WARN', 'needs_slack_scan') else '❌'
        test_label = result.get('test', name).replace('_', ' ').title()
        lines.append(f"{icon} *{test_label}*: {status}")

        if status == 'FAIL' or status == 'WARN':
            # Show details
            if result.get('duplicates'):
                for d in result['duplicates'][:5]:
                    lines.append(f"   • {d['date']} — {d['vendor']} ${d['amount']:.2f} x{d['count']} (IDs: {', '.join(d['ids'])})")

            if result.get('orphans'):
                for o in result['orphans'][:5]:
                    lines.append(f"   • {o['date']} — ${o['amount']:.2f}: {o.get('note', '')[:60]}")

            if result.get('issues'):
                for i in result['issues'][:5]:
                    lines.append(f"   • {i['issue']}")

            if result.get('uncategorized'):
                for u in result['uncategorized'][:5]:
                    lines.append(f"   • {u['date']} — ${u['amount']:.2f}: {u.get('note', u.get('issue', ''))[:60]}")

            if result.get('action'):
                lines.append(f"   _→ {result['action']}_")

        if status == 'needs_slack_scan':
            lines.append(f"   _→ Requires Slack channel scan (orchestrator will run)_")

    return '\n'.join(lines)


if __name__ == '__main__':
    months = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    results = run_all_tests(months)
    print("\n" + "=" * 50)
    print(format_test_report(results))
