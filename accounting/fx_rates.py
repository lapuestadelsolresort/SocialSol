"""
MXN → USD Exchange Rate Lookup

Fetches the daily exchange rate for a given date. Uses Banxico
(Bank of Mexico) official rate, with exchangerate-api fallback.
Caches results locally to avoid repeated API calls.
"""

import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error


CACHE_DIR = Path(__file__).parent / 'fx_cache'


def get_usd_rate(txn_date: date) -> float:
    """
    Get MXN/USD exchange rate for a given date.
    Returns the number of MXN per 1 USD (e.g., 17.04).
    Falls back to nearest available date if market was closed.
    """
    # Check cache first
    cached = _load_cache(txn_date)
    if cached:
        return cached

    # Try Banxico
    rate = _fetch_banxico(txn_date)
    if rate:
        _save_cache(txn_date, rate)
        return rate

    # Fallback: exchangerate-api (free tier)
    rate = _fetch_exchangerate_api(txn_date)
    if rate:
        _save_cache(txn_date, rate)
        return rate

    # Last resort: try previous business days
    for days_back in range(1, 5):
        prev_date = txn_date - timedelta(days=days_back)
        cached = _load_cache(prev_date)
        if cached:
            _save_cache(txn_date, cached)  # Cache for the requested date too
            return cached

        rate = _fetch_banxico(prev_date)
        if rate:
            _save_cache(txn_date, rate)
            _save_cache(prev_date, rate)
            return rate

    raise ValueError(f"Could not fetch exchange rate for {txn_date}")


def convert_mxn_to_usd(amount_mxn: float, txn_date: date) -> float:
    """Convert MXN amount to USD using the day's rate."""
    rate = get_usd_rate(txn_date)
    return round(amount_mxn / rate, 2)


def _load_cache(d: date) -> Optional[float]:
    """Load cached rate for a date."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{d.isoformat()}.json"
    if cache_file.exists():
        with open(cache_file) as f:
            data = json.load(f)
            return data.get('rate')
    return None


def _save_cache(d: date, rate: float):
    """Cache a rate for a date."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{d.isoformat()}.json"
    with open(cache_file, 'w') as f:
        json.dump({'date': d.isoformat(), 'rate': rate, 'currency_pair': 'MXN/USD'}, f)


def _fetch_banxico(d: date) -> Optional[float]:
    """
    Fetch from Banxico SIE API (Bank of Mexico).
    Series SF43718 = USD/MXN FIX rate.
    """
    try:
        date_str = d.strftime('%Y-%m-%d')
        url = f"https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718/datos/{date_str}/{date_str}"
        req = urllib.request.Request(url, headers={
            'Bmx-Token': 'e12d492aa02858efbcc82e4ce54bf0da34e4c70828b4eab1a3b4ec81cebb217e',
            'Accept': 'application/json',
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            series = data.get('bmx', {}).get('series', [{}])[0]
            datos = series.get('datos', [])
            if datos:
                rate_str = datos[0].get('dato', '').replace(',', '')
                if rate_str and rate_str != 'N/E':
                    return float(rate_str)
    except Exception:
        pass
    return None


def _fetch_exchangerate_api(d: date) -> Optional[float]:
    """Fallback: free exchangerate-api."""
    try:
        url = f"https://api.exchangerate-api.com/v4/latest/USD"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            rate = data.get('rates', {}).get('MXN')
            if rate:
                return float(rate)
    except Exception:
        pass
    return None


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        d = date.fromisoformat(sys.argv[1])
    else:
        d = date.today()

    rate = get_usd_rate(d)
    print(f"MXN/USD rate for {d}: {rate}")
    print(f"Example: $1,000 MXN = ${convert_mxn_to_usd(1000, d):.2f} USD")
