import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from owner_expense_qbo import (  # noqa: E402
    amount_in_home_currency,
    build_journal_entry,
    build_repayment_purchase,
    matching_repayment_purchases,
    request_id_for_receipt,
    validate_account,
    verify_accounts,
    verify_journal_entry,
    verify_repayment_purchase,
)


class FakeClient:
    def __init__(self, accounts):
        self.accounts = accounts

    def read_account(self, account_id):
        return self.accounts[str(account_id)]


class OwnerExpenseQBOTests(unittest.TestCase):
    def test_request_id_is_stable_non_pii_and_within_qbo_limit(self):
        receipt_id = '4df5fc31-c9f8-4b30-8dcc-0a13482beedd'
        value = request_id_for_receipt(receipt_id)
        self.assertEqual(value, request_id_for_receipt(receipt_id))
        self.assertLessEqual(len(value), 50)
        self.assertNotIn(receipt_id, value)

    def test_mxn_conversion_uses_transaction_date_rate(self):
        with patch('owner_expense_qbo.get_usd_rate', return_value=18.6) as rate:
            amount_usd, fx_rate = amount_in_home_currency(4700, 'MXN', date(2026, 8, 6))
        rate.assert_called_once_with(date(2026, 8, 6))
        self.assertEqual(amount_usd, 252.69)
        self.assertEqual(fx_rate, 18.6)

    def test_balanced_journal_debits_expense_and_credits_liability(self):
        entry = build_journal_entry(
            receipt_id='receipt-1', txn_date=date(2026, 8, 6), amount=4700,
            currency='MXN', amount_usd=252.69, fx_rate=18.6,
            expense_account_id='5100', liability_account_id='2100',
            owner_name='Test Owner', vendor='AC Vendor', description='Compressor work',
        )
        lines = entry['Line']
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]['Amount'], lines[1]['Amount'])
        self.assertEqual(lines[0]['JournalEntryLineDetail'], {
            'PostingType': 'Debit', 'AccountRef': {'value': '5100'},
        })
        self.assertEqual(lines[1]['JournalEntryLineDetail'], {
            'PostingType': 'Credit', 'AccountRef': {'value': '2100'},
        })
        self.assertIn('Paid personally by Test Owner', entry['PrivateNote'])

    def test_readback_requires_exact_accounts_amount_date_and_receipt_marker(self):
        entry = build_journal_entry(
            receipt_id='receipt-1', txn_date=date(2026, 8, 6), amount=4700,
            currency='MXN', amount_usd=252.69, fx_rate=18.6,
            expense_account_id='5100', liability_account_id='2100',
            owner_name='Test Owner', vendor='Vendor', description='Work',
        )
        entry['Id'] = '9001'
        verified = verify_journal_entry(
            entry, qbo_id='9001', receipt_id='receipt-1', txn_date=date(2026, 8, 6),
            amount_usd=252.69, expense_account_id='5100', liability_account_id='2100',
        )
        self.assertTrue(verified['verified_by_readback'])
        changed = dict(entry)
        changed['TxnDate'] = '2026-08-07'
        with self.assertRaisesRegex(ValueError, 'date readback mismatch'):
            verify_journal_entry(
                changed, qbo_id='9001', receipt_id='receipt-1', txn_date=date(2026, 8, 6),
                amount_usd=252.69, expense_account_id='5100', liability_account_id='2100',
            )

    def test_repayment_purchase_debits_liability_and_credits_bank(self):
        purchase = build_repayment_purchase(
            receipt_id='receipt-2', txn_date=date(2026, 8, 6), amount=4700,
            currency='MXN', amount_usd=272.78, fx_rate=17.23,
            liability_account_id='2100', bank_account_id='1100',
            owner_name='Test Owner', vendor='AC Vendor',
            description='Indirect repayment for owner work',
        )
        self.assertEqual(purchase['AccountRef'], {'value': '1100'})
        self.assertEqual(purchase['Line'][0]['AccountBasedExpenseLineDetail'], {
            'AccountRef': {'value': '2100'},
        })
        self.assertIn('Reduces amount due to Test Owner', purchase['PrivateNote'])
        purchase['Id'] = '9002'
        verified = verify_repayment_purchase(
            purchase, qbo_id='9002', receipt_id='receipt-2',
            txn_date=date(2026, 8, 6), amount_usd=272.78,
            liability_account_id='2100', bank_account_id='1100',
        )
        self.assertEqual(verified['qbo_entity_type'], 'Purchase')

    def test_repayment_duplicate_scan_matches_exact_bank_date_and_amount(self):
        class QueryClient:
            def query(self, _query):
                return {'QueryResponse': {'Purchase': [
                    {'Id': 'match', 'AccountRef': {'value': '1100'}, 'TotalAmt': 272.78},
                    {'Id': 'other-bank', 'AccountRef': {'value': '9999'}, 'TotalAmt': 272.78},
                    {'Id': 'other-amount', 'AccountRef': {'value': '1100'}, 'TotalAmt': 300},
                ]}}
        matches = matching_repayment_purchases(
            QueryClient(), txn_date=date(2026, 8, 6), amount_usd=272.78,
            bank_account_id='1100',
        )
        self.assertEqual([item['Id'] for item in matches], ['match'])

    def test_preflight_requires_exact_active_other_current_liability(self):
        client = FakeClient({
            '2100': {
                'Id': '2100', 'Name': 'Due to Test Owner (Net)',
                'AccountType': 'Other Current Liability', 'Active': True,
            },
            '5100': {
                'Id': '5100', 'Name': 'Maintenance', 'AccountType': 'Expense', 'Active': True,
            },
            '1100': {
                'Id': '1100', 'Name': 'Operating Bank', 'AccountType': 'Bank', 'Active': True,
            },
        })
        accounts = verify_accounts(
            client, liability_account_id='2100',
            liability_account_name='Due to Test Owner (Net)',
            expense_account_id='5100',
            bank_account_id='1100', bank_account_name='Operating Bank',
        )
        self.assertEqual(accounts['liability']['account_type'], 'Other Current Liability')
        self.assertEqual(accounts['bank']['account_type'], 'Bank')
        with self.assertRaisesRegex(ValueError, 'name mismatch'):
            validate_account(
                client.read_account('2100'), expected_id='2100',
                expected_name='Wrong account', expected_type='Other Current Liability',
            )


if __name__ == '__main__':
    unittest.main()
