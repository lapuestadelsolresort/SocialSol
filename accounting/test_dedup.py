import re
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dedup import check_for_duplicates, query_all_qbo  # noqa: E402


class QboDedupTests(unittest.TestCase):
    def transaction(self, **overrides):
        transaction = {
            'date': date(2026, 8, 6),
            'amount': 4700,
            'amount_usd': 272.78,
            'reference': 'Clave: 136-06/08/2026/06-1704547533',
            'direction': 'debit',
            '_expected_qbo_entity_type': 'Purchase',
        }
        transaction.update(overrides)
        return transaction

    def test_authenticated_query_detects_existing_clave(self):
        transaction = self.transaction()

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': '2470', 'TxnDate': '2026-08-06', 'TotalAmt': 272.78,
                    'PrivateNote': 'Ref: Clave: 136-06/08/2026/06-1704547533',
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([transaction], query)
        self.assertEqual(new, [])
        self.assertEqual(duplicates, [transaction])
        self.assertIn('Clave', transaction['_dedup_reason'])
        self.assertEqual(transaction['_dedup_qbo_id'], '2470')
        self.assertEqual(transaction['_dedup_entity_type'], 'Purchase')

    def test_query_failure_aborts_instead_of_assuming_qbo_is_empty(self):
        def unavailable(_sql):
            raise RuntimeError('QBO unavailable')

        with self.assertRaisesRegex(RuntimeError, 'QBO unavailable'):
            check_for_duplicates([self.transaction()], unavailable)

    def test_original_mxn_fingerprint_survives_a_different_fx_rate(self):
        transaction = self.transaction(reference='', amount_usd=275.50)

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': '2470', 'TxnDate': '2026-08-06', 'TotalAmt': 272.78,
                    'PrivateNote': 'Owner repayment | Original: 4,700.00 MXN | FX: 17.23 MXN/USD',
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([transaction], query)
        self.assertEqual(new, [])
        self.assertEqual(duplicates, [transaction])
        self.assertIn('Date+MXN fingerprint', transaction['_dedup_reason'])
        self.assertEqual(transaction['_dedup_qbo_id'], '2470')

    def test_fee_parent_reference_never_deduplicates_the_principal(self):
        transaction = self.transaction()

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': '2524', 'TxnDate': '2026-08-06', 'TotalAmt': 0.09,
                    'PrivateNote': (
                        'SPEI IVA on transfer to Ignacio Rubio | '
                        'Parent ref: Clave: 136-06/08/2026/06-1704547533 | '
                        'Parent orig $4,700.00 MXN'
                    ),
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([transaction], query)
        self.assertEqual(new, [transaction])
        self.assertEqual(duplicates, [])

    def test_existing_uncategorized_principal_preserves_review_metadata(self):
        transaction = self.transaction(
            amount=2105,
            amount_usd=122.17,
            reference='Clave: 136-06/08/2026/06-1704547161',
            category=None,
            category_name=None,
            original_category_key='maintenance',
            original_category_name='Maintenance',
        )

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': '2522', 'TxnDate': '2026-08-06', 'TotalAmt': 122.17,
                    'PrivateNote': (
                        'REVIEW REQUIRED: unresolved Kapital debit recorded to Uncategorized Expense; '
                        'suggested category: Maintenance | Ref: Clave: 136-06/08/2026/06-1704547161'
                    ),
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([transaction], query)
        self.assertEqual(new, [])
        self.assertEqual(duplicates[0]['_dedup_qbo_id'], '2522')
        self.assertEqual(duplicates[0]['category'], 'uncategorized_expense')
        self.assertTrue(duplicates[0]['_requires_review'])

    def test_malformed_query_response_aborts(self):
        with self.assertRaisesRegex(RuntimeError, 'no QueryResponse'):
            check_for_duplicates([self.transaction()], lambda _sql: {})

    def test_manual_qbo_row_with_same_date_and_amount_does_not_suppress_kapital(self):
        transaction = self.transaction(reference='')

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': 'manual-1', 'TxnDate': '2026-08-06', 'TotalAmt': 272.78,
                    'PrivateNote': 'Manual office purchase',
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([transaction], query)
        self.assertEqual(new, [transaction])
        self.assertEqual(duplicates, [])

    def test_fallback_does_not_consume_a_different_vendor(self):
        transaction = self.transaction(
            reference='', _expected_qbo_vendor_id='vendor-expected',
        )

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': 'kapital-other-vendor', 'TxnDate': '2026-08-06',
                    'TotalAmt': 272.78, 'EntityRef': {'value': 'vendor-other'},
                    'PrivateNote': 'Kapital: reference-less purchase',
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([transaction], query)
        self.assertEqual(new, [transaction])
        self.assertEqual(duplicates, [])

    def test_one_existing_qbo_entity_can_only_consume_one_incoming_row(self):
        first = self.transaction()
        second = self.transaction(time='10:01:00', transaction_code='400001')

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': '2470', 'TxnDate': '2026-08-06', 'TotalAmt': 272.78,
                    'PrivateNote': 'Kapital: payment | Ref: Clave: 136-06/08/2026/06-1704547533',
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([first, second], query)
        self.assertEqual(new, [second])
        self.assertEqual(duplicates, [first])

    def test_equal_month_end_credit_and_debit_are_separated_by_entity_type(self):
        interest = self.transaction(
            reference='', amount=53.40, amount_usd=3.10, direction='credit',
            _expected_qbo_entity_type='Deposit',
        )
        tax = self.transaction(
            reference='', amount=53.40, amount_usd=3.10, direction='debit',
            _expected_qbo_entity_type='Purchase',
        )

        def query(sql):
            if 'FROM Purchase' in sql:
                return {'QueryResponse': {'Purchase': [{
                    'Id': 'tax-1', 'TxnDate': '2026-08-06', 'TotalAmt': 3.10,
                    'PrivateNote': 'Kapital: ISR',
                }]}}
            if 'FROM Deposit' in sql:
                return {'QueryResponse': {'Deposit': [{
                    'Id': 'interest-1', 'TxnDate': '2026-08-06', 'TotalAmt': 3.10,
                    'PrivateNote': 'Kapital: Interes',
                }]}}
            return {'QueryResponse': {}}

        new, duplicates = check_for_duplicates([interest, tax], query)
        self.assertEqual(new, [])
        self.assertEqual(
            [(row['_dedup_entity_type'], row['_dedup_qbo_id']) for row in duplicates],
            [('Deposit', 'interest-1'), ('Purchase', 'tax-1')],
        )

    def test_transfer_with_old_fix_amount_fails_closed(self):
        transaction = self.transaction(
            reference='', amount=127800, amount_usd=7500,
            direction='credit', transfer_amount_usd=7500,
            _expected_qbo_entity_type='Transfer',
        )

        def query(sql):
            if 'FROM Transfer' in sql:
                return {'QueryResponse': {'Transfer': [{
                    'Id': '2400', 'TxnDate': '2026-08-06', 'Amount': 7417.30,
                    'PrivateNote': 'Kapital: COMPRA DE DIVISAS | Original: 127,800.00 MXN',
                }]}}
            return {'QueryResponse': {}}

        with self.assertRaisesRegex(RuntimeError, 'requires exact USD amount 7500.00'):
            check_for_duplicates([transaction], query)

    def test_qbo_queries_are_paginated_until_a_short_page(self):
        starts = []

        def query(sql):
            start = int(re.search(r'STARTPOSITION (\d+)', sql).group(1))
            starts.append(start)
            rows = {
                1: [{'Id': '1'}, {'Id': '2'}],
                3: [{'Id': '3'}],
            }[start]
            return {'QueryResponse': {'Purchase': rows}}

        rows = query_all_qbo(query, 'SELECT Id FROM Purchase', 'Purchase', page_size=2)
        self.assertEqual([row['Id'] for row in rows], ['1', '2', '3'])
        self.assertEqual(starts, [1, 3])


if __name__ == '__main__':
    unittest.main()
