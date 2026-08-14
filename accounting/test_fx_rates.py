import sys
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from fx_rates import _fetch_exchangerate_api  # noqa: E402


class HistoricalFxSafetyTests(unittest.TestCase):
    def test_latest_rate_endpoint_is_never_used_for_a_historical_date(self):
        with patch('urllib.request.urlopen') as urlopen:
            self.assertIsNone(_fetch_exchangerate_api(date.today() - timedelta(days=1)))
        urlopen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
