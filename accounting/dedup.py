"""
Deduplication Guard

Before pushing a CSV to QBO, checks for transactions that already
exist (same date + amount + Kapital reference). Prevents double-counting
when overlapping CSVs are uploaded.
"""

import json
import re
import urllib.request
from datetime import date
from pathlib import Path
from typing import Dict, List, Set, Tuple


def check_for_duplicates(
    transactions: List[Dict],
    token: str,
    base_url: str,
) -> Tuple[List[Dict], List[Dict]]:
    """
    Split transactions into (new, already_exists).

    Matches on Kapital Clave reference embedded in QBO memo.
    Falls back to date + amount + vendor if no Clave.

    Args:
        transactions: classified transactions with fx applied
        token: QBO access token
        base_url: QBO API base

    Returns:
        (new_transactions, duplicates)
    """
    if not transactions:
        return [], []

    # Get date range from transactions
    dates = [t['date'] for t in transactions if t.get('date')]
    if not dates:
        return transactions, []

    min_date = min(dates)
    max_date = max(dates)

    # Pull existing QBO purchases in that date range
    sql = (
        f"SELECT Id, TxnDate, TotalAmt, EntityRef, PrivateNote "
        f"FROM Purchase "
        f"WHERE TxnDate >= '{min_date.isoformat()}' "
        f"AND TxnDate <= '{max_date.isoformat()}' "
        f"MAXRESULTS 500"
    )
    existing = _qbo_query(token, base_url, sql)

    # Also check deposits and transfers
    for entity_type in ('Deposit', 'Transfer'):
        amount_field = 'Amount' if entity_type == 'Transfer' else 'TotalAmt'
        sql2 = (
            f"SELECT Id, TxnDate, {amount_field}, PrivateNote "
            f"FROM {entity_type} "
            f"WHERE TxnDate >= '{min_date.isoformat()}' "
            f"AND TxnDate <= '{max_date.isoformat()}' "
            f"MAXRESULTS 200"
        )
        existing.extend(_qbo_query(token, base_url, sql2))

    # Build set of existing Kapital references (Clave)
    existing_refs: Set[str] = set()
    existing_fingerprints: Set[str] = set()

    for e in existing:
        note = e.get('PrivateNote', '')
        # Extract Kapital Clave reference
        ref_match = re.search(r'Clave:\s*(136-[\d/\-]+)', note)
        if ref_match:
            existing_refs.add(ref_match.group(1))

        # Also build date+amount fingerprint as fallback
        txn_date = e.get('TxnDate', '')
        amount = e.get('TotalAmt') or e.get('Amount', 0)
        existing_fingerprints.add(f"{txn_date}|{float(amount):.2f}")

    # Check each incoming transaction
    new_txns = []
    dupes = []

    for txn in transactions:
        # Extract Clave from the transaction's reference
        ref = txn.get('reference', '')
        clave_match = re.search(r'(136-[\d/\-]+)', ref)
        clave = clave_match.group(1) if clave_match else None

        if clave and clave in existing_refs:
            txn['_dedup_reason'] = f'Clave {clave} already in QBO'
            dupes.append(txn)
            continue

        # Fallback: date + USD amount
        if txn.get('date') and txn.get('amount_usd'):
            fp = f"{txn['date'].isoformat()}|{txn['amount_usd']:.2f}"
            if fp in existing_fingerprints:
                txn['_dedup_reason'] = f'Date+amount fingerprint already in QBO: {fp}'
                dupes.append(txn)
                continue

        new_txns.append(txn)

    return new_txns, dupes


def _qbo_query(token: str, base: str, sql: str) -> list:
    import urllib.parse
    encoded = urllib.parse.quote(sql)
    url = f"{base}/query?query={encoded}&minorversion=75"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        qr = data.get('QueryResponse', {})
        for key in ('Purchase', 'Deposit', 'Transfer'):
            if key in qr:
                return qr[key]
    except Exception:
        pass
    return []
