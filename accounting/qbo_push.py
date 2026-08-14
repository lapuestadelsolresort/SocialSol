"""
QuickBooks Online Push Module

Writes classified Kapital transactions to QBO as Purchase (expense)
or Deposit (income) records. Handles token refresh, vendor lookup,
and MXN→USD conversion.
"""

import base64
import hashlib
import json
import os
import re
import unicodedata
import urllib.request
import urllib.error
import urllib.parse
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple


DEFAULT_QBO_EXPENSE_ACCOUNTS = {
    # Active QBO default review account. This fallback is intentionally code
    # owned so a guarded statement run can record an unresolved debit without
    # requiring a runtime-only config edit.
    'uncategorized_expense': '2',
}


def allocate_receipt_item_usd(total_usd: float, items: List[Dict]) -> List[float]:
    """Allocate rounded USD cents proportionally while preserving the exact total."""
    total_cents = int(round(float(total_usd) * 100))
    source_total = sum(float(item.get('amount') or 0) for item in items)
    if total_cents <= 0 or source_total <= 0 or not items:
        raise ValueError('receipt split requires positive parent and item totals')
    raw = [total_cents * float(item.get('amount') or 0) / source_total for item in items]
    cents = [int(value) for value in raw]
    remainder = total_cents - sum(cents)
    order = sorted(range(len(items)), key=lambda index: (raw[index] - cents[index], -index), reverse=True)
    for index in order[:remainder]:
        cents[index] += 1
    return [value / 100 for value in cents]


class QBOClient:
    """QuickBooks Online API client."""

    def __init__(self, secrets_path: str = None):
        if secrets_path is None:
            secrets_dir = Path(os.environ.get(
                'SOCIALSOL_SECRETS_DIR', Path(__file__).parent.parent / 'secrets'
            ))
            secrets_path = str(secrets_dir / 'quickbooks.json')
        self.secrets_path = secrets_path
        self._load_secrets()

    def _load_secrets(self):
        with open(self.secrets_path) as f:
            data = json.load(f)
        tokens = data.get('tokens', {})
        self.realm_id = data.get('realmId') or data.get('realm_id')
        credentials = data.get('production') or data.get('development') or {}
        if not credentials.get('client_id'):
            dev_path = Path(self.secrets_path).with_name('quickbooks-dev.json')
            if dev_path.is_file():
                credentials = json.loads(dev_path.read_text())
        self.client_id = credentials.get('client_id')
        self.client_secret = credentials.get('client_secret')
        self.access_token = data.get('access_token') or tokens.get('access_token')
        self.refresh_token = data.get('refresh_token') or tokens.get('refresh_token')
        missing = [name for name, value in {
            'realm id': self.realm_id,
            'client id': self.client_id,
            'client secret': self.client_secret,
            'access token': self.access_token,
            'refresh token': self.refresh_token,
        }.items() if not value]
        if missing:
            raise ValueError(f"QuickBooks credentials missing: {', '.join(missing)}")
        base = str(data.get('base_url') or '').rstrip('/')
        if '/v3/company/' in base:
            self.base_url = base
        else:
            api_host = (
                'https://sandbox-quickbooks.api.intuit.com'
                if data.get('env') == 'sandbox'
                else 'https://quickbooks.api.intuit.com'
            )
            self.base_url = f"{api_host}/v3/company/{self.realm_id}"

    def _save_tokens(self, access_token: str, refresh_token: str):
        with open(self.secrets_path) as f:
            data = json.load(f)
        now = datetime.now(timezone.utc).isoformat()
        if data.get('tokens') is not None or data.get('production') is not None or data.get('realm_id') is not None:
            data.setdefault('tokens', {})['access_token'] = access_token
            data['tokens']['refresh_token'] = refresh_token
            data['tokens']['obtained_at'] = now
        else:
            data['access_token'] = access_token
            data['refresh_token'] = refresh_token
            data['updated_at'] = now
        tmp = self.secrets_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.secrets_path)
        os.chmod(self.secrets_path, 0o600)
        self.access_token = access_token
        self.refresh_token = refresh_token

    def refresh_auth(self) -> bool:
        """Refresh the OAuth2 token."""
        try:
            body = urllib.parse.urlencode({
                'grant_type': 'refresh_token',
                'refresh_token': self.refresh_token,
            }).encode()
            basic = base64.b64encode(
                f"{self.client_id}:{self.client_secret}".encode()
            ).decode()
            req = urllib.request.Request(
                "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
                data=body,
                headers={
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
            new_access = data.get('access_token')
            new_refresh = data.get('refresh_token')
            if new_access:
                self._save_tokens(new_access, new_refresh or self.refresh_token)
                return True
        except Exception as e:
            print(f"Token refresh failed: {e}")
        return False

    def _api_call(
        self,
        method: str,
        endpoint: str,
        body: dict = None,
        retry: bool = True,
        request_id: str = None,
    ) -> dict:
        """Make an authenticated API call to QBO."""
        separator = '&' if '?' in endpoint else '?'
        url = f"{self.base_url}/{endpoint}{separator}minorversion=75"
        if request_id:
            url += f"&requestid={urllib.parse.quote(str(request_id)[:50])}"
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Accept": "application/json",
        }

        data_bytes = None
        if body:
            headers["Content-Type"] = "application/json"
            data_bytes = json.dumps(body).encode()

        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                if self.refresh_auth():
                    return self._api_call(method, endpoint, body, retry=False, request_id=request_id)
            error_body = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"QBO API {e.code}: {error_body}")

    def query(self, sql: str) -> dict:
        """Run a QBO query."""
        import urllib.parse
        encoded = urllib.parse.quote(sql)
        return self._api_call("GET", f"query?query={encoded}")

    def create_purchase(self, txn: Dict, request_id: str = None) -> Dict:
        """
        Create a Purchase (Check/CashPurchase) in QBO for an expense transaction.

        Args:
            txn: classified transaction dict with keys:
                - date, amount_usd, category (QBO account key), vendor_key,
                - description, note, reference
        """
        receipt_items = txn.get('receipt_items') or []
        account_id = self._resolve_account_id(txn.get('category')) if not receipt_items else None
        vendor_id = self._resolve_vendor_id(txn.get('vendor_key'))
        amount_usd = txn.get('amount_usd', 0)
        txn_date = txn.get('date')

        if not receipt_items and not account_id:
            raise ValueError(f"No QBO account for category: {txn.get('category')}")
        if not amount_usd or amount_usd <= 0:
            raise ValueError(f"Invalid USD amount: {amount_usd}")

        # Build memo from description + note
        memo_parts = []
        if txn.get('note'):
            memo_parts.append(txn['note'])
        desc = txn.get('description', '')
        if desc and len(desc) < 200:
            memo_parts.append(f"Kapital: {desc[:150]}")
        if txn.get('reference'):
            memo_parts.append(f"Ref: {txn['reference'][:80]}")
        if txn.get('payment_reference'):
            memo_parts.append(f"Receipt ref: {txn['payment_reference']}")
        if txn.get('fx_rate'):
            memo_parts.append(f"FX: {txn['fx_rate']} MXN/USD, orig ${txn.get('amount', 0):,.2f} MXN")

        memo = ' | '.join(memo_parts)[:4000]  # QBO memo limit

        if receipt_items:
            allocations = allocate_receipt_item_usd(amount_usd, receipt_items)
            lines = []
            for item, line_amount in zip(receipt_items, allocations):
                line_account_id = self._resolve_account_id(item.get('category_key'))
                if not line_account_id:
                    raise ValueError(f"No QBO account for receipt category: {item.get('category_key')}")
                line_description = ' · '.join(part for part in [
                    f"Receipt {item.get('item_index')}",
                    item.get('vendor'),
                    item.get('description'),
                    f"MXN ${float(item.get('amount') or 0):,.2f}",
                    txn.get('payment_reference'),
                ] if part)
                lines.append({
                    "Amount": line_amount,
                    "DetailType": "AccountBasedExpenseLineDetail",
                    "AccountBasedExpenseLineDetail": {
                        "AccountRef": {"value": str(line_account_id)},
                    },
                    "Description": line_description[:4000],
                })
        else:
            lines = [{
                "Amount": round(amount_usd, 2),
                "DetailType": "AccountBasedExpenseLineDetail",
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": str(account_id)},
                },
                "Description": memo[:4000],
            }]

        purchase = {
            "PaymentType": "Cash",
            "AccountRef": {"value": "1150040001"},  # Kapital bank account
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "CurrencyRef": {"value": "USD"},
            "TotalAmt": round(amount_usd, 2),
            "PrivateNote": memo,
            "Line": lines,
        }

        # Add vendor if known
        if vendor_id:
            purchase["EntityRef"] = {"value": str(vendor_id), "type": "Vendor"}

        # SPEI fees are now pushed as separate records (not bundled)
        # to avoid 'split' display in QBO

        result = self._api_call("POST", "purchase", purchase, request_id=request_id)
        return result.get('Purchase', result)

    def create_spei_fee(self, fee: Dict, parent_txn: Dict, request_id: str = None) -> Dict:
        """
        Create a separate Purchase for a SPEI commission or IVA line.
        """
        bank_fee_id = self._resolve_account_id('bank_fee')
        if not bank_fee_id:
            raise ValueError("No QBO account for bank_fee")

        fee_usd = fee.get('amount_usd', 0) or 0
        if not fee_usd or fee_usd <= 0:
            return {}  # Skip zero fees

        txn_date = parent_txn.get('date')
        fee_type = 'SPEI IVA' if fee.get('is_spei_iva') else 'SPEI Commission'
        vendor_name = parent_txn.get('vendor_name', 'N/A')

        memo = f"{fee_type} on transfer to {vendor_name}"
        if parent_txn.get('reference'):
            memo += f" | Parent ref: {parent_txn['reference'][:100]}"
        if parent_txn.get('amount'):
            memo += f" | Parent orig ${float(parent_txn['amount']):,.2f} MXN"
        if parent_txn.get('fx_rate'):
            memo += f" | FX: {parent_txn['fx_rate']} MXN/USD, orig ${fee.get('amount', 0):,.2f} MXN"

        purchase = {
            "PaymentType": "Cash",
            "AccountRef": {"value": "1150040001"},
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "CurrencyRef": {"value": "USD"},
            "TotalAmt": round(fee_usd, 2),
            "EntityRef": {"value": "16", "type": "Vendor"},  # Kapital Mexico
            "PrivateNote": memo,
            "Line": [{
                "Amount": round(fee_usd, 2),
                "DetailType": "AccountBasedExpenseLineDetail",
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": str(bank_fee_id)},
                },
                "Description": memo,
            }],
        }

        result = self._api_call("POST", "purchase", purchase, request_id=request_id)
        return result.get('Purchase', result)

    def create_deposit(self, txn: Dict, request_id: str = None) -> Dict:
        """
        Create a Deposit in QBO for an income transaction.
        """
        amount_usd = txn.get('amount_usd', 0)
        txn_date = txn.get('date')
        category = txn.get('category', '')

        if not amount_usd or amount_usd <= 0:
            raise ValueError(f"Invalid USD amount: {amount_usd}")

        # Resolve income account
        income_account_id = self._resolve_income_account_id(category)
        if not income_account_id:
            raise ValueError(f"No QBO income account for category: {category}")

        memo_parts = []
        if txn.get('note'):
            memo_parts.append(txn['note'])
        desc = txn.get('description', '')
        if desc and len(desc) < 200:
            memo_parts.append(f"Kapital: {desc[:150]}")
        if txn.get('fx_rate'):
            memo_parts.append(f"FX: {txn['fx_rate']} MXN/USD, orig ${txn.get('amount', 0):,.2f} MXN")
        memo = ' | '.join(memo_parts)[:4000]

        deposit = {
            "DepositToAccountRef": {"value": "1150040001"},  # Kapital bank account
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "CurrencyRef": {"value": "USD"},
            "TotalAmt": round(amount_usd, 2),
            "PrivateNote": memo,
            "Line": [{
                "Amount": round(amount_usd, 2),
                "DetailType": "DepositLineDetail",
                "DepositLineDetail": {
                    "AccountRef": {"value": str(income_account_id)},
                },
                "Description": memo[:4000],
            }],
        }

        result = self._api_call("POST", "deposit", deposit, request_id=request_id)
        return result.get('Deposit', result)

    def create_transfer(self, txn: Dict, request_id: str = None) -> Dict:
        """
        Create a Transfer in QBO for owner funding or internal transfers.
        """
        amount_usd = txn.get('amount_usd', 0)
        txn_date = txn.get('date')

        if not amount_usd or amount_usd <= 0:
            raise ValueError(f"Invalid USD amount: {amount_usd}")

        memo_parts = []
        if txn.get('note'):
            memo_parts.append(txn['note'])
        if txn.get('fx_rate'):
            memo_parts.append(f"FX: {txn['fx_rate']} MXN/USD, orig ${txn.get('amount', 0):,.2f} MXN")
        memo = ' | '.join(memo_parts)[:4000]

        transfer = {
            "FromAccountRef": {"value": "9"},  # BofA checking
            "ToAccountRef": {"value": "1150040001"},  # Kapital
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "Amount": round(amount_usd, 2),
            "PrivateNote": memo,
        }

        result = self._api_call("POST", "transfer", transfer, request_id=request_id)
        return result.get('Transfer', result)

    def create_journal_entry(self, journal_entry: Dict, request_id: str = None) -> Dict:
        """Create a JournalEntry with a stable provider request id."""
        result = self._api_call(
            "POST", "journalentry", journal_entry, request_id=request_id
        )
        return result.get('JournalEntry', result)

    def create_purchase_payload(self, purchase: Dict, request_id: str = None) -> Dict:
        """Create a fully specified Purchase with a stable provider request id."""
        result = self._api_call("POST", "purchase", purchase, request_id=request_id)
        return result.get('Purchase', result)

    def read_entity(self, entity_type: str, entity_id: str) -> Dict:
        """Read a just-written entity back from QBO."""
        result = self._api_call("GET", f"{entity_type}/{entity_id}")
        key = {
            'purchase': 'Purchase',
            'deposit': 'Deposit',
            'transfer': 'Transfer',
            'journalentry': 'JournalEntry',
            'account': 'Account',
        }[entity_type]
        return result.get(key, result)

    def read_account(self, account_id: str) -> Dict:
        """Read a QBO account by id for a live posting preflight."""
        return self.read_entity('account', str(account_id))

    def _resolve_account_id(self, category_key: str) -> Optional[str]:
        """Look up QBO account ID from config category key."""
        if not category_key:
            return None
        config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            config = json.load(f)
        accounts = config.get('qbo_accounts', {}).get('expenses', {})
        account = accounts.get(category_key, {})
        return account.get('id') or DEFAULT_QBO_EXPENSE_ACCOUNTS.get(category_key)

    def _resolve_income_account_id(self, category_key: str) -> Optional[str]:
        """Look up QBO income account ID from config."""
        if not category_key:
            return None
        config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            config = json.load(f)
        income = config.get('qbo_accounts', {}).get('income', {})
        account = income.get(category_key, {})
        return account.get('id')

    def _resolve_vendor_id(self, vendor_key: str) -> Optional[str]:
        """Look up QBO vendor ID from config vendor key."""
        if not vendor_key:
            return None
        config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            config = json.load(f)
        vendors = config.get('vendors', {})
        vendor = vendors.get(vendor_key, {})
        return vendor.get('id')


def qbo_request_id(txn: Dict, record_type: str, suffix: str = '') -> str:
    """Stable, non-PII QBO requestid for a Kapital-derived write."""
    raw = '|'.join([
        'socialsol', record_type, str(txn.get('date') or ''),
        str(txn.get('reference') or txn.get('clave') or txn.get('description') or ''),
        str(txn.get('amount') or ''), str(txn.get('category') or ''), suffix,
    ])
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:36]
    return f"ss-{record_type[:3]}-{digest}"[:50]


def verify_receipt_purchase_readback(txn: Dict, purchase: Dict) -> None:
    """Verify a receipt bundle's total, reference, accounts, and split amounts."""
    items = txn.get('receipt_items') or []
    if not items:
        return
    expected_amounts = allocate_receipt_item_usd(txn.get('amount_usd'), items)
    expected_accounts = []
    config_path = str(Path(__file__).parent / 'config.json')
    with open(config_path) as config_file:
        accounts = json.load(config_file).get('qbo_accounts', {}).get('expenses', {})
    for item in items:
        account_id = accounts.get(item.get('category_key'), {}).get('id')
        if not account_id:
            raise RuntimeError(f"QBO receipt readback has no configured account for {item.get('category_key')}")
        expected_accounts.append(str(account_id))
    actual_lines = [line for line in purchase.get('Line', [])
                    if line.get('DetailType') == 'AccountBasedExpenseLineDetail']
    actual_amounts = [round(float(line.get('Amount') or 0), 2) for line in actual_lines]
    actual_accounts = [str(line.get('AccountBasedExpenseLineDetail', {}).get('AccountRef', {}).get('value') or '')
                       for line in actual_lines]
    if round(float(purchase.get('TotalAmt') or 0), 2) != round(float(txn.get('amount_usd') or 0), 2):
        raise RuntimeError('QBO receipt purchase total failed readback')
    if actual_amounts != expected_amounts or actual_accounts != expected_accounts:
        raise RuntimeError('QBO receipt purchase split lines failed readback')
    ledger_marker = txn.get('payment_reference') or txn.get('receipt_id')
    if not ledger_marker or str(ledger_marker) not in str(purchase.get('PrivateNote') or ''):
        raise RuntimeError('QBO receipt purchase ledger marker failed readback')


def _normalized_text(value: object) -> str:
    text = unicodedata.normalize('NFKD', str(value or ''))
    text = ''.join(char for char in text if not unicodedata.combining(char))
    return re.sub(r'[^A-Z0-9]+', ' ', text.upper()).strip()


def _transaction_label(txn: Dict) -> str:
    spei = txn.get('spei') or {}
    label = txn.get('note') or spei.get('concept') or txn.get('description') or 'Kapital transaction'
    # Do not propagate account numbers or long card/provider identifiers into
    # workflow summaries or Slack reconciliation responses.
    return re.sub(r'\b\d{10,}\b', '[redacted reference]', str(label)).strip()[:180]


def _transaction_detail(txn: Dict, *, status: str, bucket: str, qbo_id: str = None) -> Dict:
    category_key = txn.get('category')
    category_name = txn.get('category_name') or category_key
    if status == 'EXISTING' and not category_key:
        category_key = txn.get('original_category_key')
        category_name = txn.get('original_category_name') or category_key
    return {
        'date': str(txn.get('date') or ''),
        'amount': txn.get('amount'),
        'amount_usd': txn.get('amount_usd'),
        'currency': txn.get('currency') or 'MXN',
        'category_key': category_key,
        'category': category_name,
        'original_category_key': txn.get('_original_category_key') or txn.get('original_category_key'),
        'original_category': txn.get('_original_category_name') or txn.get('original_category_name'),
        'vendor': txn.get('vendor_name'),
        'label': _transaction_label(txn),
        'reference': txn.get('reference'),
        'payment_reference': txn.get('payment_reference'),
        'bucket': bucket,
        'status': status,
        'qbo_id': str(qbo_id) if qbo_id else None,
        'requires_review': bool(txn.get('_requires_review')),
        'review_reason': txn.get('_review_reason'),
    }


def _qbo_purchase_rows(query_qbo, sql: str) -> List[Dict]:
    data = query_qbo(sql)
    if not isinstance(data, dict) or not isinstance(data.get('QueryResponse'), dict):
        raise RuntimeError('QBO SPEI fee query returned no QueryResponse')
    rows = data['QueryResponse'].get('Purchase', [])
    if not isinstance(rows, list):
        raise RuntimeError('QBO SPEI fee query returned invalid Purchase rows')
    return rows


def _fee_kind(value: Dict) -> str:
    return 'iva' if value.get('is_spei_iva') else 'commission'


def find_missing_spei_fees(
    transactions: List[Dict],
    query_qbo,
) -> Tuple[List[Dict], List[Dict]]:
    """Match every expected SPEI fee line against live QBO as a multiset.

    New fee records carry their exact parent Clave. Older records did not, so
    the legacy fallback consumes one QBO line at a time by date, fee type,
    rounded USD amount, and transfer destination. This preserves same-day
    repeated Sergio fees without either collapsing or duplicating them.
    """
    expected = []
    for txn in transactions:
        for fee_index, fee in enumerate(txn.get('spei_fees') or []):
            if float(fee.get('amount_usd') or 0) > 0:
                expected.append({
                    'parent': txn,
                    'fee': fee,
                    'fee_index': fee_index,
                    'kind': _fee_kind(fee),
                })
    if not expected:
        return [], []

    dates = [str(item['parent'].get('date') or '') for item in expected]
    sql = (
        "SELECT Id, TxnDate, TotalAmt, PrivateNote FROM Purchase "
        f"WHERE TxnDate >= '{min(dates)}' AND TxnDate <= '{max(dates)}' MAXRESULTS 1000"
    )
    rows = _qbo_purchase_rows(query_qbo, sql)
    actual = []
    for row in rows:
        note = str(row.get('PrivateNote') or '')
        kind_match = re.search(r'\bSPEI\s+(Commission|IVA)\s+on transfer to\s+([^|]+)', note, re.IGNORECASE)
        if not kind_match:
            continue
        parent_match = re.search(r'\bParent ref:\s*([^|]+)', note, re.IGNORECASE)
        actual.append({
            'row': row,
            'kind': 'iva' if kind_match.group(1).lower() == 'iva' else 'commission',
            'destination': _normalized_text(kind_match.group(2)),
            'parent_reference': _normalized_text(parent_match.group(1)) if parent_match else '',
        })

    used = set()
    missing = []
    matched = []
    for item in expected:
        parent = item['parent']
        fee = item['fee']
        parent_reference = _normalized_text(parent.get('reference'))
        destination = _normalized_text(parent.get('vendor_name') or 'N/A')
        txn_date = str(parent.get('date') or '')
        amount_usd = round(float(fee.get('amount_usd') or 0), 2)

        exact_index = next((index for index, candidate in enumerate(actual)
            if index not in used
            and candidate['kind'] == item['kind']
            and parent_reference
            and candidate['parent_reference'] == parent_reference), None)
        legacy_index = exact_index if exact_index is not None else next((
            index for index, candidate in enumerate(actual)
            if index not in used
            and candidate['kind'] == item['kind']
            and str(candidate['row'].get('TxnDate') or '') == txn_date
            and round(float(candidate['row'].get('TotalAmt') or 0), 2) == amount_usd
            and candidate['destination'] == destination
        ), None)
        if legacy_index is None:
            missing.append(item)
            continue
        used.add(legacy_index)
        row = actual[legacy_index]['row']
        matched.append({
            'date': txn_date,
            'kind': item['kind'],
            'amount': fee.get('amount'),
            'amount_usd': amount_usd,
            'parent_reference': parent.get('reference'),
            'qbo_id': str(row.get('Id') or '') or None,
        })
    return missing, matched


def verify_spei_fee_readback(parent_txn: Dict, fee: Dict, purchase: Dict) -> None:
    expected = round(float(fee.get('amount_usd') or 0), 2)
    if round(float(purchase.get('TotalAmt') or 0), 2) != expected:
        raise RuntimeError('QBO SPEI fee total failed readback')
    reference = str(parent_txn.get('reference') or '').strip()
    if reference and reference not in str(purchase.get('PrivateNote') or ''):
        raise RuntimeError('QBO SPEI fee parent reference failed readback')


def push_classified_to_qbo(
    results: Dict[str, List[Dict]],
    push_auto: bool = True,
    push_guess: bool = False,
    record_unresolved: bool = False,
    dry_run: bool = True,
) -> Dict:
    """
    Push classified transactions to QBO.

    Args:
        results: output from classifier.classify_all()
        push_auto: push auto-classified expenses
        push_guess: push guess-classified expenses (only after Mayela confirms)
        record_unresolved: record unmatched debit guesses/unknowns in QBO's
            Uncategorized Expense account while preserving review metadata
        dry_run: if True, don't actually push

    Returns:
        Summary dict with counts and any errors
    """
    client = QBOClient()
    all_results = [txn for bucket in ('auto', 'guess', 'unknown') for txn in results.get(bucket, [])]
    debit_results = [txn for txn in all_results if str(txn.get('direction') or 'debit').lower() == 'debit']
    fee_amount_mxn = sum(
        float(fee.get('amount') or 0)
        for txn in debit_results for fee in (txn.get('spei_fees') or [])
    )
    dates = [str(txn.get('date')) for txn in all_results if txn.get('date')]
    summary = {
        'expenses_pushed': 0,
        'income_pushed': 0,
        'transfers_pushed': 0,
        'fee_records_pushed': 0,
        'fee_records_expected': 0,
        'fee_records_existing': 0,
        'fee_dedup_skipped': 0,
        'skipped': 0,
        'review_required': 0,
        'review_details': [],
        'held': 0,
        'held_details': [],
        'errors': [],
        'warnings': [],
        'details': [],
        'dedup_details': [],
        'fee_details': [],
        'statement': {
            'date_start': min(dates) if dates else None,
            'date_end': max(dates) if dates else None,
            'principal_count': len(all_results),
            'principal_debits_mxn': round(sum(float(txn.get('amount') or 0) for txn in debit_results), 2),
            'spei_fees_mxn': round(fee_amount_mxn, 2),
            'total_outflows_mxn': round(
                sum(float(txn.get('amount') or 0) for txn in debit_results) + fee_amount_mxn, 2
            ),
        },
    }

    # Categories that are internal transfers (not income, not expense)
    TRANSFER_CATS = ('owner_transfer', 'fx_conversion')
    # Categories that are income deposits
    INCOME_CATS = ('income_airbnb', 'income_direct', 'income_vrbo', 'bank_interest')
    # Skip these (they net to zero or are negligible)
    SKIP_CATS = ('income_other',)

    # Deduplicate every principal that may be recorded. Previously review
    # items were removed before this preflight, which falsely reported an
    # already-present exact-Clave payment as missing.
    from dedup import check_for_duplicates
    selected_buckets = []
    if push_auto:
        selected_buckets.append(('auto', list(results.get('auto', []))))
    if push_guess:
        selected_buckets.append(('guess', list(results.get('guess', []))))
    elif record_unresolved:
        selected_buckets.append(('guess', list(results.get('guess', []))))
    if record_unresolved:
        selected_buckets.append(('unknown', list(results.get('unknown', []))))

    selected_ids = set()
    all_txns = []
    bucket_by_id = {}
    for bucket_name, txns in selected_buckets:
        for txn in txns:
            if id(txn) in selected_ids:
                continue
            selected_ids.add(id(txn))
            all_txns.append(txn)
            bucket_by_id[id(txn)] = bucket_name

    for bucket_name in ('guess', 'unknown'):
        if (bucket_name == 'guess' and (push_guess or record_unresolved)) or (
            bucket_name == 'unknown' and record_unresolved
        ):
            continue
        for txn in results.get(bucket_name, []):
            summary['held_details'].append(_transaction_detail(
                txn, status='HELD', bucket=bucket_name
            ) | {'review_reason': txn.get('reason') or 'manual classification required'})

    try:
        # QBOClient.query refreshes a stale access token on 401. Query failures
        # propagate so the writer fails closed before creating any entity.
        new_txns, dupes = check_for_duplicates(all_txns, client.query)
        summary['dedup_skipped'] = len(dupes)
        if dupes:
            for d in dupes:
                summary['warnings'].append(
                    f"DEDUP SKIP: {d.get('date')} ${d.get('amount_usd', 0):.2f} — {d.get('_dedup_reason', 'duplicate')}"
                )
                summary['dedup_details'].append(_transaction_detail(
                    d,
                    status='EXISTING',
                    bucket=bucket_by_id.get(id(d), 'auto'),
                    qbo_id=d.get('_dedup_qbo_id'),
                ) | {
                    'qbo_entity_type': d.get('_dedup_entity_type'),
                    'dedup_reason': d.get('_dedup_reason'),
                })

        # Rebuild bucket lists with only genuinely new transactions. Review
        # debits are copied into Uncategorized Expense, never into a guessed
        # category; unresolved credits remain held.
        new_set = set(id(t) for t in new_txns)
        buckets_to_push = []
        if push_auto:
            buckets_to_push.append(('auto', [t for t in results.get('auto', []) if id(t) in new_set]))
        if push_guess:
            buckets_to_push.append(('guess', [t for t in results.get('guess', []) if id(t) in new_set]))
        if record_unresolved:
            review_txns = []
            review_sources = [] if push_guess else list(results.get('guess', []))
            review_sources.extend(results.get('unknown', []))
            for txn in review_sources:
                if id(txn) not in new_set:
                    continue
                if str(txn.get('direction') or 'debit').lower() != 'debit':
                    summary['held_details'].append(_transaction_detail(
                        txn, status='HELD', bucket=bucket_by_id.get(id(txn), 'unknown')
                    ) | {'review_reason': 'Unresolved credits require an income-account review before posting'})
                    continue
                prepared = dict(txn)
                prepared['_original_category_key'] = txn.get('category') or txn.get('original_category_key')
                prepared['_original_category_name'] = txn.get('category_name') or txn.get('original_category_name')
                prepared['_requires_review'] = True
                prepared['_review_reason'] = (
                    'Distinct Kapital debit was not found in QBO, but no receipt reference identifies its expense split; category review required'
                    if txn.get('possible_duplicate_payment_reference')
                    else txn.get('reason') or 'manual classification required'
                )
                prepared['category'] = 'uncategorized_expense'
                prepared['category_name'] = 'Uncategorized Expense'
                suggested = prepared.get('_original_category_name') or prepared.get('_original_category_key') or 'none'
                prepared['note'] = (
                    f"REVIEW REQUIRED: unresolved Kapital debit recorded to Uncategorized Expense; "
                    f"suggested category: {suggested}; reason: {prepared['_review_reason']}"
                )
                review_txns.append(prepared)
            if review_txns:
                buckets_to_push.append(('review', review_txns))

        # Reconcile SPEI fees independently from the principal. A principal
        # can already exist while one or both bank-fee lines are still absent.
        missing_fees, existing_fees = find_missing_spei_fees(all_txns, client.query)
        summary['fee_records_expected'] = len(missing_fees) + len(existing_fees)
        summary['fee_records_existing'] = len(existing_fees)
        summary['fee_dedup_skipped'] = len(existing_fees)
        summary['fee_details'].extend({**item, 'status': 'EXISTING'} for item in existing_fees)
    except Exception as e:
        # A failed duplicate check makes a live retry unsafe. Fail closed
        # before creating any QBO entity.
        raise RuntimeError(f"QBO dedup preflight failed; no writes attempted: {e}") from e

    for bucket_name, txns in buckets_to_push:
        for txn in txns:
            category = txn.get('category', '')

            # Skip if no USD amount
            if not txn.get('amount_usd'):
                summary['skipped'] += 1
                if txn.get('amount', 0) > 0.05:  # Only log meaningful skips
                    summary['errors'].append(f"No USD amount for {txn.get('date')} {txn.get('description', '')[:40]}")
                summary['held_details'].append(_transaction_detail(
                    txn, status='HELD', bucket=bucket_name
                ) | {'review_reason': 'No verified USD conversion was available'})
                continue

            # Skip bank fee credits (fiscal stamp discount — $0.01, nets to zero)
            if category == 'bank_fee' and txn.get('category_name', '').endswith('(credit)'):
                summary['skipped'] += 1
                continue

            # Skip unknown income
            if category in SKIP_CATS:
                summary['skipped'] += 1
                summary['held_details'].append(_transaction_detail(
                    txn, status='HELD', bucket=bucket_name
                ) | {'review_reason': f'Category {category} is not configured for autonomous posting'})
                continue

            # Determine record type
            if category in TRANSFER_CATS:
                record_type = 'transfer'
            elif category in INCOME_CATS:
                record_type = 'deposit'
            else:
                record_type = 'expense'

            if dry_run:
                key = f'{record_type}s_pushed' if record_type != 'expense' else 'expenses_pushed'
                summary[key] = summary.get(key, 0) + 1
                summary['details'].append({
                    'date': str(txn.get('date')),
                    'amount': txn.get('amount'),
                    'amount_usd': txn.get('amount_usd'),
                    'currency': txn.get('currency') or 'MXN',
                    'category_key': txn.get('category'),
                    'category': txn.get('category_name'),
                    'original_category_key': txn.get('_original_category_key'),
                    'original_category': txn.get('_original_category_name'),
                    'vendor': txn.get('vendor_name'),
                    'label': _transaction_label(txn),
                    'reference': txn.get('reference'),
                    'record_type': record_type,
                    'bucket': bucket_name,
                    'status': 'DRY_RUN',
                    'requires_review': bool(txn.get('_requires_review')),
                    'review_reason': txn.get('_review_reason'),
                    'receipt_id': txn.get('receipt_id'),
                    'payment_reference': txn.get('payment_reference'),
                    'receipt_item_count': len(txn.get('receipt_items') or []),
                })
                if txn.get('_requires_review'):
                    summary['review_details'].append(_transaction_detail(
                        txn, status='DRY_RUN', bucket=bucket_name
                    ))
                continue

            try:
                request_id = qbo_request_id(txn, record_type)
                if record_type == 'transfer':
                    result = client.create_transfer(txn, request_id=request_id)
                    qbo_id = result.get('Id', 'unknown')
                    summary['transfers_pushed'] += 1
                elif record_type == 'deposit':
                    result = client.create_deposit(txn, request_id=request_id)
                    qbo_id = result.get('Id', 'unknown')
                    summary['income_pushed'] += 1
                else:
                    result = client.create_purchase(txn, request_id=request_id)
                    qbo_id = result.get('Id', 'unknown')
                    summary['expenses_pushed'] += 1

                if not qbo_id or qbo_id == 'unknown':
                    raise RuntimeError('QBO create returned no entity Id')
                entity_type = 'purchase' if record_type == 'expense' else record_type
                readback = client.read_entity(entity_type, qbo_id)
                if str(readback.get('Id')) != str(qbo_id):
                    raise RuntimeError(f"QBO {record_type} readback mismatch for {qbo_id}")
                if record_type == 'expense':
                    verify_receipt_purchase_readback(txn, readback)

                summary['details'].append({
                    'date': str(txn.get('date')),
                    'amount': txn.get('amount'),
                    'amount_usd': txn.get('amount_usd'),
                    'currency': txn.get('currency') or 'MXN',
                    'category_key': txn.get('category'),
                    'category': txn.get('category_name'),
                    'original_category_key': txn.get('_original_category_key'),
                    'original_category': txn.get('_original_category_name'),
                    'vendor': txn.get('vendor_name'),
                    'label': _transaction_label(txn),
                    'reference': txn.get('reference'),
                    'qbo_id': qbo_id,
                    'request_id': request_id,
                    'verified_by_readback': True,
                    'record_type': record_type,
                    'bucket': bucket_name,
                    'status': 'PUSHED',
                    'requires_review': bool(txn.get('_requires_review')),
                    'review_reason': txn.get('_review_reason'),
                    'receipt_id': txn.get('receipt_id'),
                    'payment_reference': txn.get('payment_reference'),
                    'receipt_item_count': len(txn.get('receipt_items') or []),
                })
                if txn.get('_requires_review'):
                    summary['review_details'].append(_transaction_detail(
                        txn, status='PUSHED', bucket=bucket_name, qbo_id=qbo_id
                    ))
            except Exception as e:
                summary['errors'].append(f"{txn.get('date')} ${txn.get('amount_usd')} ({record_type}): {e}")

    # Fee writes occur only after every duplicate and missing fee has been
    # established by live preflight. They are independent of principal dedup.
    for item in missing_fees:
        parent = item['parent']
        fee = item['fee']
        fee_index = item['fee_index']
        detail = {
            'date': str(parent.get('date') or ''),
            'kind': item['kind'],
            'amount': fee.get('amount'),
            'amount_usd': fee.get('amount_usd'),
            'parent_reference': parent.get('reference'),
        }
        if dry_run:
            summary['expenses_pushed'] += 1
            summary['fee_records_pushed'] += 1
            summary['fee_details'].append({**detail, 'status': 'DRY_RUN'})
            continue
        try:
            request_id = qbo_request_id(parent, 'purchase', f"spei-{fee_index}")
            fee_result = client.create_spei_fee(fee, parent, request_id=request_id)
            fee_id = fee_result.get('Id')
            if not fee_id:
                raise RuntimeError('QBO SPEI fee create returned no Id')
            fee_readback = client.read_entity('purchase', fee_id)
            if str(fee_readback.get('Id')) != str(fee_id):
                raise RuntimeError(f'QBO SPEI fee readback mismatch for {fee_id}')
            verify_spei_fee_readback(parent, fee, fee_readback)
            summary['expenses_pushed'] += 1
            summary['fee_records_pushed'] += 1
            summary['fee_details'].append({
                **detail,
                'status': 'PUSHED',
                'qbo_id': str(fee_id),
                'request_id': request_id,
                'verified_by_readback': True,
            })
        except Exception as error:
            summary['errors'].append(f"SPEI fee for {parent.get('date')}: {error}")

    summary['review_required'] = len(summary['review_details'])
    summary['held'] = len(summary['held_details'])
    summary['principal_written'] = len([
        row for row in summary['details'] if row.get('status') in ('PUSHED', 'DRY_RUN')
    ])
    summary['principal_recorded'] = summary['principal_written'] + summary.get('dedup_skipped', 0)
    summary['fee_records_recorded'] = summary['fee_records_pushed'] + summary['fee_records_existing']
    summary['principal_details'] = [*summary['dedup_details'], *summary['details']]
    category_totals = {}
    for row in summary['principal_details']:
        category = row.get('category') or row.get('category_key') or 'Unclassified'
        aggregate = category_totals.setdefault(category, {
            'category': category,
            'transactions': 0,
            'amount_mxn': 0.0,
        })
        aggregate['transactions'] += 1
        aggregate['amount_mxn'] += float(row.get('amount') or 0)
    summary['category_totals'] = [
        {**value, 'amount_mxn': round(value['amount_mxn'], 2)}
        for value in sorted(category_totals.values(), key=lambda value: (-value['amount_mxn'], value['category']))
    ]
    summary['complete'] = (
        summary['held'] == 0
        and summary['principal_recorded'] == summary['statement']['principal_count']
        and summary['fee_records_recorded'] == summary['fee_records_expected']
        and not summary['errors']
    )

    return summary


if __name__ == '__main__':
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from kapital_parser import parse_kapital_csv
    from classifier import KapitalClassifier
    from fx_rates import get_usd_rate, convert_mxn_to_usd
    from receipt_ledger import apply_receipt_ledger

    if len(sys.argv) < 2:
        print("Usage: python qbo_push.py <csv_file> [--receipt-db crm.db] [--record-unresolved] [--live] [--json]")
        sys.exit(1)

    csv_path = sys.argv[1]
    is_live = '--live' in sys.argv
    output_json = '--json' in sys.argv
    record_unresolved = '--record-unresolved' in sys.argv
    receipt_db = None
    if '--receipt-db' in sys.argv:
        receipt_db_index = sys.argv.index('--receipt-db')
        if receipt_db_index + 1 >= len(sys.argv):
            raise ValueError('--receipt-db requires a path')
        receipt_db = sys.argv[receipt_db_index + 1]

    meta, txns = parse_kapital_csv(csv_path)
    classifier = KapitalClassifier()
    results = classifier.classify_all(txns)

    # Add FX
    for bucket in results.values():
        for txn in bucket:
            if txn.get('date'):
                try:
                    rate = get_usd_rate(txn['date'])
                    txn['fx_rate'] = rate
                    txn['amount_usd'] = convert_mxn_to_usd(txn['amount'], txn['date'])
                    if txn.get('spei_fees'):
                        for fee in txn['spei_fees']:
                            fee['amount_usd'] = convert_mxn_to_usd(fee['amount'], txn['date'])
                except Exception:
                    txn['amount_usd'] = None

    if receipt_db:
        results = apply_receipt_ledger(results, receipt_db)

    dry_run = not is_live
    summary = push_classified_to_qbo(
        results,
        push_auto=True,
        push_guess=False,
        record_unresolved=record_unresolved,
        dry_run=dry_run,
    )
    summary['source_file_hash'] = hashlib.sha256(Path(csv_path).read_bytes()).hexdigest()

    if output_json:
        print(json.dumps(summary, default=str))
    else:
        mode = "LIVE" if is_live else "DRY RUN"
        print(f"\n{'='*50}")
        print(f"QBO Push ({mode})")
        print(f"  Expenses: {summary['expenses_pushed']}")
        print(f"  Income/Deposits: {summary['income_pushed']}")
        print(f"  Transfers: {summary['transfers_pushed']}")
        print(f"  Skipped: {summary['skipped']}")
        if summary['errors']:
            print(f"  Errors ({len(summary['errors'])}):")
            for err in summary['errors']:
                print(f"    - {err}")

        if summary['details']:
            print(f"\n  Transactions:")
            for d in summary['details']:
                vendor = d.get('vendor') or 'N/A'
                rtype = d.get('record_type', 'expense')[0].upper()
                print(f"    {d['date']} | {rtype} | ${d['amount_usd']:>8.2f} USD | {d['category']:<25} | {vendor:<20} | {d['status']}")

    if is_live and summary['errors']:
        sys.exit(1)
