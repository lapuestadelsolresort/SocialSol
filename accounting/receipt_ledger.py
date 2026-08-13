"""Enrich Kapital reimbursements from the durable Slack receipt ledger."""

import re
import sqlite3
from pathlib import Path
from typing import Dict, List


PAYMENT_REFERENCE_RE = re.compile(r"\b(?:LPDSR|LPDS-R-)[A-F0-9]{16}\b", re.IGNORECASE)


def payment_references(transaction: Dict) -> List[str]:
    text = f"{transaction.get('description') or ''} {transaction.get('reference') or ''}"
    return list(dict.fromkeys(match.upper() for match in PAYMENT_REFERENCE_RE.findall(text)))


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

    transaction_currency = str(transaction.get('currency') or 'MXN').upper()
    receipt_currency = str(receipt['currency'] or '').upper()
    tolerance = 1 if receipt_currency == 'MXN' else 0.01
    if transaction_currency != receipt_currency or abs(float(transaction.get('amount') or 0) - float(receipt['amount'])) > tolerance:
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Receipt payment reference amount or currency mismatch: {reference}',
            'payment_reference': reference,
            'receipt_reference_error': True,
        })
        return result

    lines = _receipt_lines(connection, receipt)
    if any(not line.get('category_key') for line in lines):
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Reconciled receipt has an unclassified expense item: {reference}',
            'payment_reference': reference,
            'receipt_id': receipt['id'],
            'receipt_reference_error': True,
        })
        return result
    if abs(sum(float(line['amount']) for line in lines) - float(receipt['amount'])) > 0.005:
        result.update({
            'confidence': 'unknown',
            'category': None,
            'category_name': None,
            'reason': f'Reconciled receipt item total does not equal reimbursement: {reference}',
            'payment_reference': reference,
            'receipt_id': receipt['id'],
            'receipt_reference_error': True,
        })
        return result

    result.update({
        'confidence': 'auto',
        'category': 'receipt_bundle',
        'category_name': 'Receipt Reimbursement',
        'reason': f'Exact reconciled receipt payment reference: {reference}',
        'note': f'Reconciled receipt reimbursement {reference}',
        'payment_reference': reference,
        'receipt_id': receipt['id'],
        'receipt_items': lines,
        'receipt_reference_error': False,
    })
    return result


def apply_receipt_ledger(results: Dict[str, List[Dict]], database_path: str) -> Dict[str, List[Dict]]:
    """Move reference-tagged transactions into the safe bucket from ledger evidence."""
    tagged = any(payment_references(txn) for bucket in results.values() for txn in bucket)
    if not tagged:
        return results
    database = Path(database_path)
    if not database.is_file():
        raise FileNotFoundError(f"receipt ledger database does not exist: {database}")

    enriched = {'auto': [], 'guess': [], 'unknown': []}
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        for bucket in ('auto', 'guess', 'unknown'):
            for transaction in results.get(bucket, []):
                if not payment_references(transaction):
                    enriched[bucket].append(transaction)
                    continue
                receipt_transaction = _enrich(transaction, connection)
                enriched[receipt_transaction['confidence']].append(receipt_transaction)
    finally:
        connection.close()
    return enriched
