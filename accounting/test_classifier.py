import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from classifier import KapitalClassifier


class ReceiptReferenceClassifierTests(unittest.TestCase):
    def classifier(self, directory):
        config = Path(directory) / 'config.json'
        config.write_text(json.dumps({
            'qbo_accounts': {'expenses': {'maintenance': {'id': '10', 'name': 'Maintenance'}}},
            'vendors': {},
            'salary_patterns': {},
            'receipt_channels': {},
        }))
        return KapitalClassifier(str(config))

    def test_unreferenced_sergio_petty_cash_is_not_autonomously_posted(self):
        with tempfile.TemporaryDirectory() as directory:
            classifier = self.classifier(directory)
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

    def test_statement_vendors_receive_stable_auto_categories(self):
        with tempfile.TemporaryDirectory() as directory:
            classifier = self.classifier(directory)
            home_depot = classifier.classify({
                'description': 'HOME DEP8786NUEV VALL2', 'reference': '',
                'direction': 'debit', 'amount': 2499, 'spei': None,
            })
            institutional = classifier.classify({
                'description': 'INSTITUCIONALES BAHIA', 'reference': '',
                'direction': 'debit', 'amount': 513.93, 'spei': None,
            })
            tequila = classifier.classify({
                'description': 'Envio SPEI', 'reference': '',
                'direction': 'debit', 'amount': 7500,
                'spei': {'payee': 'THE TE UILA EXPERIENCE', 'concept': 'DEPOSIT SEPTEMBER 5'},
            })
            self.assertEqual((home_depot['confidence'], home_depot['category']), ('auto', 'maintenance'))
            self.assertEqual((institutional['confidence'], institutional['category']), ('auto', 'supplies'))
            self.assertEqual((tequila['confidence'], tequila['category']), ('auto', 'group_activities'))

    def test_mercadolibre_credit_is_an_expense_refund_not_a_purchase(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.classifier(directory).classify({
                'description': 'ABONO', 'reference': 'MERPAGO MERCADOLIBRE',
                'direction': 'credit', 'amount': 490, 'spei': None,
            })
        self.assertEqual(result['category'], 'supplies')
        self.assertTrue(result['expense_refund'])
        self.assertEqual(result['confidence'], 'auto')

    def test_fx_conversion_extracts_bank_executed_usd_and_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.classifier(directory).classify({
                'description': 'COMPRA DE DIVISAS 7 500.00 USD A UN TIPO DE CAMBIO DE 17.04',
                'reference': '', 'direction': 'credit', 'amount': 127800, 'spei': None,
            })
        self.assertEqual(result['category'], 'fx_conversion')
        self.assertEqual(result['transfer_amount_usd'], 7500)
        self.assertEqual(result['transfer_exchange_rate'], 17.04)

    def test_owner_funding_requires_an_exact_bofa_amount(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.classifier(directory).classify({
                'description': '(NB) RECEPCION DE CUENTA', 'reference': '',
                'direction': 'credit', 'amount': 850, 'spei': None,
            })
        self.assertEqual(result['category'], 'owner_transfer')
        self.assertTrue(result['exact_transfer_required'])


if __name__ == '__main__':
    unittest.main()
