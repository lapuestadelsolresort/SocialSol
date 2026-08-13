import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from classifier import KapitalClassifier


class ReceiptReferenceClassifierTests(unittest.TestCase):
    def test_unreferenced_sergio_petty_cash_is_not_autonomously_posted(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({
                'qbo_accounts': {'expenses': {'maintenance': {'id': '10', 'name': 'Maintenance'}}},
                'vendors': {},
                'salary_patterns': {},
                'receipt_channels': {},
            }))
            classifier = KapitalClassifier(str(config))
            result = classifier.classify({
                'description': 'Envio SPEI',
                'reference': '',
                'direction': 'debit',
                'amount': 2105,
                'spei': {
                    'payee': 'SERGIO GRACIA',
                    'concept': 'REINBURSMENT PETTY CASH',
                },
            })
            self.assertEqual(result['confidence'], 'guess')
            self.assertEqual(result['category'], 'maintenance')
            self.assertIn('reference required', result['reason'])


if __name__ == '__main__':
    unittest.main()
