import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dedup import check_for_duplicates  # noqa: E402


class QboDedupTests(unittest.TestCase):
    def transaction(self, **overrides):
        transaction = {
            'date': date(2026, 8, 6),
            'amount': 4700,
            'amount_usd': 272.78,
            'reference': 'Clave: 136-06/08/2026/06-1704547533',
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

    def test_malformed_query_response_aborts(self):
        with self.assertRaisesRegex(RuntimeError, 'no QueryResponse'):
            check_for_duplicates([self.transaction()], lambda _sql: {})


if __name__ == '__main__':
    unittest.main()
