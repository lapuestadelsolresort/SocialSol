import sys
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from fx_rates import _banxico_token, _fetch_exchangerate_api, apply_transaction_fx  # noqa: E402


class HistoricalFxSafetyTests(unittest.TestCase):
    def test_latest_rate_endpoint_is_never_used_for_a_historical_date(self):
        with patch('urllib.request.urlopen') as urlopen:
            self.assertIsNone(_fetch_exchangerate_api(date.today() - timedelta(days=1)))
        urlopen.assert_not_called()

    def test_exact_kapital_conversion_does_not_use_banxico_fix(self):
        transaction = {
            'date': date(2026, 7, 30), 'amount': 127800,
            'category': 'fx_conversion', 'transfer_amount_usd': 7500,
            'transfer_exchange_rate': 17.04,
        }
        with patch('fx_rates.get_usd_rate') as get_rate:
            apply_transaction_fx(transaction)
        get_rate.assert_not_called()
        self.assertEqual(transaction['amount_usd'], 7500)
        self.assertEqual(transaction['fx_rate'], 17.04)

    def test_banxico_token_is_loaded_from_the_secrets_directory(self):
        with patch.dict('os.environ', {}, clear=True):
            with patch('fx_rates.Path.read_text', return_value='{"api_token":"secret-token"}'):
                self.assertEqual(_banxico_token(), 'secret-token')


if __name__ == '__main__':
    unittest.main()
