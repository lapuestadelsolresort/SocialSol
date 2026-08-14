"""
Deduplication Guard

Before pushing a CSV to QBO, checks for transactions that already
exist (same date + amount + Kapital reference). Prevents double-counting
when overlapping CSVs are uploaded.
"""

import re
from collections import defaultdict
from typing import Callable, Dict, List, Tuple


QBO_PAGE_SIZE = 1000


def check_for_duplicates(
    transactions: List[Dict],
    query_qbo: Callable[[str], dict],
) -> Tuple[List[Dict], List[Dict]]:
    """
    Split transactions into (new, already_exists).

    Matches on Kapital Clave reference embedded in QBO memo.
    Falls back to entity type + date + amount + vendor (when available) only
    for integration-owned QBO records. Candidate records are consumed as a
    multiset so one existing QBO entity can never suppress two incoming
    Kapital transactions.

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

    # Pull every relevant QBO entity. Pagination is mandatory: a full or
    # overlapping statement can exceed QBO's per-query result limit.
    purchase_sql = (
        f"SELECT Id, TxnDate, TotalAmt, EntityRef, PrivateNote "
        f"FROM Purchase "
        f"WHERE TxnDate >= '{min_date.isoformat()}' "
        f"AND TxnDate <= '{max_date.isoformat()}'"
    )
    existing = [dict(row, _entity_type='Purchase') for row in query_all_qbo(
        query_qbo, purchase_sql, 'Purchase'
    )]

    # Also check deposits and transfers
    for entity_type in ('Deposit', 'Transfer'):
        amount_field = 'Amount' if entity_type == 'Transfer' else 'TotalAmt'
        entity_sql = (
            f"SELECT Id, TxnDate, {amount_field}, PrivateNote "
            f"FROM {entity_type} "
            f"WHERE TxnDate >= '{min_date.isoformat()}' "
            f"AND TxnDate <= '{max_date.isoformat()}'"
        )
        existing.extend(dict(row, _entity_type=entity_type) for row in query_all_qbo(
            query_qbo, entity_sql, entity_type
        ))

    # Build set of existing Kapital references (Clave)
    existing_tokens: Dict[Tuple[str, str], List[Dict]] = defaultdict(list)
    existing_refs: Dict[Tuple[str, str], List[Dict]] = defaultdict(list)
    existing_mxn_fingerprints: Dict[Tuple[str, str], List[Dict]] = defaultdict(list)
    existing_fingerprints: Dict[Tuple[str, str], List[Dict]] = defaultdict(list)

    for e in existing:
        note = e.get('PrivateNote', '')
        # SPEI fee purchases carry the parent Clave and original transfer
        # amount for exact fee reconciliation. They must never participate in
        # principal deduplication by Clave, MXN amount, or converted amount.
        if re.match(r'^SPEI\s+(?:Commission|IVA)\s+on transfer\b', note, re.IGNORECASE):
            continue
        entity_type = e.get('_entity_type')
        integration_owned = bool(re.search(
            r'Kapital txn:|Kapital:|\bClave:\s*136-|\borig(?:inal)?\s*:?\s*\$?[\d,]+(?:\.\d+)?\s*MXN\b|'
            r'REVIEW REQUIRED:.*Kapital|Jason funding Kapital',
            note,
            re.IGNORECASE,
        ))

        token_match = re.search(r'Kapital txn:\s*([a-f0-9]{24})', note, re.IGNORECASE)
        if token_match:
            existing_tokens[(entity_type, token_match.group(1).lower())].append(e)
        # Extract Kapital Clave reference
        ref_match = re.search(r'Clave:\s*(136-[\d/\-]+)', note)
        if ref_match:
            existing_refs[(entity_type, ref_match.group(1))].append(e)

        if not integration_owned:
            continue

        # Prefer the original MXN amount embedded by SocialSol. This remains
        # stable even if an old QBO entity used a different cached FX rate.
        original_mxn_match = re.search(
            r'\borig(?:inal)?\s*:?\s*\$?([\d,]+(?:\.\d+)?)\s*MXN\b',
            note,
            re.IGNORECASE,
        )
        if original_mxn_match:
            original_mxn = float(original_mxn_match.group(1).replace(',', ''))
            fingerprint = f"{e.get('TxnDate', '')}|{original_mxn:.2f}"
            existing_mxn_fingerprints[(entity_type, fingerprint)].append(e)

        # Also build date+amount fingerprint as fallback
        txn_date = e.get('TxnDate', '')
        amount = e.get('TotalAmt') or e.get('Amount', 0)
        existing_fingerprints[(entity_type, f"{txn_date}|{float(amount):.2f}")].append(e)

    # Check each incoming transaction
    new_txns = []
    dupes = []
    used_ids = set()

    def consume(pool, key, expected_vendor_id=None):
        for candidate in pool.get(key, []):
            candidate_id = f"{candidate.get('_entity_type')}:{candidate.get('Id')}"
            entity_ref = candidate.get('EntityRef') or {}
            candidate_vendor_id = str(entity_ref.get('value') or '')
            if expected_vendor_id and candidate_vendor_id != str(expected_vendor_id):
                continue
            if candidate_id in used_ids:
                continue
            used_ids.add(candidate_id)
            return candidate
        return None

    for txn in transactions:
        # Extract Clave from the transaction's reference
        ref = txn.get('reference', '')
        clave_match = re.search(r'(136-[\d/\-]+)', ref)
        clave = clave_match.group(1) if clave_match else None
        entity_type = txn.get('_expected_qbo_entity_type')
        expected_vendor_id = txn.get('_expected_qbo_vendor_id') if entity_type == 'Purchase' else None
        if entity_type not in ('Purchase', 'Deposit', 'Transfer'):
            new_txns.append(txn)
            continue

        matched = None
        reason = None
        token = str(txn.get('_kapital_transaction_token') or '').lower()
        if token:
            matched = consume(existing_tokens, (entity_type, token))
            if matched:
                reason = f'Kapital transaction identity {token} already in QBO'

        if not matched and clave:
            matched = consume(existing_refs, (entity_type, clave))
            if matched:
                reason = f'Clave {clave} already in QBO'

        if matched:
            txn['_dedup_reason'] = reason
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
            matched = consume(
                existing_mxn_fingerprints, (entity_type, mxn_fp), expected_vendor_id
            )
            if matched:
                if entity_type == 'Transfer':
                    qbo_amount = float(matched.get('Amount') or matched.get('TotalAmt') or 0)
                    expected_amount = float(txn.get('transfer_amount_usd') or 0)
                    if expected_amount > 0 and abs(qbo_amount - expected_amount) > 0.01:
                        raise RuntimeError(
                            f"Existing QBO Transfer {matched.get('Id')} has amount {qbo_amount:.2f}; "
                            f"Kapital requires exact USD amount {expected_amount:.2f}"
                        )
                txn['_dedup_reason'] = f'Date+MXN fingerprint already in QBO: {mxn_fp}'
                txn['_dedup_qbo_id'] = str(matched.get('Id') or '') or None
                txn['_dedup_entity_type'] = matched.get('_entity_type')
                dupes.append(txn)
                continue

        if txn.get('date') and txn.get('amount_usd'):
            fp = f"{txn['date'].isoformat()}|{txn['amount_usd']:.2f}"
            matched = consume(existing_fingerprints, (entity_type, fp), expected_vendor_id)
            if matched:
                txn['_dedup_reason'] = f'Date+amount fingerprint already in QBO: {fp}'
                txn['_dedup_qbo_id'] = str(matched.get('Id') or '') or None
                txn['_dedup_entity_type'] = matched.get('_entity_type')
                dupes.append(txn)
                continue

        new_txns.append(txn)

    return new_txns, dupes


def query_all_qbo(
    query_qbo: Callable[[str], dict],
    base_sql: str,
    entity_type: str,
    page_size: int = QBO_PAGE_SIZE,
) -> List[Dict]:
    """Read all QBO query pages and fail closed on malformed pagination."""
    start = 1
    rows = []
    page_signatures = set()
    while True:
        page_sql = f"{base_sql} STARTPOSITION {start} MAXRESULTS {page_size}"
        page = _qbo_query(query_qbo, page_sql, expected_entity=entity_type)
        signature = tuple(str(row.get('Id') or '') for row in page)
        if page and signature in page_signatures:
            raise RuntimeError(f'QBO {entity_type} pagination repeated a result page')
        page_signatures.add(signature)
        rows.extend(page)
        if len(page) < page_size:
            return rows
        start += len(page)


def _qbo_query(
    query_qbo: Callable[[str], dict],
    sql: str,
    expected_entity: str = None,
) -> list:
    """Query through the refresh-aware client and reject unverifiable reads."""
    data = query_qbo(sql)
    if not isinstance(data, dict):
        raise RuntimeError('QBO duplicate query returned a non-object response')
    if data.get('Fault'):
        raise RuntimeError(f"QBO duplicate query returned a fault: {data['Fault']}")
    response = data.get('QueryResponse')
    if not isinstance(response, dict):
        raise RuntimeError('QBO duplicate query returned no QueryResponse')
    keys = (expected_entity,) if expected_entity else ('Purchase', 'Deposit', 'Transfer')
    for key in keys:
        rows = response.get(key)
        if rows is not None:
            if not isinstance(rows, list):
                raise RuntimeError(f'QBO duplicate query returned invalid {key} rows')
            return rows
    return []
