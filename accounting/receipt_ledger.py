"""Enrich Kapital reimbursements from the durable Slack receipt ledger."""

import re
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List


PAYMENT_REFERENCE_RE = re.compile(r"\b(?:LPDSR|LPDS-R-)[A-F0-9]{16}\b", re.IGNORECASE)
POSSIBLE_DUPLICATE_WINDOW_DAYS = 30


def payment_references(transaction: Dict) -> List[str]:
    explicit = str(transaction.get('payment_reference') or '').upper()
    text = f"{transaction.get('description') or ''} {transaction.get('reference') or ''} {explicit}"
    return list(dict.fromkeys(match.upper() for match in PAYMENT_REFERENCE_RE.findall(text)))


def _date_value(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _possible_duplicate_reference(transaction: Dict, referenced: List[Dict]):
    """Find a same-payee/amount payment near an exact referenced reimbursement."""
    if payment_references(transaction):
        return None
    payee = str((transaction.get('spei') or {}).get('payee') or '').strip().upper()
    transaction_date = _date_value(transaction.get('date'))
    if not payee or transaction_date is None:
        return None
    currency = str(transaction.get('currency') or 'MXN').upper()
    tolerance = 1 if currency == 'MXN' else 0.01
    for candidate in referenced:
        candidate_payee = str((candidate.get('spei') or {}).get('payee') or '').strip().upper()
        candidate_date = _date_value(candidate.get('date'))
        references = payment_references(candidate)
        if (candidate_payee != payee or candidate_date is None or len(references) != 1
                or str(candidate.get('currency') or 'MXN').upper() != currency
                or abs(float(candidate.get('amount') or 0) - float(transaction.get('amount') or 0)) > tolerance
                or abs((candidate_date - transaction_date).days) > POSSIBLE_DUPLICATE_WINDOW_DAYS):
            continue
        return references[0]
    return None


def _durable_referenced_transactions(connection: sqlite3.Connection) -> List[Dict]:
    """Load coded reimbursements reconciled by earlier statement uploads."""
    rows = connection.execute(
        """
        SELECT DISTINCT r.payment_reference, b.transaction_date, b.description,
               b.reference, b.currency, b.amount
        FROM accounting_receipts r
        JOIN accounting_reconciliations x
          ON x.receipt_id = r.id AND x.status = 'matched'
        JOIN accounting_bank_transactions b ON b.source_key = x.bank_reference
        WHERE r.status IN ('matched', 'posted')
          AND r.payment_reference IS NOT NULL
        """
    ).fetchall()
    from kapital_parser import _extract_spei_details
    return [{
        **dict(row),
        'date': row['transaction_date'],
        'spei': _extract_spei_details(str(row['description'] or '')),
    } for row in rows]


def _matched_receipt(connection: sqlite3.Connection, payment_reference: str):
    rows = connection.execute(
        """
        SELECT DISTINCT r.id, r.currency, r.amount, r.category_key, r.category_name,
               r.description, r.payment_reference
        FROM accounting_receipts r
        JOIN accounting_reconciliations x ON x.receipt_id = r.id AND x.status = 'matched'
        WHERE upper(r.payment_reference) = upper(?)
          AND r.status IN ('matched', 'posted')
        """,
        (payment_reference,),
    ).fetchall()
    return rows[0] if len(rows) == 1 else None


def _matched_legacy_receipt(connection: sqlite3.Connection, transaction: Dict):
    """Resolve one uncoded transaction through the durable reconciliation ledger."""
    transaction_date = _date_value(transaction.get('date'))
    if transaction_date is None:
        return None
    currency = str(transaction.get('currency') or 'MXN').upper()
    tolerance = 1 if currency == 'MXN' else 0.01
    rows = connection.execute(
        """
        SELECT DISTINCT r.id, r.currency, r.amount, r.category_key, r.category_name,
               r.description, r.payment_reference
        FROM accounting_receipts r
        JOIN accounting_reconciliations x
          ON x.receipt_id = r.id AND x.status = 'matched'
        JOIN accounting_bank_transactions b ON b.source_key = x.bank_reference
        WHERE r.status IN ('matched', 'posted')
          AND b.transaction_date = ?
          AND upper(b.currency) = ?
          AND abs(b.amount - ?) <= ?
          AND coalesce(b.description, '') = ?
          AND coalesce(b.reference, '') = ?
        """,
        (
            transaction_date.isoformat(), currency, float(transaction.get('amount') or 0), tolerance,
            str(transaction.get('description') or ''),
            str(transaction.get('reference') or transaction.get('clave') or ''),
        ),
    ).fetchall()
    return rows[0] if len(rows) == 1 else None


def _receipt_lines(connection: sqlite3.Connection, receipt) -> List[Dict]:
    rows = connection.execute(
        """
        SELECT item_index, amount, currency, category_key, category_name,
               vendor, description
        FROM accounting_receipt_items
        WHERE receipt_id = ?
        ORDER BY item_index
        """,
        (receipt['id'],),
    ).fetchall()
    if not rows:
        rows = [{
            'item_index': 1,
            'amount': receipt['amount'],
            'currency': receipt['currency'],
            'category_key': receipt['category_key'],
            'category_name': receipt['category_name'],
            'vendor': None,
            'description': receipt['description'],
        }]
    return [dict(row) for row in rows]


def _enrich_from_receipt(
        transaction: Dict, connection: sqlite3.Connection, receipt,
        payment_reference: str = None, match_rule: str = 'reconciled_receipt') -> Dict:
    result = dict(transaction)
    transaction_currency = str(transaction.get('currency') or 'MXN').upper()
    receipt_currency = str(receipt['currency'] or '').upper()
    tolerance = 1 if receipt_currency == 'MXN' else 0.01
    match_label = payment_reference or receipt['id']
    if transaction_currency != receipt_currency or abs(float(transaction.get('amount') or 0) - float(receipt['amount'])) > tolerance:
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Reconciled receipt amount or currency mismatch: {match_label}',
            'payment_reference': payment_reference,
            'receipt_reference_error': True,
        })
        return result

    lines = _receipt_lines(connection, receipt)
    if any(not line.get('category_key') for line in lines):
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Reconciled receipt has an unclassified expense item: {match_label}',
            'payment_reference': payment_reference,
            'receipt_id': receipt['id'],
            'receipt_reference_error': True,
        })
        return result
    if abs(sum(float(line['amount']) for line in lines) - float(receipt['amount'])) > 0.005:
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Reconciled receipt item total does not equal reimbursement: {match_label}',
            'payment_reference': payment_reference,
            'receipt_id': receipt['id'],
            'receipt_reference_error': True,
        })
        return result

    result.update({
        'confidence': 'auto',
        'category': 'receipt_bundle',
        'category_name': 'Receipt Reimbursement',
        'reason': match_rule,
        'note': f"Reconciled receipt reimbursement {payment_reference or receipt['id']}",
        'payment_reference': payment_reference,
        'receipt_id': receipt['id'],
        'receipt_items': lines,
        'receipt_reference_error': False,
    })
    return result


def _enrich(transaction: Dict, connection: sqlite3.Connection) -> Dict:
    references = payment_references(transaction)
    result = dict(transaction)
    if len(references) != 1:
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': 'Referenced reimbursement has zero or multiple payment references',
            'receipt_reference_error': True,
        })
        return result
    reference = references[0]
    receipt = _matched_receipt(connection, reference)
    if receipt is None:
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Receipt payment reference is not uniquely reconciled: {reference}',
            'payment_reference': reference,
            'receipt_reference_error': True,
        })
        return result
    return _enrich_from_receipt(
        transaction, connection, receipt, payment_reference=reference,
        match_rule=f'Exact reconciled receipt payment reference: {reference}',
    )


def apply_receipt_ledger(results: Dict[str, List[Dict]], database_path: str) -> Dict[str, List[Dict]]:
    """Move uniquely reconciled receipt transactions into the safe bucket."""
    database = Path(database_path)
    if not database.is_file():
        raise FileNotFoundError(f"receipt ledger database does not exist: {database}")

    enriched = {'auto': [], 'guess': [], 'unknown': []}
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        referenced_matches = {}
        matched_reference_transactions = _durable_referenced_transactions(connection)
        for bucket in ('auto', 'guess', 'unknown'):
            for transaction in results.get(bucket, []):
                if payment_references(transaction):
                    enriched_transaction = _enrich(transaction, connection)
                    referenced_matches[id(transaction)] = enriched_transaction
                    if enriched_transaction.get('confidence') == 'auto':
                        matched_reference_transactions.append(enriched_transaction)
        for bucket in ('auto', 'guess', 'unknown'):
            for transaction in results.get(bucket, []):
                if payment_references(transaction):
                    receipt_transaction = referenced_matches[id(transaction)]
                    enriched[receipt_transaction['confidence']].append(receipt_transaction)
                    continue
                legacy_receipt = _matched_legacy_receipt(connection, transaction)
                if legacy_receipt is not None:
                    receipt_transaction = _enrich_from_receipt(
                        transaction, connection, legacy_receipt,
                        match_rule='Unique reconciled legacy receipt transaction',
                    )
                    enriched[receipt_transaction['confidence']].append(receipt_transaction)
                    continue
                duplicate_reference = _possible_duplicate_reference(
                    transaction, matched_reference_transactions
                )
                if not duplicate_reference:
                    enriched[bucket].append(transaction)
                    continue
                duplicate = dict(transaction)
                duplicate.update({
                    'confidence': 'unknown',
                    'original_category_key': transaction.get('category'),
                    'original_category_name': transaction.get('category_name'),
                    'category': None,
                    'category_name': None,
                    'reason': (
                        'Possible duplicate of referenced reimbursement '
                        f'{duplicate_reference}; manual review required'
                    ),
                    'possible_duplicate_payment_reference': duplicate_reference,
                })
                enriched['unknown'].append(duplicate)
    finally:
        connection.close()
    return enriched
