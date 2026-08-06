"""
Kapital Bank CSV Parser
Parses the quirky Kapital statement format into clean transaction dicts.
"""

import csv
import re
import io
from datetime import datetime, date
from typing import List, Dict, Optional, Tuple


def parse_kapital_csv(file_path: str) -> Tuple[Dict, List[Dict]]:
    """
    Parse a Kapital Bank statement CSV.

    Returns:
        (metadata, transactions) where metadata has account info and
        transactions is a list of parsed transaction dicts.
    """
    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        raw = f.read()

    # Extract metadata from header
    metadata = _extract_metadata(raw)

    # Find the header row and parse transactions
    transactions = _parse_transactions(raw)

    # Group SPEI triplets (transfer + comisión + IVA)
    grouped = _group_spei_triplets(transactions)

    metadata['transaction_count'] = len(transactions)
    metadata['grouped_count'] = len(grouped)

    return metadata, grouped


def _extract_metadata(raw: str) -> Dict:
    """Extract account holder info from the CSV header."""
    meta = {}
    lines = raw.split('\n')
    for line in lines[:10]:
        clean = line.strip().strip(',').strip()
        if 'Estado de Cuenta' in clean:
            meta['statement_type'] = clean
        elif 'S.A. DE C.V.' in clean or 'RIVIERA' in clean:
            meta['entity'] = clean.strip()
        elif 'RFC:' in clean:
            meta['rfc'] = clean.replace('RFC:', '').strip()
        elif 'Saldo Inicial' in clean:
            # Extract opening balance
            parts = line.split(',')
            for p in parts:
                p = p.strip().strip('_')
                try:
                    val = float(p)
                    if val > 100:  # likely the balance
                        meta['opening_balance'] = val
                except (ValueError, TypeError):
                    pass
    return meta


def _clean_field(val: str) -> str:
    """Strip leading underscores, whitespace, and trailing pipes from Kapital fields."""
    if not val:
        return ''
    val = val.strip().strip(',')
    # Remove leading underscore (Kapital CSV quirk)
    if val.startswith('_'):
        val = val[1:]
    return val.strip()


def _parse_date(date_str: str) -> Optional[date]:
    """Parse Kapital date format: DDMMYYYY"""
    date_str = _clean_field(date_str)
    if not date_str or len(date_str) < 8:
        return None
    try:
        return datetime.strptime(date_str, '%d%m%Y').date()
    except ValueError:
        return None


def _parse_amount(amount_str: str) -> Optional[float]:
    """Parse amount, handling commas and spaces."""
    amount_str = _clean_field(amount_str)
    if not amount_str:
        return None
    # Remove spaces and replace comma thousands separators
    amount_str = amount_str.replace(' ', '').replace(',', '')
    try:
        return float(amount_str)
    except ValueError:
        return None


def _parse_transactions(raw: str) -> List[Dict]:
    """Parse all transaction rows from the CSV."""
    transactions = []
    lines = raw.split('\n')

    # Find the header row
    header_idx = None
    for i, line in enumerate(lines):
        if 'FECHA' in line and 'DESCRIPCION' in line and 'CARGOS' in line:
            header_idx = i
            break

    if header_idx is None:
        raise ValueError("Could not find transaction header row (FECHA, DESCRIPCION, CARGOS...)")

    # Parse each line after the header
    for i in range(header_idx + 1, len(lines)):
        line = lines[i].strip()
        if not line or line.startswith(' ,'):
            # Check if it's an empty separator line
            clean = line.replace(',', '').replace(' ', '')
            if not clean:
                continue

        # Split by comma, respecting the Kapital format
        # The description field can contain commas, pipes, etc.
        # Kapital uses a fixed column structure with leading underscores
        txn = _parse_transaction_line(line)
        if txn:
            transactions.append(txn)

    return transactions


def _parse_transaction_line(line: str) -> Optional[Dict]:
    """Parse a single transaction line."""
    # Skip empty/header/separator lines
    clean_check = line.replace(',', '').replace(' ', '').replace('_', '')
    if not clean_check:
        return None
    if 'Saldo Inicial' in line:
        return None

    # The Kapital CSV format has fields separated by commas, but the DESCRIPCION
    # field can contain commas. The structure is:
    # ,FECHA,HORA,DESCRIPCION,REFERENCIA,ORIGEN,SUCURSAL,CARGOS,ABONOS,SALDO,OPERACION,TRANSACCION
    # There's a leading empty field (the first comma)

    # Strategy: split from both ends where fields are predictable,
    # leave the middle (DESCRIPCION + REFERENCIA) as a blob to parse

    parts = line.split(',')

    # Need at least: empty + FECHA + HORA + DESCRIPCION... + CARGOS + ABONOS + SALDO + OPERACION + TRANSACCION
    if len(parts) < 8:
        return None

    # First 3 fields: empty, FECHA, HORA
    fecha_raw = _clean_field(parts[1]) if len(parts) > 1 else ''
    hora_raw = _clean_field(parts[2]) if len(parts) > 2 else ''

    txn_date = _parse_date(fecha_raw)
    if not txn_date:
        return None

    # Last 5 fields from the end: CARGOS, ABONOS, SALDO, OPERACION, TRANSACCION
    # But we need to find them. They're numeric or empty.
    # Work backwards from the end
    cargos = None
    abonos = None
    saldo = None
    operacion = ''
    transaccion = ''

    # The last fields are: ...,CARGOS,ABONOS,SALDO,OPERACION,TRANSACCION,
    # Find the last 5 meaningful fields by looking for the pattern
    # OPERACION and TRANSACCION are at the very end
    # Let's find them by working backwards

    # Remove trailing empty parts
    while parts and not parts[-1].strip().strip(','):
        parts.pop()

    if len(parts) < 8:
        return None

    transaccion = _clean_field(parts[-1])
    operacion = _clean_field(parts[-2])
    saldo_raw = _clean_field(parts[-3])
    abonos_raw = _clean_field(parts[-4])
    cargos_raw = _clean_field(parts[-5])
    sucursal = _clean_field(parts[-6])
    origen = _clean_field(parts[-7])

    saldo = _parse_amount(saldo_raw)
    cargos = _parse_amount(cargos_raw)
    abonos = _parse_amount(abonos_raw)

    # Everything between HORA and ORIGEN is DESCRIPCION + REFERENCIA
    # Join the middle parts
    middle_parts = parts[3:-7]
    middle_blob = ','.join(middle_parts)

    # Try to split DESCRIPCION and REFERENCIA
    # REFERENCIA often starts with "_Clave:" for SPEI or is a separate field
    descripcion, referencia = _split_desc_ref(middle_blob)

    # Parse time
    hora = _clean_field(hora_raw)

    # Determine direction
    if cargos and cargos > 0:
        direction = 'debit'
        amount = cargos
    elif abonos and abonos > 0:
        direction = 'credit'
        amount = abonos
    else:
        return None

    # Extract SPEI details if present
    spei_details = _extract_spei_details(descripcion)

    return {
        'date': txn_date,
        'time': hora,
        'description': descripcion,
        'reference': referencia,
        'origin': origen,
        'branch': sucursal,
        'debit': cargos,
        'credit': abonos,
        'balance': saldo,
        'operation': operacion,
        'transaction_code': transaccion,
        'direction': direction,
        'amount': amount,
        'currency': 'MXN',
        'spei': spei_details,
        'is_spei_fee': _is_spei_fee(descripcion),
        'is_spei_iva': _is_spei_iva(descripcion),
    }


def _split_desc_ref(blob: str) -> Tuple[str, str]:
    """Split the description+reference blob."""
    # Look for "_Clave:" which starts the REFERENCIA for SPEI
    clave_match = re.search(r'_Clave:\s*', blob)
    if clave_match:
        desc = blob[:clave_match.start()]
        ref = blob[clave_match.start():]
        return _clean_field(desc), _clean_field(ref)

    # For non-SPEI, try splitting on the last occurrence of a reference-like pattern
    # References are often numeric strings or specific identifiers
    parts = blob.rsplit(',', 1)
    if len(parts) == 2:
        return _clean_field(parts[0]), _clean_field(parts[1])

    return _clean_field(blob), ''


def _extract_spei_details(desc: str) -> Optional[Dict]:
    """Extract structured details from SPEI transfer descriptions."""
    if 'Envio SPEI' not in desc and 'Recepcion SPEI' not in desc:
        return None

    details = {
        'direction': 'out' if 'Envio SPEI' in desc else 'in',
        'bank': '',
        'payee': '',
        'clabe': '',
        'concept': '',
        'raw': desc,
    }

    # Extract bank: "Envio SPEI AZTECA" or "Envio SPEI BBVA MEXICO" etc.
    bank_match = re.search(r'(?:Envio|Recepcion) SPEI (.+?)\s*\|', desc)
    if bank_match:
        details['bank'] = bank_match.group(1).strip()

    # Extract payee: after the pipe following bank name, before "Dato no verificado"
    payee_match = re.search(r'\|\s*(.+?)\s+Dato no verificado', desc)
    if not payee_match:
        # Fallback: try after pipe, before next pipe or end
        payee_match = re.search(r'\|\s*([^|]+?)\s*(?:\||$)', desc)
    if payee_match:
        details['payee'] = payee_match.group(1).strip()

    # Extract CLABE
    clabe_match = re.search(r'\| (\d{18}) \|', desc)
    if clabe_match:
        details['clabe'] = clabe_match.group(1)

    # Extract concept/memo: the field after the sequential reference number
    # Pattern: | <number> | <CONCEPT> | KAPITAL |
    concept_match = re.search(r'\| \d+ \| (.+?) \| KAPITAL \|', desc)
    if concept_match:
        details['concept'] = concept_match.group(1).strip()
    else:
        # Fallback: look for concept between last numeric ref and KAPITAL
        concept_match2 = re.search(r'\d{7,}\s*\|\s*(.+?)\s*\|\s*KAPITAL', desc)
        if concept_match2:
            details['concept'] = concept_match2.group(1).strip()
        elif not details['concept']:
            # Try extracting from description keywords for known payees
            # e.g. "SUSY CLEANING OF COMMON AREAS" or "INTERNET MIRADOR"
            # The concept is often embedded in the payee area after the CLABE
            after_payee = re.search(r'Dato no verificado.*?\|.*?\|.*?\|.*?\|\s*(.*?)\s*\|\s*KAPITAL', desc)
            if after_payee:
                details['concept'] = after_payee.group(1).strip()

    # For incoming SPEI (DLOCAL etc)
    if details['direction'] == 'in':
        dlocal_match = re.search(r'DLOCAL MEXICO', desc)
        if dlocal_match:
            details['payee'] = 'DLOCAL MEXICO SA DE CV'
            details['concept'] = 'DLOCAL_MEX'

    return details


def _is_spei_fee(desc: str) -> bool:
    """Check if this is a SPEI commission line."""
    return ('Comisi' in desc and 'Transferencia' in desc and 'SPEI' in desc) or \
           desc.strip().startswith('COM. SPEI') or \
           'Comisión Transferencia' in desc or \
           'Comisi\ufffd' in desc  # encoding issues


def _is_spei_iva(desc: str) -> bool:
    """Check if this is a SPEI IVA line."""
    return 'IVA por Transferencia' in desc or 'IVA SPEI' in desc


def _group_spei_triplets(transactions: List[Dict]) -> List[Dict]:
    """
    Group SPEI transfers with their Comisión + IVA lines.
    They share the same OPERACION prefix and appear consecutively.
    Fee/IVA lines become children of the parent transfer.
    """
    grouped = []
    i = 0

    while i < len(transactions):
        txn = transactions[i]

        # If this is a main SPEI transfer (not a fee/IVA line)
        if txn.get('spei') and not txn['is_spei_fee'] and not txn['is_spei_iva']:
            # Look ahead for fee + IVA lines
            fees = []
            j = i + 1
            while j < len(transactions) and j <= i + 2:
                next_txn = transactions[j]
                if next_txn['is_spei_fee'] or next_txn['is_spei_iva']:
                    fees.append(next_txn)
                    j += 1
                else:
                    break

            txn['spei_fees'] = fees
            txn['total_with_fees'] = txn['amount'] + sum(f['amount'] for f in fees)
            grouped.append(txn)
            i = j
            continue

        # Standalone fee/IVA (rare, shouldn't happen if grouped properly)
        if txn['is_spei_fee'] or txn['is_spei_iva']:
            txn['_standalone_fee'] = True
            grouped.append(txn)
            i += 1
            continue

        # Non-SPEI transaction
        grouped.append(txn)
        i += 1

    return grouped


if __name__ == '__main__':
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: python kapital_parser.py <csv_file>")
        sys.exit(1)

    meta, txns = parse_kapital_csv(sys.argv[1])
    print(f"Metadata: {json.dumps(meta, default=str, indent=2)}")
    print(f"\nParsed {len(txns)} grouped transactions:\n")

    for t in txns:
        date_str = t['date'].isoformat() if t['date'] else '?'
        direction = '←' if t['direction'] == 'credit' else '→'
        amount = t['amount']
        desc = t['description'][:80]
        fees = t.get('spei_fees', [])
        fee_total = sum(f['amount'] for f in fees) if fees else 0

        print(f"  {date_str} {direction} ${amount:>12,.2f} MXN  {desc}")
        if fees:
            print(f"           fees: ${fee_total:>8,.2f} MXN ({len(fees)} lines)")
