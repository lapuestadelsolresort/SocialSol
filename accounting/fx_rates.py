"""
MXN → USD Exchange Rate Lookup

Fetches the daily exchange rate for a given date from Banxico
(Bank of Mexico). Official FIX results are cached locally; unverified
intraday spot quotes are never used for accounting.
"""

import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error


CACHE_DIR = Path(os.environ.get('SOCIALSOL_FX_CACHE_DIR', Path(__file__).parent / 'fx_cache'))


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

    # Do not use or persist an intraday spot quote for a business-day
    # transaction. The official FIX may not be published yet; accounting must
    # wait and retry instead of permanently recording a provisional rate.
    if txn_date >= date.today() and txn_date.weekday() < 5:
        raise ValueError(f"Official Banxico FIX is not yet available for {txn_date}")

    # Last resort: try previous business days
    for days_back in range(1, 5):
        prev_date = txn_date - timedelta(days=days_back)
        cached = _load_cache(prev_date)
        if cached:
            _save_cache(txn_date, cached, source='previous_fix')
            return cached

        rate = _fetch_banxico(prev_date)
        if rate:
            _save_cache(txn_date, rate, source='previous_fix')
            _save_cache(prev_date, rate, source='banxico_fix')
            return rate

    raise ValueError(f"Could not fetch exchange rate for {txn_date}")


def convert_mxn_to_usd(amount_mxn: float, txn_date: date) -> float:
    """Convert MXN amount to USD using the day's rate."""
    rate = get_usd_rate(txn_date)
    return round(amount_mxn / rate, 2)


def apply_transaction_fx(transaction: dict) -> dict:
    """Attach FIX valuation while preserving an exact bank-executed USD transfer."""
    txn_date = transaction.get('date')
    if not txn_date:
        raise ValueError('transaction date is required for FX conversion')

    if transaction.get('category') == 'fx_conversion':
        exact_amount = float(transaction.get('transfer_amount_usd') or 0)
        executed_rate = float(transaction.get('transfer_exchange_rate') or 0)
        if exact_amount <= 0 or executed_rate <= 0:
            raise ValueError('FX conversion is missing the exact USD amount or executed rate from Kapital')
        transaction['fx_rate'] = executed_rate
        transaction['amount_usd'] = round(exact_amount, 2)
        transaction['fix_amount_usd'] = None
        return transaction

    rate = get_usd_rate(txn_date)
    fix_amount = round(float(transaction.get('amount') or 0) / rate, 2)
    transaction['fx_rate'] = rate
    transaction['fix_amount_usd'] = fix_amount
    transaction['amount_usd'] = fix_amount

    for fee in transaction.get('spei_fees') or []:
        fee['amount_usd'] = round(float(fee.get('amount') or 0) / rate, 2)
    if transaction.get('total_with_fees') is not None:
        transaction['total_with_fees_usd'] = round(
            float(transaction['total_with_fees']) / rate, 2
        )
    return transaction


def _load_cache(d: date) -> Optional[float]:
    """Load cached rate for a date."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{d.isoformat()}.json"
    if cache_file.exists():
        with open(cache_file) as f:
            data = json.load(f)
            if d >= date.today() and data.get('source') not in ('banxico_fix', 'previous_fix'):
                return None
            return data.get('rate')
    return None


def _save_cache(d: date, rate: float, source: str = 'banxico_fix'):
    """Cache a rate for a date."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{d.isoformat()}.json"
    with open(cache_file, 'w') as f:
        json.dump({
            'date': d.isoformat(),
            'rate': rate,
            'currency_pair': 'MXN/USD',
            'source': source,
        }, f)


def _banxico_token() -> Optional[str]:
    token = str(os.environ.get('BANXICO_API_TOKEN') or '').strip()
    if token:
        return token
    secrets_dir = Path(os.environ.get(
        'SOCIALSOL_SECRETS_DIR', Path(__file__).parent.parent / 'secrets'
    ))
    secret_path = secrets_dir / 'banxico.json'
    try:
        data = json.loads(secret_path.read_text())
    except (OSError, ValueError, TypeError):
        return None
    return str(data.get('api_token') or data.get('token') or '').strip() or None


def _fetch_banxico(d: date) -> Optional[float]:
    """
    Fetch from Banxico SIE API (Bank of Mexico).
    Series SF43718 = USD/MXN FIX rate.
    """
    try:
        token = _banxico_token()
        if not token:
            return None
        date_str = d.strftime('%Y-%m-%d')
        url = f"https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718/datos/{date_str}/{date_str}"
        req = urllib.request.Request(url, headers={
            'Bmx-Token': token,
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
    """Fallback for today's spot rate only.

    This endpoint does not accept a historical date. Using it for an older
    transaction silently rewrites that day's accounting FX rate to today's
    spot rate, so historical lookups must fail closed when Banxico and cache
    data are unavailable.
    """
    if d != date.today():
        return None
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
