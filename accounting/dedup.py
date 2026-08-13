"""
Deduplication Guard

Before pushing a CSV to QBO, checks for transactions that already
exist (same date + amount + Kapital reference). Prevents double-counting
when overlapping CSVs are uploaded.
"""

import re
from typing import Callable, Dict, List, Set, Tuple


def check_for_duplicates(
    transactions: List[Dict],
    query_qbo: Callable[[str], dict],
) -> Tuple[List[Dict], List[Dict]]:
    """
    Split transactions into (new, already_exists).

    Matches on Kapital Clave reference embedded in QBO memo.
    Falls back to date + amount + vendor if no Clave.

    Args:
        transactions: classified transactions with fx applied
        query_qbo: authenticated QBO query function. The caller owns OAuth
            refresh and must raise when QBO cannot be queried.

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
    existing = _qbo_query(query_qbo, sql)

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
        existing.extend(_qbo_query(query_qbo, sql2))

    # Build set of existing Kapital references (Clave)
    existing_refs: Set[str] = set()
    existing_mxn_fingerprints: Set[str] = set()
    existing_fingerprints: Set[str] = set()

    for e in existing:
        note = e.get('PrivateNote', '')
        # Extract Kapital Clave reference
        ref_match = re.search(r'Clave:\s*(136-[\d/\-]+)', note)
        if ref_match:
            existing_refs.add(ref_match.group(1))

        # Prefer the original MXN amount embedded by SocialSol. This remains
        # stable even if an old QBO entity used a different cached FX rate.
        original_mxn_match = re.search(
            r'\borig(?:inal)?\s*:?\s*\$?([\d,]+(?:\.\d+)?)\s*MXN\b',
            note,
            re.IGNORECASE,
        )
        if original_mxn_match:
            original_mxn = float(original_mxn_match.group(1).replace(',', ''))
            existing_mxn_fingerprints.add(f"{e.get('TxnDate', '')}|{original_mxn:.2f}")

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

        # Fallback: date + original MXN amount, then date + converted USD.
        # The MXN fingerprint catches records created through another guarded
        # workflow, such as an owner-liability repayment.
        if txn.get('date') and txn.get('amount'):
            mxn_fp = f"{txn['date'].isoformat()}|{float(txn['amount']):.2f}"
            if mxn_fp in existing_mxn_fingerprints:
                txn['_dedup_reason'] = f'Date+MXN fingerprint already in QBO: {mxn_fp}'
                dupes.append(txn)
                continue

        if txn.get('date') and txn.get('amount_usd'):
            fp = f"{txn['date'].isoformat()}|{txn['amount_usd']:.2f}"
            if fp in existing_fingerprints:
                txn['_dedup_reason'] = f'Date+amount fingerprint already in QBO: {fp}'
                dupes.append(txn)
                continue

        new_txns.append(txn)

    return new_txns, dupes


def _qbo_query(query_qbo: Callable[[str], dict], sql: str) -> list:
    """Query through the refresh-aware client and reject unverifiable reads."""
    data = query_qbo(sql)
    if not isinstance(data, dict):
        raise RuntimeError('QBO duplicate query returned a non-object response')
    if data.get('Fault'):
        raise RuntimeError(f"QBO duplicate query returned a fault: {data['Fault']}")
    response = data.get('QueryResponse')
    if not isinstance(response, dict):
        raise RuntimeError('QBO duplicate query returned no QueryResponse')
    for key in ('Purchase', 'Deposit', 'Transfer'):
        rows = response.get(key)
        if rows is not None:
            if not isinstance(rows, list):
                raise RuntimeError(f'QBO duplicate query returned invalid {key} rows')
            return rows
    return []
