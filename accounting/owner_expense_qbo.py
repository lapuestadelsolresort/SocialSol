#!/usr/bin/env python3
"""Post an owner-paid expense or owner repayment to the configured QBO ledger."""

import argparse
import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from typing import Dict, Optional, Tuple

sys.path.insert(0, str(Path(__file__).parent))

from fx_rates import get_usd_rate  # noqa: E402
from qbo_push import QBOClient  # noqa: E402


OWNER_PAID_EXPENSE = 'owner_paid_expense'
OWNER_REPAYMENT = 'owner_repayment'


def request_id_for_receipt(
    receipt_id: str,
    transaction_kind: str = OWNER_PAID_EXPENSE,
) -> str:
    """Return a stable, non-PII QBO request id for one receipt."""
    namespace = 'owner-expense' if transaction_kind == OWNER_PAID_EXPENSE else 'owner-repayment'
    digest = hashlib.sha256(f"socialsol|{namespace}|{receipt_id}".encode()).hexdigest()[:36]
    prefix = 'ss-oe' if transaction_kind == OWNER_PAID_EXPENSE else 'ss-or'
    return f"{prefix}-{digest}"[:50]


def amount_in_home_currency(amount: float, currency: str, txn_date: date) -> Tuple[float, Optional[float]]:
    if amount <= 0:
        raise ValueError('amount must be positive')
    if currency == 'USD':
        return round(amount, 2), None
    if currency != 'MXN':
        raise ValueError('currency must be MXN or USD')
    rate = float(get_usd_rate(txn_date))
    if rate <= 0:
        raise ValueError('MXN/USD exchange rate must be positive')
    return round(amount / rate, 2), rate


def validate_account(
    account: Dict,
    *,
    expected_id: str,
    expected_name: Optional[str] = None,
    expected_type: Optional[str] = None,
) -> Dict:
    if str(account.get('Id')) != str(expected_id):
        raise ValueError(f"QBO account readback mismatch for {expected_id}")
    if account.get('Active') is False:
        raise ValueError(f"QBO account {expected_id} is inactive")
    if expected_name and str(account.get('Name')) != expected_name:
        raise ValueError(
            f"QBO account {expected_id} name mismatch: {account.get('Name')!r}"
        )
    if expected_type and str(account.get('AccountType')) != expected_type:
        raise ValueError(
            f"QBO account {expected_id} must be {expected_type}; found {account.get('AccountType')!r}"
        )
    return account


def build_journal_entry(
    *,
    receipt_id: str,
    txn_date: date,
    amount: float,
    currency: str,
    amount_usd: float,
    fx_rate: Optional[float],
    expense_account_id: str,
    liability_account_id: str,
    owner_name: str,
    vendor: str,
    description: str,
) -> Dict:
    original = f"{amount:,.2f} {currency}"
    memo_parts = [
        f"SocialSol owner expense receipt {receipt_id}",
        f"Paid personally by {owner_name}",
        f"Vendor: {vendor or 'Unknown'}",
        description or 'Owner-paid business expense',
        f"Original: {original}",
    ]
    if fx_rate is not None:
        memo_parts.append(f"FX: {fx_rate} MXN/USD")
    memo = ' | '.join(memo_parts)[:4000]
    return {
        'TxnDate': txn_date.isoformat(),
        'CurrencyRef': {'value': 'USD'},
        'PrivateNote': memo,
        'Line': [
            {
                'Id': '1',
                'Amount': round(amount_usd, 2),
                'Description': memo,
                'DetailType': 'JournalEntryLineDetail',
                'JournalEntryLineDetail': {
                    'PostingType': 'Debit',
                    'AccountRef': {'value': str(expense_account_id)},
                },
            },
            {
                'Id': '2',
                'Amount': round(amount_usd, 2),
                'Description': memo,
                'DetailType': 'JournalEntryLineDetail',
                'JournalEntryLineDetail': {
                    'PostingType': 'Credit',
                    'AccountRef': {'value': str(liability_account_id)},
                },
            },
        ],
    }


def build_repayment_purchase(
    *,
    receipt_id: str,
    txn_date: date,
    amount: float,
    currency: str,
    amount_usd: float,
    fx_rate: Optional[float],
    liability_account_id: str,
    bank_account_id: str,
    owner_name: str,
    vendor: str,
    description: str,
) -> Dict:
    """Build a cash Purchase that debits owner liability and credits the bank."""
    original = f"{amount:,.2f} {currency}"
    memo_parts = [
        f"SocialSol owner repayment receipt {receipt_id}",
        f"Reduces amount due to {owner_name}",
        f"Paid to: {vendor or owner_name}",
        description or 'Owner repayment',
        f"Original: {original}",
    ]
    if fx_rate is not None:
        memo_parts.append(f"FX: {fx_rate} MXN/USD")
    memo = ' | '.join(memo_parts)[:4000]
    return {
        'PaymentType': 'Cash',
        'AccountRef': {'value': str(bank_account_id)},
        'TxnDate': txn_date.isoformat(),
        'CurrencyRef': {'value': 'USD'},
        'TotalAmt': round(amount_usd, 2),
        'PrivateNote': memo,
        'Line': [{
            'Amount': round(amount_usd, 2),
            'Description': memo,
            'DetailType': 'AccountBasedExpenseLineDetail',
            'AccountBasedExpenseLineDetail': {
                'AccountRef': {'value': str(liability_account_id)},
            },
        }],
    }


def line_signature(entry: Dict) -> set:
    output = set()
    for line in entry.get('Line', []):
        detail = line.get('JournalEntryLineDetail') or {}
        account_id = str((detail.get('AccountRef') or {}).get('value') or '')
        output.add((detail.get('PostingType'), account_id, round(float(line.get('Amount') or 0), 2)))
    return output


def verify_journal_entry(
    entry: Dict,
    *,
    qbo_id: str,
    receipt_id: str,
    txn_date: date,
    amount_usd: float,
    expense_account_id: str,
    liability_account_id: str,
) -> Dict:
    if str(entry.get('Id')) != str(qbo_id):
        raise ValueError('QBO JournalEntry id readback mismatch')
    if str(entry.get('TxnDate')) != txn_date.isoformat():
        raise ValueError('QBO JournalEntry date readback mismatch')
    expected = {
        ('Debit', str(expense_account_id), round(amount_usd, 2)),
        ('Credit', str(liability_account_id), round(amount_usd, 2)),
    }
    if not expected.issubset(line_signature(entry)):
        raise ValueError('QBO JournalEntry account/amount readback mismatch')
    if f"SocialSol owner expense receipt {receipt_id}" not in str(entry.get('PrivateNote') or ''):
        raise ValueError('QBO JournalEntry receipt marker readback mismatch')
    return {
        'verified_by_readback': True,
        'qbo_id': str(qbo_id),
        'qbo_entity_type': 'JournalEntry',
        'amount_usd': round(amount_usd, 2),
        'expense_account_id': str(expense_account_id),
        'liability_account_id': str(liability_account_id),
    }


def verify_repayment_purchase(
    purchase: Dict,
    *,
    qbo_id: str,
    receipt_id: str,
    txn_date: date,
    amount_usd: float,
    liability_account_id: str,
    bank_account_id: str,
) -> Dict:
    if str(purchase.get('Id')) != str(qbo_id):
        raise ValueError('QBO Purchase id readback mismatch')
    if str(purchase.get('TxnDate')) != txn_date.isoformat():
        raise ValueError('QBO Purchase date readback mismatch')
    if str((purchase.get('AccountRef') or {}).get('value')) != str(bank_account_id):
        raise ValueError('QBO Purchase bank account readback mismatch')
    if round(float(purchase.get('TotalAmt') or 0), 2) != round(amount_usd, 2):
        raise ValueError('QBO Purchase amount readback mismatch')
    lines = []
    for line in purchase.get('Line', []):
        detail = line.get('AccountBasedExpenseLineDetail') or {}
        account_id = str((detail.get('AccountRef') or {}).get('value') or '')
        lines.append((account_id, round(float(line.get('Amount') or 0), 2)))
    if (str(liability_account_id), round(amount_usd, 2)) not in lines:
        raise ValueError('QBO Purchase liability line readback mismatch')
    if f"SocialSol owner repayment receipt {receipt_id}" not in str(purchase.get('PrivateNote') or ''):
        raise ValueError('QBO Purchase receipt marker readback mismatch')
    return {
        'verified_by_readback': True,
        'qbo_id': str(qbo_id),
        'qbo_entity_type': 'Purchase',
        'amount_usd': round(amount_usd, 2),
        'liability_account_id': str(liability_account_id),
        'bank_account_id': str(bank_account_id),
    }


def matching_repayment_purchases(
    client: QBOClient,
    *,
    txn_date: date,
    amount_usd: float,
    bank_account_id: str,
) -> list:
    """Find exact bank/date/home-currency candidates before creating a repayment."""
    response = client.query(
        f"SELECT * FROM Purchase WHERE TxnDate = '{txn_date.isoformat()}' MAXRESULTS 1000"
    )
    purchases = response.get('QueryResponse', {}).get('Purchase', [])
    return [
        item for item in purchases
        if str((item.get('AccountRef') or {}).get('value')) == str(bank_account_id)
        and abs(float(item.get('TotalAmt') or 0) - amount_usd) < 0.01
    ]


def verify_accounts(
    client: QBOClient,
    *,
    liability_account_id: str,
    liability_account_name: str,
    expense_account_id: Optional[str] = None,
    bank_account_id: Optional[str] = None,
    bank_account_name: Optional[str] = None,
) -> Dict:
    liability = validate_account(
        client.read_account(liability_account_id),
        expected_id=liability_account_id,
        expected_name=liability_account_name,
        expected_type='Other Current Liability',
    )
    expense = None
    if expense_account_id:
        expense = validate_account(
            client.read_account(expense_account_id),
            expected_id=expense_account_id,
        )
        if str(expense.get('AccountType')) not in {'Expense', 'Other Expense', 'Cost of Goods Sold'}:
            raise ValueError(
                f"QBO debit account {expense_account_id} is not an expense account"
            )
    bank = None
    if bank_account_id:
        bank = validate_account(
            client.read_account(bank_account_id),
            expected_id=bank_account_id,
            expected_name=bank_account_name,
            expected_type='Bank',
        )
    return {
        'liability': {
            'id': str(liability.get('Id')),
            'name': liability.get('Name'),
            'account_type': liability.get('AccountType'),
            'active': liability.get('Active', True),
        },
        'expense': None if expense is None else {
            'id': str(expense.get('Id')),
            'name': expense.get('Name'),
            'account_type': expense.get('AccountType'),
            'active': expense.get('Active', True),
        },
        'bank': None if bank is None else {
            'id': str(bank.get('Id')),
            'name': bank.get('Name'),
            'account_type': bank.get('AccountType'),
            'active': bank.get('Active', True),
        },
    }


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--receipt-id')
    cli.add_argument('--date')
    cli.add_argument('--amount', type=float)
    cli.add_argument('--currency', choices=['MXN', 'USD'])
    cli.add_argument('--expense-account-id')
    cli.add_argument('--transaction-kind', choices=[OWNER_PAID_EXPENSE, OWNER_REPAYMENT], default=OWNER_PAID_EXPENSE)
    cli.add_argument('--liability-account-id', required=True)
    cli.add_argument('--liability-account-name', required=True)
    cli.add_argument('--bank-account-id')
    cli.add_argument('--bank-account-name')
    cli.add_argument('--owner-name')
    cli.add_argument('--vendor', default='')
    cli.add_argument('--description', default='')
    cli.add_argument('--qbo-id')
    cli.add_argument('--expected-amount-usd', type=float)
    cli.add_argument('--expected-fx-rate', type=float)
    cli.add_argument('--verify-only', action='store_true')
    cli.add_argument('--verify-accounts', action='store_true')
    cli.add_argument('--live', action='store_true')
    cli.add_argument('--json', action='store_true')
    return cli


def require(value, name: str):
    if value is None or value == '':
        raise ValueError(f"{name} is required")
    return value


def main(argv=None) -> Dict:
    args = parser().parse_args(argv)
    client = QBOClient()
    if args.verify_accounts:
        accounts = verify_accounts(
            client,
            liability_account_id=args.liability_account_id,
            liability_account_name=args.liability_account_name,
            expense_account_id=args.expense_account_id,
            bank_account_id=args.bank_account_id,
            bank_account_name=args.bank_account_name,
        )
        return {'status': 'VERIFIED', 'accounts': accounts}

    receipt_id = require(args.receipt_id, '--receipt-id')
    txn_date = date.fromisoformat(require(args.date, '--date'))
    amount = float(require(args.amount, '--amount'))
    currency = require(args.currency, '--currency')
    expense_account_id = (
        require(args.expense_account_id, '--expense-account-id')
        if args.transaction_kind == OWNER_PAID_EXPENSE else None
    )
    bank_account_id = (
        require(args.bank_account_id, '--bank-account-id')
        if args.transaction_kind == OWNER_REPAYMENT else None
    )
    if args.transaction_kind == OWNER_REPAYMENT:
        require(args.bank_account_name, '--bank-account-name')
    owner_name = require(args.owner_name, '--owner-name')
    if args.verify_only and args.expected_amount_usd is not None:
        if args.expected_amount_usd <= 0:
            raise ValueError('--expected-amount-usd must be positive')
        amount_usd = round(args.expected_amount_usd, 2)
        fx_rate = args.expected_fx_rate
    else:
        amount_usd, fx_rate = amount_in_home_currency(amount, currency, txn_date)
    request_id = request_id_for_receipt(receipt_id, args.transaction_kind)

    accounts = verify_accounts(
        client,
        liability_account_id=args.liability_account_id,
        liability_account_name=args.liability_account_name,
        expense_account_id=expense_account_id,
        bank_account_id=bank_account_id,
        bank_account_name=args.bank_account_name,
    )
    expected = {
        'qbo_id': args.qbo_id,
        'receipt_id': receipt_id,
        'txn_date': txn_date,
        'amount_usd': amount_usd,
        'liability_account_id': args.liability_account_id,
    }
    if args.verify_only:
        qbo_id = require(args.qbo_id, '--qbo-id')
        if args.transaction_kind == OWNER_PAID_EXPENSE:
            verified = verify_journal_entry(
                client.read_entity('journalentry', qbo_id),
                expense_account_id=expense_account_id,
                **expected,
            )
        else:
            verified = verify_repayment_purchase(
                client.read_entity('purchase', qbo_id),
                bank_account_id=bank_account_id,
                **expected,
            )
        return {
            'status': 'VERIFIED',
            'request_id': request_id,
            'fx_rate': fx_rate,
            'accounts': accounts,
            **verified,
        }

    common = {
        'receipt_id': receipt_id,
        'txn_date': txn_date,
        'amount': amount,
        'currency': currency,
        'amount_usd': amount_usd,
        'fx_rate': fx_rate,
        'liability_account_id': args.liability_account_id,
        'owner_name': owner_name,
        'vendor': args.vendor,
        'description': args.description,
    }
    if args.transaction_kind == OWNER_PAID_EXPENSE:
        transaction = build_journal_entry(expense_account_id=expense_account_id, **common)
        entity_type = 'JournalEntry'
    else:
        transaction = build_repayment_purchase(bank_account_id=bank_account_id, **common)
        entity_type = 'Purchase'
    if not args.live:
        return {
            'status': 'DRY_RUN',
            'request_id': request_id,
            'amount_usd': amount_usd,
            'fx_rate': fx_rate,
            'accounts': accounts,
            'qbo_entity_type': entity_type,
            'transaction': transaction,
        }
    if args.transaction_kind == OWNER_PAID_EXPENSE:
        created = client.create_journal_entry(transaction, request_id=request_id)
        qbo_id = require(created.get('Id'), 'QBO JournalEntry Id')
        verified = verify_journal_entry(
            client.read_entity('journalentry', qbo_id), qbo_id=qbo_id,
            expense_account_id=expense_account_id,
            **{key: value for key, value in expected.items() if key != 'qbo_id'},
        )
    else:
        candidates = matching_repayment_purchases(
            client, txn_date=txn_date, amount_usd=amount_usd,
            bank_account_id=bank_account_id,
        )
        marker = f"SocialSol owner repayment receipt {receipt_id}"
        exact = [item for item in candidates if marker in str(item.get('PrivateNote') or '')]
        if len(exact) == 1:
            qbo_id = require(exact[0].get('Id'), 'QBO Purchase Id')
            verified = verify_repayment_purchase(
                exact[0], qbo_id=qbo_id, bank_account_id=bank_account_id,
                **{key: value for key, value in expected.items() if key != 'qbo_id'},
            )
        elif candidates:
            ids = ', '.join(str(item.get('Id')) for item in candidates[:5])
            raise ValueError(f'possible duplicate QBO Purchase already exists: {ids}')
        else:
            created = client.create_purchase_payload(transaction, request_id=request_id)
            qbo_id = require(created.get('Id'), 'QBO Purchase Id')
            verified = verify_repayment_purchase(
                client.read_entity('purchase', qbo_id), qbo_id=qbo_id,
                bank_account_id=bank_account_id,
                **{key: value for key, value in expected.items() if key != 'qbo_id'},
            )
    return {
        'status': 'PUSHED',
        'request_id': request_id,
        'fx_rate': fx_rate,
        'accounts': accounts,
        **verified,
    }


if __name__ == '__main__':
    try:
        result = main()
        print(json.dumps(result, default=str))
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'error': str(error)}))
        sys.exit(1)
