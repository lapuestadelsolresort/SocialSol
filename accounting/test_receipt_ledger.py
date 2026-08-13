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
                receipt_id TEXT, status TEXT
            );
            CREATE TABLE accounting_receipt_items (
                receipt_id TEXT, item_index INTEGER, amount REAL, currency TEXT,
                category_key TEXT, category_name TEXT, vendor TEXT, description TEXT
            );
            INSERT INTO accounting_receipts VALUES (
                'receipt-1', 'matched', 'MXN', 2105, 'maintenance', 'Maintenance',
                'Five petty-cash receipts', 'LPDSRA1B2C3D4E5F60718'
            );
            INSERT INTO accounting_reconciliations VALUES ('receipt-1', 'matched');
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

    def test_reference_extraction_is_exact_and_case_insensitive(self):
        self.assertEqual(
            payment_references({'description': 'pay lpdsra1b2c3d4e5f60718 now'}),
            ['LPDSRA1B2C3D4E5F60718'],
        )
        self.assertEqual(
            payment_references({'description': 'legacy lpds-r-a1b2c3d4e5f60718'}),
            ['LPDS-R-A1B2C3D4E5F60718'],
        )


if __name__ == '__main__':
    unittest.main()
