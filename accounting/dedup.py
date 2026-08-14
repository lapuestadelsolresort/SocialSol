"""
Deduplication Guard

Before pushing a CSV to QBO, checks for transactions that already
exist (same date + amount + Kapital reference). Prevents double-counting
when overlapping CSVs are uploaded.
"""

import re
from typing import Callable, Dict, List, Tuple


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
    existing = [dict(row, _entity_type='Purchase') for row in _qbo_query(query_qbo, sql)]

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
        existing.extend(dict(row, _entity_type=entity_type) for row in _qbo_query(query_qbo, sql2))

    # Build set of existing Kapital references (Clave)
    existing_refs: Dict[str, Dict] = {}
    existing_mxn_fingerprints: Dict[str, Dict] = {}
    existing_fingerprints: Dict[str, Dict] = {}

    for e in existing:
        note = e.get('PrivateNote', '')
        # SPEI fee purchases carry the parent Clave and original transfer
        # amount for exact fee reconciliation. They must never participate in
        # principal deduplication by Clave, MXN amount, or converted amount.
        if re.match(r'^SPEI\s+(?:Commission|IVA)\s+on transfer\b', note, re.IGNORECASE):
            continue
        # Extract Kapital Clave reference
        ref_match = re.search(r'Clave:\s*(136-[\d/\-]+)', note)
        if ref_match:
            existing_refs.setdefault(ref_match.group(1), e)

        # Prefer the original MXN amount embedded by SocialSol. This remains
        # stable even if an old QBO entity used a different cached FX rate.
        original_mxn_match = re.search(
            r'\borig(?:inal)?\s*:?\s*\$?([\d,]+(?:\.\d+)?)\s*MXN\b',
            note,
            re.IGNORECASE,
        )
        if original_mxn_match:
            original_mxn = float(original_mxn_match.group(1).replace(',', ''))
            existing_mxn_fingerprints.setdefault(
                f"{e.get('TxnDate', '')}|{original_mxn:.2f}", e
            )

        # Also build date+amount fingerprint as fallback
        txn_date = e.get('TxnDate', '')
        amount = e.get('TotalAmt') or e.get('Amount', 0)
        existing_fingerprints.setdefault(f"{txn_date}|{float(amount):.2f}", e)

    # Check each incoming transaction
    new_txns = []
    dupes = []

    for txn in transactions:
        # Extract Clave from the transaction's reference
        ref = txn.get('reference', '')
        clave_match = re.search(r'(136-[\d/\-]+)', ref)
        clave = clave_match.group(1) if clave_match else None

        if clave and clave in existing_refs:
            matched = existing_refs[clave]
            txn['_dedup_reason'] = f'Clave {clave} already in QBO'
            txn['_dedup_qbo_id'] = str(matched.get('Id') or '') or None
            txn['_dedup_entity_type'] = matched.get('_entity_type')
            if re.search(
                r'REVIEW REQUIRED:\s*unresolved Kapital debit recorded to Uncategorized Expense',
                str(matched.get('PrivateNote') or ''),
                re.IGNORECASE,
            ):
                txn['_original_category_key'] = (
                    txn.get('original_category_key') or txn.get('category')
                )
                txn['_original_category_name'] = (
                    txn.get('original_category_name') or txn.get('category_name')
                )
                txn['category'] = 'uncategorized_expense'
                txn['category_name'] = 'Uncategorized Expense'
                txn['_requires_review'] = True
                txn['_review_reason'] = (
                    'Existing QBO principal is recorded to Uncategorized Expense; category review required'
                )
            dupes.append(txn)
            continue

        # Fallback: date + original MXN amount, then date + converted USD.
        # The MXN fingerprint catches records created through another guarded
        # workflow, such as an owner-liability repayment.
        if txn.get('date') and txn.get('amount'):
            mxn_fp = f"{txn['date'].isoformat()}|{float(txn['amount']):.2f}"
            if mxn_fp in existing_mxn_fingerprints:
                matched = existing_mxn_fingerprints[mxn_fp]
                txn['_dedup_reason'] = f'Date+MXN fingerprint already in QBO: {mxn_fp}'
                txn['_dedup_qbo_id'] = str(matched.get('Id') or '') or None
                txn['_dedup_entity_type'] = matched.get('_entity_type')
                dupes.append(txn)
                continue

        if txn.get('date') and txn.get('amount_usd'):
            fp = f"{txn['date'].isoformat()}|{txn['amount_usd']:.2f}"
            if fp in existing_fingerprints:
                matched = existing_fingerprints[fp]
                txn['_dedup_reason'] = f'Date+amount fingerprint already in QBO: {fp}'
                txn['_dedup_qbo_id'] = str(matched.get('Id') or '') or None
                txn['_dedup_entity_type'] = matched.get('_entity_type')
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
