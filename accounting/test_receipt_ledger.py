import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from receipt_ledger import apply_receipt_ledger, payment_references


class ReceiptLedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / 'crm.db'
        connection = sqlite3.connect(self.database)
        connection.executescript("""
            CREATE TABLE accounting_receipts (
                id TEXT PRIMARY KEY, status TEXT, currency TEXT, amount REAL,
                category_key TEXT, category_name TEXT, description TEXT,
                payment_reference TEXT
            );
            CREATE TABLE accounting_reconciliations (
                receipt_id TEXT, status TEXT, bank_reference TEXT
            );
            CREATE TABLE accounting_bank_transactions (
                source_key TEXT, transaction_date TEXT, description TEXT,
                reference TEXT, currency TEXT, amount REAL
            );
            CREATE TABLE accounting_receipt_items (
                receipt_id TEXT, item_index INTEGER, amount REAL, currency TEXT,
                category_key TEXT, category_name TEXT, vendor TEXT, description TEXT
            );
            INSERT INTO accounting_receipts VALUES (
                'receipt-1', 'matched', 'MXN', 2105, 'maintenance', 'Maintenance',
                'Five petty-cash receipts', 'LPDSRA1B2C3D4E5F60718'
            );
            INSERT INTO accounting_reconciliations (receipt_id, status)
                VALUES ('receipt-1', 'matched');
            INSERT INTO accounting_receipt_items VALUES
                ('receipt-1', 1, 340, 'MXN', 'maintenance', 'Maintenance', 'A', 'Item A'),
                ('receipt-1', 2, 30, 'MXN', 'maintenance', 'Maintenance', 'B', 'Item B'),
                ('receipt-1', 3, 220, 'MXN', 'maintenance', 'Maintenance', 'C', 'Item C'),
                ('receipt-1', 4, 815, 'MXN', 'maintenance', 'Maintenance', 'D', 'Item D'),
                ('receipt-1', 5, 700, 'MXN', 'cleaning_services', 'Cleaning Services', 'E', 'Item E');
        """)
        connection.close()

    def tearDown(self):
        self.directory.cleanup()

    def test_exact_reconciled_reference_promotes_split_bundle_to_auto(self):
        transaction = {
            'description': 'Envio SPEI | LPDSRA1B2C3D4E5F60718 | KAPITAL',
            'reference': 'Clave: 123', 'amount': 2105, 'currency': 'MXN',
            'confidence': 'guess', 'category': 'maintenance',
        }
        results = apply_receipt_ledger(
            {'auto': [], 'guess': [transaction], 'unknown': []}, str(self.database)
        )
        self.assertEqual(len(results['auto']), 1)
        enriched = results['auto'][0]
        self.assertEqual(enriched['receipt_id'], 'receipt-1')
        self.assertEqual(enriched['category'], 'receipt_bundle')
        self.assertEqual([item['amount'] for item in enriched['receipt_items']], [340, 30, 220, 815, 700])
        self.assertEqual(enriched['receipt_items'][-1]['category_key'], 'cleaning_services')

    def test_unmatched_or_wrong_amount_reference_fails_closed(self):
        transaction = {
            'description': 'LPDSRA1B2C3D4E5F60718', 'amount': 2000,
            'currency': 'MXN', 'confidence': 'auto', 'category': 'maintenance',
        }
        results = apply_receipt_ledger(
            {'auto': [transaction], 'guess': [], 'unknown': []}, str(self.database)
        )
        self.assertEqual(len(results['auto']), 0)
        self.assertTrue(results['unknown'][0]['receipt_reference_error'])

    def test_uncoded_reconciled_rounding_match_preserves_receipt_split(self):
        connection = sqlite3.connect(self.database)
        connection.executescript("""
            INSERT INTO accounting_receipts VALUES (
                'receipt-2', 'matched', 'MXN', 1087.09, NULL, NULL,
                'Susy cleaning and supplies', NULL
            );
            INSERT INTO accounting_receipt_items VALUES
                ('receipt-2', 1, 87.09, 'MXN', 'supplies', 'Supplies',
                 'Miscelanea Mi Pollo', 'Household supplies and sandpaper'),
                ('receipt-2', 2, 1000, 'MXN', 'cleaning_services', 'Cleaning Services',
                 'Susy', 'Cleaning for two days');
            INSERT INTO accounting_bank_transactions VALUES (
                'bank-susy-1088', '2026-08-13', 'WEEKLY PAYMENT COMMON AREAS',
                'Clave: 0673606335', 'MXN', 1088
            );
            INSERT INTO accounting_reconciliations VALUES (
                'receipt-2', 'matched', 'bank-susy-1088'
            );
        """)
        connection.close()
        transaction = {
            'date': '2026-08-13', 'description': 'WEEKLY PAYMENT COMMON AREAS',
            'reference': 'Clave: 0673606335', 'amount': 1088, 'currency': 'MXN',
            'confidence': 'guess', 'category': 'cleaning_services',
        }
        results = apply_receipt_ledger(
            {'auto': [], 'guess': [transaction], 'unknown': []}, str(self.database)
        )
        self.assertEqual(len(results['auto']), 1)
        enriched = results['auto'][0]
        self.assertEqual(enriched['receipt_id'], 'receipt-2')
        self.assertIsNone(enriched['payment_reference'])
        self.assertEqual(enriched['category'], 'receipt_bundle')
        self.assertEqual(
            [item['category_key'] for item in enriched['receipt_items']],
            ['supplies', 'cleaning_services'],
        )
        self.assertEqual(sum(item['amount'] for item in enriched['receipt_items']), 1087.09)

    def test_reference_extraction_is_exact_and_case_insensitive(self):
        self.assertEqual(
            payment_references({'description': 'pay lpdsra1b2c3d4e5f60718 now'}),
            ['LPDSRA1B2C3D4E5F60718'],
        )
        self.assertEqual(
            payment_references({'description': 'legacy lpds-r-a1b2c3d4e5f60718'}),
            ['LPDS-R-A1B2C3D4E5F60718'],
        )

    def test_uncoded_same_payee_and_amount_is_held_as_possible_duplicate(self):
        coded = {
            'date': '2026-08-13', 'amount': 2105, 'currency': 'MXN',
            'description': 'LPDSRA1B2C3D4E5F60718',
            'spei': {'payee': 'SERGIO GRACIA'},
            'confidence': 'guess', 'category': 'maintenance',
        }
        uncoded = {
            'date': '2026-08-06', 'amount': 2105, 'currency': 'MXN',
            'description': 'REIMBURSEMENT PETTY CASH SERGIO',
            'spei': {'payee': 'SERGIO GRACIA'},
            'confidence': 'guess', 'category': 'maintenance',
        }
        results = apply_receipt_ledger(
            {'auto': [], 'guess': [uncoded, coded], 'unknown': []}, str(self.database)
        )
        self.assertEqual(len(results['auto']), 1)
        self.assertEqual(len(results['unknown']), 1)
        held = results['unknown'][0]
        self.assertEqual(
            held['possible_duplicate_payment_reference'], 'LPDSRA1B2C3D4E5F60718'
        )
        self.assertIn('Possible duplicate', held['reason'])


if __name__ == '__main__':
    unittest.main()
