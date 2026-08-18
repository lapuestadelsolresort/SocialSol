import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import fx_rates  # noqa: E402
from fx_rates import _banxico_token, apply_transaction_fx  # noqa: E402


class HistoricalFxSafetyTests(unittest.TestCase):
    def test_no_spot_rate_source_exists(self):
        # F-037: the unreachable exchangerate-api helper was dead code and is
        # deleted — the module's only rate sources are the local cache and
        # Banxico FIX, and unavailable rates fail closed rather than falling
        # back to an intraday spot quote.
        self.assertFalse(hasattr(fx_rates, '_fetch_exchangerate_api'))
        source = Path(fx_rates.__file__).read_text()
        self.assertNotIn('exchangerate-api', source)

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
